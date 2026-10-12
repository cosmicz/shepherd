import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('banner is an AppKit-only, non-activating local helper', async () => {
  const source = await readFile(new URL('./main.swift', import.meta.url), 'utf8');
  assert.match(source, /import AppKit/);
  assert.match(source, /\.nonactivatingPanel/);
  assert.match(source, /canBecomeKey: Bool \{ false \}/);
  assert.match(source, /\.floating/);
  assert.match(source, /Shepherd /);
  assert.match(source, /\{\\"action\\":\\"\\\(action\)\\"\}/);
  assert.doesNotMatch(source, /\b(?:Network|CFNetwork|URLSession|ScreenCaptureKit|Vision)\b/);
});
