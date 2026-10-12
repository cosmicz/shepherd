import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const sourceURL = new URL('./main.swift', import.meta.url);

test('FrameLine serializes dual text observations and no image data', async () => {
  const source = await readFile(fileURLToPath(sourceURL), 'utf8');
  const frameLine = source.match(/private struct FrameLine: Encodable \{([\s\S]*?)\n\}/)?.[1];
  assert.ok(frameLine, 'FrameLine must exist');
  assert.match(frameLine, /let windowText: String/);
  assert.match(frameLine, /let windowLines: \[TextLine\]/);
  assert.match(frameLine, /let windowWidth: Int/);
  assert.match(frameLine, /let windowHeight: Int/);
  assert.match(frameLine, /let displayText: String/);
  assert.match(frameLine, /let displayLines: \[TextLine\]/);
  assert.match(frameLine, /let displayWidth: Int/);
  assert.match(frameLine, /let displayHeight: Int/);
  assert.match(frameLine, /let reason: String/);
  assert.match(frameLine, /case windowText = "window_text"/);
  assert.match(frameLine, /case windowLines = "window_lines"/);
  assert.match(frameLine, /case displayText = "display_text"/);
  assert.match(frameLine, /case displayLines = "display_lines"/);
  assert.match(frameLine, /case reason/);
  assert.doesNotMatch(frameLine, /(?:CGImage|image|png|pixel)/i);
});

test('crop output is opt-in and requires an explicit caller path', async () => {
  const source = await readFile(fileURLToPath(sourceURL), 'utf8');
  assert.match(source, /case "--crop"/);
  assert.match(source, /case "--crop-output"/);
  assert.match(source, /--crop requires --crop-output/);
  assert.match(source, /--crop-output requires --crop/);
  assert.match(source, /try writeCrop\(from: displayImage\)/);
});
