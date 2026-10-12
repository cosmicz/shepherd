import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LlamaLocalModel } from '../src/adapters/llama-local.ts';
import { DEADLINES, localDeadline, RoutedAnalyzer, type LocalModelPort } from '../src/application/routing.ts';

// contract: SHEPHERD_LOCAL_DEADLINE_MS lets the live demo give the local model more
// time on a loaded machine. Default unchanged; bounded so a typo cannot disable it.
test('local deadline: unset keeps the 4,000 ms default', () => {
  assert.equal(DEADLINES.local_ms, 4000);
  assert.equal(localDeadline(undefined), 4000);
  assert.equal(localDeadline(''), 4000);
});

test('local deadline: integers from 1,000 to 10,000 ms are accepted, anything else refused', () => {
  for (const ok of ['1000', '6000', '10000']) assert.equal(localDeadline(ok), Number(ok));
  for (const bad of ['999', '10001', '6000.5', 'abc', '-1', '6e3x']) assert.throws(() => localDeadline(bad), /SHEPHERD_LOCAL_DEADLINE_MS/, bad);
});

const frame = { frame_id: 'f', source: 'native' as const, session_id: 's', generation: 1, captured_at: '2026-10-11T16:00:00Z', text: 'Weekly garden club newsletter with tomato tips and a compost workshop on Saturday.' };
const slowLocal = (ms: number): LocalModelPort => ({
  model: 'slow', available: async () => true,
  assess: (_text, signal) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve({ risk: 'low', reasons: [], cue: '' }), ms);
    signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
  }),
});
const localStep = async (local_ms: number, model: LocalModelPort) => {
  const analyzer = new RoutedAnalyzer({ extractor: { extract: async (f) => ('text' in f ? f.text : '') }, local: model, deadlines: { local_ms } });
  const result = await analyzer.analyze(frame, new AbortController().signal);
  const step = result.trace.find((s) => s.tier === 'local-model');
  return `${step?.outcome}${step?.failure_kind ? `/${step.failure_kind}` : ''}`;
};

test('local deadline: the composite honours the configured limit', async () => {
  assert.equal(await localStep(localDeadline('1000'), slowLocal(1300)), 'failed/timeout');
  assert.equal(await localStep(localDeadline('2000'), slowLocal(1300)), 'no_signal');
});

// The llama adapter has its own timer (default 4,000 ms); main.ts passes the same value.
test('local deadline: the llama adapter honours timeoutMs as well', async () => {
  const fetchImpl = ((_url: string, init: RequestInit) => new Promise<Response>((resolve, reject) => {
    const timer = setTimeout(() => resolve(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ risk: 'low', reasons: [], cue: '' }) } }] }))), 1300);
    init.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(init.signal?.reason); }, { once: true });
  })) as typeof fetch;
  // As in main.ts, a ready manager answers availability (no probe through the slow fetch).
  const manager = { status: () => ({ state: 'ready' as const, managed: true }) };
  assert.equal(await localStep(10_000, new LlamaLocalModel({ timeoutMs: 1000, fetchImpl, manager })), 'failed/timeout');
  assert.equal(await localStep(10_000, new LlamaLocalModel({ timeoutMs: 2000, fetchImpl, manager })), 'no_signal');
});
