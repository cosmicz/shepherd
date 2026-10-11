import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HttpAnalyzer } from '../src/adapters/http-analyzer.ts';
import { OcrAnalyzer } from '../src/adapters/ocr.ts';
import { analyzeText } from '../src/domain/assessment.ts';
import { startServer } from '../src/server/server.ts';

const textFrame = {
  frame_id: 'native-http-1', source: 'native' as const, session_id: 'session-1', generation: 1,
  text: 'Your computer is infected. Call support now.', app: 'Safari', bundle_id: 'com.apple.Safari',
  window_title: 'Alert', url: null, captured_at: '2026-10-11T13:00:00Z',
};

test('a native TextFrame is analyzed by the rules without OCR and carries a local trace step', async (t) => {
  let ocrCalls = 0;
  const runtime = await startServer({ port: 0, analyzer: new OcrAnalyzer({ execute: async () => { ocrCalls++; return ''; } }) });
  t.after(() => runtime.close());
  const result = await new HttpAnalyzer(runtime.origin).analyze(textFrame, new AbortController().signal);
  assert.equal(result.status, 'concern');
  assert.deepEqual(result.reasons, ['support_pressure']);
  assert.equal(result.source, 'native');
  assert.equal(ocrCalls, 0, 'text frames never spawn OCR');
  assert.equal(result.trace.length, 1);
  assert.deepEqual({ ...result.trace[0], duration_ms: 0 }, {
    tier: 'rules', analyzer_id: 'local-ocr-rules', outcome: 'concern', duration_ms: 0, remote_calls: 0, bytes_out: 0,
    cost: { known: true, usd: 0 }, cached: false, versions: { policy: 2, prompt: 1, schema: 2 },
  });
});

test('capabilities are a list; the client keeps every valid analyzer and drops malformed ones', async (t) => {
  const runtime = await startServer({ port: 0, analyzer: {
    analyze: async (input) => analyzeText('Garden newsletter.', input),
    capabilities: async () => [
      { id: 'local-ocr-rules', kind: 'rules', route: 'local', available: true },
      { id: 'local-model', kind: 'model', route: 'local-model', available: false, model: 'qwen3-8b-q4_k_m', limitation: 'llama-server not running' },
      { id: 'cloud-judge', kind: 'model', route: 'local', available: true } as never, // wrong route: dropped
    ],
  } });
  t.after(() => runtime.close());
  const capabilities = await new HttpAnalyzer(runtime.origin).capabilities();
  assert.deepEqual(capabilities.map((item) => [item.id, item.available]), [['local-ocr-rules', true], ['local-model', false]]);
  assert.equal(capabilities[1].model, 'qwen3-8b-q4_k_m');
});

test('an unreachable runtime reports no analyzers', async () => {
  const runtime = await startServer({ port: 0 });
  const origin = runtime.origin;
  await runtime.close();
  assert.deepEqual(await new HttpAnalyzer(origin).capabilities(), []);
});
