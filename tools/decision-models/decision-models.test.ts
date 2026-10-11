import assert from 'node:assert/strict';
import test from 'node:test';
import { AnalysisCancelled, DecisionAdapter } from './decision-models.js';

const grant = { session_id: 's', generation: 1, source: 'native', expires_at: '2030-01-01T00:00:00.000Z' };
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
  assert.equal(body.includes('private'), false);
});

test('propagates caller cancellation and never dispatches without a live matching grant', async () => {
  const controller = new AbortController(); controller.abort();
  const adapter = new DecisionAdapter({ transport: async () => { throw new Error('must not call'); } });
  await assert.rejects(adapter.decide(input, controller.signal), AnalysisCancelled);
  await assert.rejects(adapter.decide({ ...input, grant: { ...grant, generation: 2 } }), /no_consent/);
});
