import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { OcrAnalyzer } from '../src/adapters/ocr.ts';
import { runProcess } from '../src/adapters/process.ts';
import { decodeFrame } from '../src/server/frame.ts';

const context = { frame_id: 'fixture-1', source: 'example' as const };
const png = await readFile(new URL('../fixtures/support-warning.png', import.meta.url));
const frame = { ...context, image: `data:image/png;base64,${png.toString('base64')}` };

test('installed Tesseract reads a synthetic image through the real adapter', async () => {
  const analyzer = new OcrAnalyzer();
  const [capability] = await analyzer.capabilities();
  assert.equal(capability.available, true, 'Install Tesseract and English language data to run required OCR tests');
  assert.match(capability.engine_version ?? '', /^tesseract /);
  const assessment = await analyzer.analyze(frame, new AbortController().signal);
  assert.equal(assessment.status, 'concern');
  assert.deepEqual(assessment.reasons, ['support_pressure']);
  assert.equal(assessment.analyzer.kind, 'rules');
  assert.ok(assessment.duration_ms > 0);
});

test('missing executable is unavailable in capabilities and analysis', async () => {
  const analyzer = new OcrAnalyzer({ executable: '/nonexistent/shepherd-tesseract' });
  assert.equal((await analyzer.capabilities())[0].available, false);
  assert.equal((await analyzer.analyze(frame, new AbortController().signal)).status, 'unavailable');
});

test('empty OCR, invalid output and timeout remain distinct from no signal', async () => {
  const signal = new AbortController().signal;
  assert.equal((await new OcrAnalyzer({ execute: async () => ' \n' }).analyze(frame, signal)).status, 'inconclusive');
  assert.equal((await new OcrAnalyzer({ execute: async () => '\0malformed' }).analyze(frame, signal)).status, 'unavailable');
  assert.equal((await new OcrAnalyzer({ execute: async () => { throw Error('timeout'); } }).analyze(frame, signal)).status, 'unavailable');
});

test('subprocess has bounded output, timeout and cancellation', async () => {
  const signal = new AbortController().signal;
  await assert.rejects(runProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], Buffer.alloc(0), signal, 50), /timeout/);
  await assert.rejects(runProcess(process.execPath, ['-e', 'process.stdout.write("x".repeat(100000))'], Buffer.alloc(0), signal, 1000, 100), /output/);
  const abort = new AbortController();
  const pending = runProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], Buffer.alloc(0), abort.signal, 5000);
  abort.abort();
  await assert.rejects(pending, /abort/);
  await assert.rejects(runProcess(process.execPath, ['-e', 'process.exit(2)'], Buffer.alloc(0), signal, 1000), /exit/);
});

test('frame decoding rejects oversized dimensions and malformed image encodings', () => {
  assert.equal(decodeFrame(frame).pixels?.width, 1100);
  assert.throws(() => decodeFrame({ ...frame, image: 'not-an-image' }));
  assert.throws(() => decodeFrame({ ...frame, source: 'monitor' }));
  assert.throws(() => decodeFrame({ ...frame, image: `data:image/png;base64,${Buffer.from('wrong signature').toString('base64')}` }));
  const huge = Buffer.from(png);
  huge.writeUInt32BE(50000, 16);
  assert.throws(() => decodeFrame({ ...frame, image: `data:image/png;base64,${huge.toString('base64')}` }));
  assert.throws(() => decodeFrame({ ...frame, image: `${frame.image}@@@@` }));
});
