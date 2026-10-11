import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeFrame, MAX_BODY_BYTES, MAX_IMAGE_BYTES, MAX_PIXELS, MAX_SIDE } from '../src/server/frame.ts';
import { dataUrl, syntheticPng as png } from './png-fixture.ts';

const frame = (image: string) => ({ frame_id: 'frame-1', source: 'example' as const, image });

test('a valid 3.6 MB PNG decodes without exhausting the stack (F1 regression)', () => {
  const bytes = png(1100, 1100, 3_637_103);
  assert.equal(decodeFrame(frame(dataUrl(bytes))).png?.length, 3_637_103);
});

test('decoded size limit accepts the cap and rejects one byte more', () => {
  assert.equal(decodeFrame(frame(dataUrl(png(2560, 1600, MAX_IMAGE_BYTES)))).png?.length, MAX_IMAGE_BYTES);
  assert.throws(() => decodeFrame(frame(dataUrl(png(2560, 1600, MAX_IMAGE_BYTES + 1)))));
});

test('dimension limits are per side and per pixel count', () => {
  assert.equal(decodeFrame(frame(dataUrl(png(MAX_SIDE, 1600)))).pixels?.width, MAX_SIDE);
  assert.throws(() => decodeFrame(frame(dataUrl(png(MAX_SIDE + 1, 100)))), /dimensions/);
  assert.throws(() => decodeFrame(frame(dataUrl(png(100, MAX_SIDE + 1)))), /dimensions/);
  assert.equal(decodeFrame(frame(dataUrl(png(5000, MAX_PIXELS / 5000)))).pixels?.height, 2000);
  assert.throws(() => decodeFrame(frame(dataUrl(png(5000, MAX_PIXELS / 5000 + 1)))), /dimensions/);
  assert.throws(() => decodeFrame(frame(dataUrl(png(0, 100)))), /dimensions/);
});

test('base64 must be canonical: alphabet, length, padding and pad bits', () => {
  const encoded = png(10, 10, 100).toString('base64');
  assert.equal(encoded.length % 4, 0);
  const prefix = 'data:image/png;base64,';
  const bad = [
    encoded.replace(/=+$/, ''),                       // missing padding
    `${encoded.slice(0, 8)}=${encoded.slice(9)}`,     // padding in the middle
    `${encoded.slice(0, 8)}-${encoded.slice(9)}`,     // base64url alphabet
    `${encoded.slice(0, 8)} ${encoded.slice(9)}`,     // whitespace
    `${encoded}AAAA`,                                 // trailing data after IEND
    `${encoded}====`,                                 // extra padding
    '',
  ];
  for (const value of bad) assert.throws(() => decodeFrame(frame(prefix + value)), Error, JSON.stringify(value.slice(-12)));
  // 100 bytes end in one leftover byte, so the last group is "XY==" and Y's low
  // four bits are padding. Setting one decodes to the same, still-valid PNG but is
  // not the canonical encoding.
  assert.ok(encoded.endsWith('=='));
  assert.equal(decodeFrame(frame(prefix + encoded)).png?.length, 100);
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const last = encoded.at(-3) as string;
  const padded = `${encoded.slice(0, -3)}${alphabet[alphabet.indexOf(last) ^ 1]}==`;
  assert.deepEqual(Buffer.from(padded, 'base64'), Buffer.from(encoded, 'base64'));
  assert.throws(() => decodeFrame(frame(prefix + padded)), /base64/);
});

test('request body limit is derived from the image limit plus a bounded envelope', () => {
  const largest = JSON.stringify(frame(dataUrl(png(2560, 1600, MAX_IMAGE_BYTES))));
  assert.ok(Buffer.byteLength(largest) + 128 <= MAX_BODY_BYTES, 'a maximal frame with a maximal frame_id fits');
  assert.ok(MAX_BODY_BYTES - Buffer.byteLength(largest) <= 128 * 1024, 'envelope allowance stays small');
});
