import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const sourceURL = new URL('./main.swift', import.meta.url);
const forbiddenNetworkSymbols = /\b(?:Network|CFNetwork|URLSession|Combine)\b/;

test('native helper source contains no network API or framework reference', async () => {
  const source = await readFile(fileURLToPath(sourceURL), 'utf8');
  assert.doesNotMatch(source, forbiddenNetworkSymbols);
});
