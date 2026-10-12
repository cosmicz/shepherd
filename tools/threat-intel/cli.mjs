#!/usr/bin/env node
import { isAbsolute } from 'node:path';

import { refreshFeeds, tagJsonl } from './threat-intel.mjs';

const REVISION_URL = 'https://api.github.com/repos/blocklistproject/Lists/commits/main';
const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};
const storage = option('--store-dir');
if (!storage || !isAbsolute(storage)) throw new Error('--store-dir must be an absolute private directory outside the checkout');

if (args[0] === 'refresh') {
  const revisionResponse = await fetch(REVISION_URL, { redirect: 'error', signal: AbortSignal.timeout(10_000) });
  if (!revisionResponse.ok) throw new Error(`revision HTTP ${revisionResponse.status}`);
  const revision = (await revisionResponse.json())?.sha;
  if (typeof revision !== 'string' || !/^[a-f0-9]{6,64}$/i.test(revision)) throw new Error('revision metadata is malformed');
  const root = `https://raw.githubusercontent.com/blocklistproject/Lists/${revision}`;
  const manifest = await refreshFeeds({ storage, revisionUrl: REVISION_URL, licenseUrl: `${root}/LICENSE`, feeds: [
    { category: 'malware', url: `${root}/malware.txt` },
    { category: 'phishing', url: `${root}/phishing.txt` },
  ] });
  process.stdout.write(`${JSON.stringify({ source: manifest.source, revision: manifest.revision, retrieved_at: manifest.retrieved_at, feeds: manifest.feeds.map(({ category, sha256, bytes, accepted, rejected }) => ({ category, sha256, bytes, accepted, rejected })) })}\n`);
} else if (args[0] === 'tag') {
  const input = option('--input');
  const output = option('--output');
  if (!input || !output || !isAbsolute(input) || !isAbsolute(output)) throw new Error('tag requires absolute --input and --output paths');
  process.stdout.write(`${JSON.stringify(await tagJsonl({ storage, input, output }))}\n`);
} else {
  throw new Error('usage: cli.mjs refresh --store-dir ABSOLUTE_DIR | tag --store-dir ABSOLUTE_DIR --input ABSOLUTE_JSONL --output ABSOLUTE_JSONL');
}
