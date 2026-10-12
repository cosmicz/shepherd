import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import { loadSnapshot, normalizeHost, refreshFeeds } from '../tools/threat-intel/threat-intel.mjs';

const execFile = promisify(execFileCallback);

const feeds = [
  { category: 'malware', url: 'https://feeds.example/malware.txt' },
  { category: 'phishing', url: 'https://feeds.example/phishing.txt' },
] as const;

async function directory(t: test.TestContext) {
  const path = await mkdtemp(join(tmpdir(), 'shepherd-threat-intel-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

function fetchFor(body: Record<string, string>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input);
    return new Response(body[url] ?? '', { status: body[url] === undefined ? 404 : 200 });
  }) as typeof fetch;
}

test('normalizes only canonical exact hosts', () => {
  assert.equal(normalizeHost('MiXeD.Example.'), 'mixed.example');
  assert.equal(normalizeHost('bücher.example'), 'xn--bcher-kva.example');
  assert.equal(normalizeHost('https://listed.example@evil.example/path'), undefined);
  assert.equal(normalizeHost('listed.example/path'), undefined);
  assert.equal(normalizeHost('not a host'), undefined);
});

test('refresh records a pinned receipt and leaves the prior active snapshot after bad feeds', async (t) => {
  const storage = await directory(t);
  const revisionUrl = 'https://api.example/revision';
  const licenseUrl = 'https://feeds.example/LICENSE';
  const first = await refreshFeeds({ storage, feeds, revisionUrl, licenseUrl, fetchImpl: fetchFor({
    [revisionUrl]: JSON.stringify({ sha: 'abc123' }), [licenseUrl]: 'Unlicense',
    'https://feeds.example/malware.txt': '# comment\n0.0.0.0 malware.example\n',
    'https://feeds.example/phishing.txt': '127.0.0.1 phish.example\n',
  }) });
  assert.equal(first.revision, 'abc123');
  assert.deepEqual(first.feeds.map((feed) => [feed.category, feed.accepted, feed.rejected]), [['malware', 1, 0], ['phishing', 1, 0]]);

  await assert.rejects(refreshFeeds({ storage, feeds, revisionUrl, licenseUrl, fetchImpl: fetchFor({
    [revisionUrl]: JSON.stringify({ sha: 'def456' }), [licenseUrl]: 'Unlicense',
    'https://feeds.example/malware.txt': '', 'https://feeds.example/phishing.txt': '',
  }) }), /empty|valid/i);
  await assert.rejects(refreshFeeds({ storage, feeds, revisionUrl, licenseUrl, maxBytes: 8, fetchImpl: fetchFor({
    [revisionUrl]: JSON.stringify({ sha: 'def456' }), [licenseUrl]: 'Unlicense',
    'https://feeds.example/malware.txt': '0.0.0.0 too-large.example', 'https://feeds.example/phishing.txt': 'phish.example',
  }) }), /byte limit/i);
  await assert.rejects(refreshFeeds({ storage, feeds, revisionUrl, licenseUrl, fetchImpl: fetchFor({
    [revisionUrl]: JSON.stringify({ sha: 'def456' }), [licenseUrl]: 'Unlicense',
    'https://feeds.example/malware.txt': 'not a host', 'https://feeds.example/phishing.txt': 'also invalid',
  }) }), /valid/i);
  const active = await loadSnapshot(storage);
  assert.equal(active.status, 'fresh');
  assert.equal(active.manifest.revision, 'abc123');
  assert.equal((await loadSnapshot(storage, { now: Date.parse(first.retrieved_at) + 8 * 24 * 60 * 60 * 1000 })).status, 'stale');
});

test('reports a missing snapshot explicitly', async (t) => {
  assert.deepEqual(await loadSnapshot(await directory(t)), { status: 'missing' });
});

test('offline JSONL tagging is exact, idempotent, and never treats body text as visited-host evidence', async (t) => {
  const storage = await directory(t);
  const revisionUrl = 'https://api.example/revision';
  const licenseUrl = 'https://feeds.example/LICENSE';
  await refreshFeeds({ storage, feeds, revisionUrl, licenseUrl, fetchImpl: fetchFor({
    [revisionUrl]: JSON.stringify({ sha: 'abc123' }), [licenseUrl]: 'Unlicense',
    'https://feeds.example/malware.txt': 'bad.example\nxn--bcher-kva.example\n',
    'https://feeds.example/phishing.txt': 'phish.example\n',
  }) });
  const input = join(storage, 'input.jsonl');
  const output = join(storage, 'output.jsonl');
  await writeFile(input, [
    JSON.stringify({ id: 'hit', url: { value: 'https://BAD.example./login', provenance: 'native_metadata' }, text: 'original stays' }),
    JSON.stringify({ id: 'suffix', url: { value: 'https://notbad.example', provenance: 'native_metadata' } }),
    JSON.stringify({ id: 'subdomain', url: { value: 'https://child.bad.example', provenance: 'native_metadata' } }),
    JSON.stringify({ id: 'userinfo', url: { value: 'https://bad.example@evil.example', provenance: 'native_metadata' } }),
    JSON.stringify({ id: 'body-only', text: 'visit https://bad.example' }),
    JSON.stringify({ id: 'idna', url: { value: 'https://bücher.example', provenance: 'native_metadata' } }),
  ].join('\n') + '\n');

  await execFile(process.execPath, ['tools/threat-intel/cli.mjs', 'tag', '--store-dir', storage, '--input', input, '--output', output]);
  const first = (await readFile(output, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(first[0].text, 'original stays');
  assert.equal(first[0].threat_intel.status, 'matched');
  assert.deepEqual(first[0].threat_intel.indicators.map((item: { categories: string[] }) => item.categories), [['malware']]);
  for (const record of first.slice(1, 5)) assert.equal(record.threat_intel.status, 'no_match');
  assert.equal(first[5].threat_intel.status, 'matched');
  assert.match(first[0].threat_intel.disclaimer, /indicator only/i);

  const again = join(storage, 'again.jsonl');
  await execFile(process.execPath, ['tools/threat-intel/cli.mjs', 'tag', '--store-dir', storage, '--input', output, '--output', again]);
  assert.equal(await readFile(again, 'utf8'), await readFile(output, 'utf8'));
});
