import assert from 'node:assert/strict';
import test from 'node:test';
import { AnalysisCancelled, DecisionAdapter } from './decision-models.js';

const grant = { id: 'g', session_id: 's', generation: 1, source: 'native', scope: 'redacted-text', max_bytes: 2048, version: 1, granted_at: '2025-01-01T00:00:00.000Z', expires_at: '2030-01-01T00:00:00.000Z' };
const input = { excerpt: 'redacted pressure text', signals: ['support_pressure'], session_id: 's', generation: 1, source: 'native', grant };

test('retains a closed valid choice distribution without leaking caller metadata', async () => {
  let body = '';
  const adapter = new DecisionAdapter({ model: 'typesafe/jev-1.13', transport: async ({ body: value }) => {
    body = value;
    return { model: 'typesafe/jev-1.13', provider: 'typesafe', answers: { category: { type: 'choice', choice: 'suspicious', confidence: .8, probabilities: { benign: .1, suspicious: .8, unknown: .1 } } } };
  }});
  const result = await adapter.decide({ ...input, title: 'private title', url: 'https://private' });
  assert.equal(result.inference_status, 'succeeded');
  assert.equal(result.provider_confidence, .8);
  assert.equal(result.remote_calls, 1);
  assert.equal(result.bytes_out, Buffer.byteLength(body));
  assert.deepEqual(result.cost, { known: false, usd: 0 });
  assert.equal(body.includes('private'), false);
});

test('propagates caller cancellation and never dispatches without a live matching grant', async () => {
  const controller = new AbortController(); controller.abort();
  const adapter = new DecisionAdapter({ transport: async () => { throw new Error('must not call'); } });
  await assert.rejects(adapter.decide(input, controller.signal), AnalysisCancelled);
  await assert.rejects(adapter.decide({ ...input, grant: { ...grant, generation: 2 } }), /no_consent/);
  await assert.rejects(adapter.decide({ ...input, grant: {} }), /no_consent/);
});

test('uses the cloud redactor and bounds decision evidence by UTF-8 bytes before dispatch', async () => {
  let body = ''; const adapter = new DecisionAdapter({ transport: async ({ body: value }) => { body = value; return { answers: { category: { type: 'choice', choice: 'unknown', confidence: .5, probabilities: { benign: .2, suspicious: .3, unknown: .5 } } } }; } });
  await adapter.decide({ ...input, excerpt: `\tjoe@example.com bank.example?token=1234 415-555-0199 SSN 123-45-6789 1234 Main Street ${'é'.repeat(3000)}` });
  for (const secret of ['joe@example.com', 'bank.example', 'token=1234', '415', '123-45-6789', 'Main Street']) assert.equal(body.includes(secret), false);
  assert.ok(Buffer.byteLength(JSON.parse(body).state.excerpt) <= 2048);
});

test('fails closed for a mismatched model or a bounded transport deadline', async () => {
  const mismatched = new DecisionAdapter({ model: 'typesafe/jev-1.13', transport: async () => ({ model: 'other', answers: { category: { type: 'choice', choice: 'suspicious', confidence: .8, probabilities: { benign: .1, suspicious: .8, unknown: .1 } } } }) });
  assert.equal((await mismatched.decide(input)).inference_status, 'failed');

  const timed = new DecisionAdapter({ timeoutMs: 5, transport: async ({ signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })) });
  assert.equal((await timed.decide(input)).inference_status, 'failed');

  const ignoresAbort = new DecisionAdapter({ timeoutMs: 5, transport: async () => new Promise(() => {}) });
  const started = performance.now();
  const result = await ignoresAbort.decide(input);
  assert.equal(result.inference_status, 'failed');
  assert.equal(result.remote_calls, 1);
  assert.ok(performance.now() - started < 100, 'deadline must settle even if transport ignores abort');
});
