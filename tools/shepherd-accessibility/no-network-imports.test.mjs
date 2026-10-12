import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('accessibility helper uses Apple accessibility frameworks and no network API', async () => {
  const source = await readFile(new URL('./main.swift', import.meta.url), 'utf8');
  assert.match(source, /import ApplicationServices/);
  assert.match(source, /kAXFocusedWindowAttribute/);
  assert.match(source, /var depth = 12/);
  assert.match(source, /var maxNodes = 2_000/);
  assert.match(source, /AXObserverCreate/);
  assert.match(source, /AXObserverAddNotification/);
  assert.match(source, /--exclude-nonce/);
  assert.doesNotMatch(source, /\b(?:Network|CFNetwork|URLSession|ScreenCaptureKit|Vision)\b/);
});
