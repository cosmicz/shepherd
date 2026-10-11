import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const sourceURL = new URL('./main.swift', import.meta.url);

test('FrameLine CodingKeys serializes the required change or interval reason', async () => {
  const source = await readFile(fileURLToPath(sourceURL), 'utf8');
  const frameLine = source.match(/private struct FrameLine: Encodable \{([\s\S]*?)\n\}/)?.[1];
  assert.ok(frameLine, 'FrameLine must exist');
  assert.match(frameLine, /let reason: String/);
  assert.match(frameLine, /enum CodingKeys[\s\S]*?case reason/);
});
