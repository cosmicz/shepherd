import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const MAX_FEED_BYTES = 128 * 1024 * 1024;
const MAX_LICENSE_BYTES = 256 * 1024;
const MAX_METADATA_BYTES = 64 * 1024;
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const text = (bytes) => new TextDecoder('utf-8', { fatal: true }).decode(bytes);

async function readLimited(response, limit) {
  if (!response.ok) throw new Error(`feed HTTP ${response.status}`);
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) throw new RangeError('feed exceeds byte limit');
  if (!response.body) throw new Error('feed response has no body');
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const item = await reader.read();
    if (item.done) break;
    total += item.value.byteLength;
    if (total > limit) { await reader.cancel(); throw new RangeError('feed exceeds byte limit'); }
    chunks.push(item.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

async function fetchText(url, { fetchImpl, signal, limit }) {
  return text(await readLimited(await fetchImpl(url, { signal, redirect: 'error' }), limit));
}

async function atomicWrite(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, value, { mode: 0o600 });
  await rename(temporary, path);
}

/** Returns a canonical bare hostname, never a path, port, credential or URL. */
export function normalizeHost(value) {
  if (typeof value !== 'string') return undefined;
  const candidate = value.trim();
  if (!candidate || /[\s/@:]/.test(candidate)) return undefined;
  try {
    const parsed = new URL(`http://${candidate}`);
    if (parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.port || parsed.username || parsed.password) return undefined;
    const host = parsed.hostname.toLowerCase().replace(/\.+$/, '');
    return host && host.includes('.') ? host : undefined;
  } catch { return undefined; }
}

function hostFromNativeUrl(value) {
  if (!value || typeof value !== 'object' || value.provenance !== 'native_metadata' || typeof value.value !== 'string') return undefined;
  try {
    const parsed = new URL(value.value);
    if (!['http:', 'https:'].includes(parsed.protocol)) return undefined;
    return parsed.hostname.toLowerCase().replace(/\.+$/, '') || undefined;
  } catch { return undefined; }
}

function parseFeed(content) {
  const hosts = new Set();
  let rejected = 0;
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim().replace(/^(?:0\.0\.0\.0|127\.0\.0\.1)\s+/, '').replace(/\s+#.*$/, '');
    if (!line || line.startsWith('#')) continue;
    const host = normalizeHost(line);
    if (!host) { rejected += 1; continue; }
    hosts.add(host);
  }
  if (!hosts.size) throw new Error('feed contains no valid host entries');
  return { hosts: [...hosts].sort(), rejected };
}

function freshness(retrievedAt, now, maxAgeMs) {
  return now - Date.parse(retrievedAt) > maxAgeMs ? 'stale' : 'fresh';
}

/** Fetches the two explicitly configured upstream feeds, then atomically activates a private snapshot. */
export async function refreshFeeds({ storage, feeds, revisionUrl, licenseUrl, fetchImpl = fetch, now = new Date(), timeoutMs = 10_000, maxBytes = MAX_FEED_BYTES }) {
  if (!Array.isArray(feeds) || feeds.length !== 2 || !feeds.every((feed) => ['malware', 'phishing'].includes(feed.category) && typeof feed.url === 'string')) throw new TypeError('configured malware and phishing feeds are required');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException('threat feed deadline exceeded', 'TimeoutError')), timeoutMs);
  try {
    const revisionText = await fetchText(revisionUrl, { fetchImpl, signal: controller.signal, limit: MAX_METADATA_BYTES });
    const revision = JSON.parse(revisionText)?.sha;
    if (typeof revision !== 'string' || !/^[a-f0-9]{6,64}$/i.test(revision)) throw new Error('revision metadata is malformed');
    const licenseText = await fetchText(licenseUrl, { fetchImpl, signal: controller.signal, limit: MAX_LICENSE_BYTES });
    if (!licenseText.trim()) throw new Error('license is empty');
    const received = await Promise.all(feeds.map(async (feed) => {
      const content = await fetchText(feed.url, { fetchImpl, signal: controller.signal, limit: maxBytes });
      const parsed = parseFeed(content);
      return { ...feed, content, ...parsed };
    }));
    const retrieved_at = now.toISOString();
    const snapshotId = `${revision.slice(0, 12)}-${randomUUID()}`;
    const staged = join(storage, 'snapshots', `.staging-${snapshotId}`);
    const active = join(storage, 'snapshots', snapshotId);
    await mkdir(staged, { recursive: true, mode: 0o700 });
    const receiptFeeds = [];
    for (const feed of received) {
      const filename = `${feed.category}.txt`;
      await writeFile(join(staged, filename), feed.content, { mode: 0o600 });
      receiptFeeds.push({ category: feed.category, source_url: feed.url, file: filename, sha256: sha256(feed.content), bytes: Buffer.byteLength(feed.content), accepted: feed.hosts.length, rejected: feed.rejected, hosts: feed.hosts });
    }
    await writeFile(join(staged, 'LICENSE.txt'), licenseText, { mode: 0o600 });
    await rename(staged, active);
    const manifest = { version: 1, source: 'blocklistproject/Lists', revision, revision_url: revisionUrl, license_url: licenseUrl, license_sha256: sha256(licenseText), license_text: licenseText, retrieved_at, snapshot_id: snapshotId, feeds: receiptFeeds };
    await atomicWrite(join(storage, 'current.v1.json'), JSON.stringify(manifest));
    return manifest;
  } finally { clearTimeout(timer); }
}

/** Returns an explicit missing/stale/ready status without network activity. */
export async function loadSnapshot(storage, { now = Date.now(), maxAgeMs = 7 * 24 * 60 * 60 * 1000 } = {}) {
  let manifest;
  try { manifest = JSON.parse(await readFile(join(storage, 'current.v1.json'), 'utf8')); }
  catch { return { status: 'missing' }; }
  if (!manifest || manifest.version !== 1 || !Array.isArray(manifest.feeds)) return { status: 'unavailable' };
  const index = new Map();
  for (const feed of manifest.feeds) {
    if (!feed || typeof feed.category !== 'string' || !Array.isArray(feed.hosts)) return { status: 'unavailable' };
    for (const host of feed.hosts) {
      const categories = index.get(host) ?? [];
      if (!categories.includes(feed.category)) categories.push(feed.category);
      index.set(host, categories);
    }
  }
  return { status: freshness(manifest.retrieved_at, now, maxAgeMs), manifest, index };
}

function enrich(record, snapshot) {
  const original = { ...record };
  delete original.threat_intel;
  const host = hostFromNativeUrl(record.url);
  const categories = host ? snapshot.index.get(host) : undefined;
  const base = { version: 1, source: snapshot.manifest.source, snapshot_sha256: sha256(JSON.stringify(snapshot.manifest)), retrieved_at: snapshot.manifest.retrieved_at, freshness: snapshot.status, disclaimer: 'Listed by feed; indicator only. No match does not mean safe.' };
  return { ...original, threat_intel: categories ? { ...base, status: 'matched', indicators: [{ host, categories: [...categories], match_kind: 'exact_host' }] } : { ...base, status: 'no_match', indicators: [] } };
}

/** Tags JSONL records using a local snapshot only; no fetch or DNS is performed. */
export async function tagJsonl({ storage, input, output, now, maxAgeMs }) {
  const snapshot = await loadSnapshot(storage, { now, maxAgeMs });
  if (snapshot.status === 'missing' || snapshot.status === 'unavailable') throw new Error(`snapshot is ${snapshot.status}`);
  const lines = (await readFile(input, 'utf8')).split(/\r?\n/).filter(Boolean);
  const records = lines.map((line) => {
    const record = JSON.parse(line);
    if (!record || typeof record !== 'object' || Array.isArray(record) || typeof record.id !== 'string') throw new Error('JSONL record must be an object with id');
    return enrich(record, snapshot);
  });
  await atomicWrite(output, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
  return { records: records.length, freshness: snapshot.status };
}

export async function removePrivateStore(storage) {
  await rm(storage, { recursive: true, force: true });
}
