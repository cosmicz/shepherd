import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AnalysisCancelled,
  buildCloudRequest,
  createOpenRouterTransport,
  dispatchCloudJudge,
  parseVerdict,
  redactExcerpt,
} from './cloud-judge.mjs';

const grant = {
  id: 'grant-1',
  session_id: 'session-1',
  generation: 7,
  source: 'window',
  scope: 'redacted-text',
  max_bytes: 2048,
  version: 1,
  granted_at: '2029-12-31T23:00:00.000Z',
  expires_at: '2030-01-01T00:00:00.000Z',
};

const context = {
  frame: { session_id: 'session-1', generation: 7, source: 'window', consent: grant },
  now: new Date('2029-12-31T23:59:00.000Z'),
  providerReachable: true,
  budgetAvailable: true,
  inFlight: 0,
};

test('redacts every privacy fixture before the exact serialized body is sent', () => {
  const excerpt = 'Inbox\thttps://suspicious.example/path?q=1234 Email jane@example.com; call +1 (415) 555-0199; SSN 123-45-6789; visit 1234 Main Street.';
  const body = buildCloudRequest({
    excerpt,
    rulesReasons: ['impersonation'],
    localRisk: 'medium',
    localReasons: ['support_pressure'],
    source: 'window',
    patternHints: ['tech_support'],
    model: 'anthropic/claude-opus-5',
  });

  assert.equal(redactExcerpt(excerpt).includes('suspicious.example'), false);
  assert.equal(body.text.includes('suspicious.example'), false);
  assert.match(body.text, /<url>/);
  for (const secret of ['jane@example.com', '415', '555', '0199', '1234', 'Main Street', '\thttps://']) {
    assert.equal(body.text.includes(secret), false, `serialized body leaked ${secret}`);
  }
  assert.equal(body.bytesOut, Buffer.byteLength(body.text));
  assert.equal(body.value.response_format.json_schema.strict, true);
  assert.equal(body.value.usage.include, true);
});

test('parses only the closed cloud verdict schema', () => {
  const valid = parseVerdict({
    verdict: 'suspicious',
    reasons: ['impersonation'],
    pattern: 'tech_support',
    rationale: 'The excerpt uses a lookalike support identity.',
  });
  assert.equal(valid.verdict, 'suspicious');

  assert.throws(
    () => parseVerdict({ verdict: 'scam', reasons: ['invented'], pattern: 'tech_support', rationale: 'x' }),
    /malformed/,
  );
  assert.throws(
    () => parseVerdict({ verdict: 'scam', reasons: [], pattern: 'tech_support', rationale: 'x'.repeat(301) }),
    /malformed/,
  );
});

test('dispatch validates grant, accounts exact bytes, and uses only the fake transport', async () => {
  let calls = 0;
  const result = await dispatchCloudJudge({
    context,
    request: {
      excerpt: 'Microsoft support says call 800-555-0199 now',
      rulesReasons: ['support_pressure'],
      localRisk: 'high',
      localReasons: ['support_pressure'],
      source: 'window',
      patternHints: ['tech_support'],
      model: 'anthropic/claude-opus-5',
    },
    transport: async ({ body }) => {
      calls += 1;
      assert.equal(body instanceof Uint8Array, false);
      return {
        choices: [{ message: { content: JSON.stringify({
          verdict: 'scam', reasons: ['support_pressure'], pattern: 'tech_support', rationale: 'Pressure to call support.'
        }) } }],
        usage: { cost: 0.004 },
      };
    },
  });

  assert.equal(calls, 1);
  assert.equal(result.outcome, 'success');
  assert.equal(result.remoteCalls, 1);
  assert.equal(result.cost.known, true);
  assert.equal(result.cost.usd, 0.004);
  assert.equal(result.bytesOut, Buffer.byteLength(result.body));
});

test('dispatch rejects invalid grants and preserves caller cancellation', async () => {
  await assert.rejects(
    dispatchCloudJudge({
      context: { ...context, frame: { ...context.frame, consent: { ...grant, generation: 6 } } },
      request: { excerpt: 'x', rulesReasons: [], localRisk: 'low', localReasons: [], source: 'window', patternHints: [], model: 'm' },
      transport: async () => { throw new Error('must not call'); },
    }),
    /no_consent/,
  );

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    dispatchCloudJudge({
      context: { ...context, signal: controller.signal },
      request: { excerpt: 'x', rulesReasons: [], localRisk: 'low', localReasons: [], source: 'window', patternHints: [], model: 'm' },
      transport: async () => { throw new Error('must not call'); },
    }),
    AnalysisCancelled,
  );
});

test('maps malformed model output to an inconclusive remote attempt', async () => {
  const result = await dispatchCloudJudge({
    context,
    request: { excerpt: 'x', rulesReasons: [], localRisk: 'low', localReasons: [], source: 'window', patternHints: [], model: 'm' },
    transport: async () => ({ choices: [{ message: { content: '{not json' } }] }),
  });
  assert.equal(result.outcome, 'inconclusive');
  assert.equal(result.failureKind, 'malformed');
  assert.equal(result.remoteCalls, 1);
  assert.equal(result.cost.known, false);
});

test('OpenRouter transport has the documented request shape with an injected fake fetch', async () => {
  let captured;
  const transport = createOpenRouterTransport({
    apiKey: 'test-key',
    referer: 'https://shepherd.local',
    title: 'Shepherd',
    fetchImpl: async (url, options) => {
      captured = { url, options };
      return { ok: true, json: async () => ({ choices: [] }) };
    },
  });
  await transport({ body: '{"model":"m"}' });
  assert.equal(captured.url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(captured.options.method, 'POST');
  assert.equal(captured.options.headers.Authorization, 'Bearer test-key');
  assert.equal(captured.options.headers['HTTP-Referer'], 'https://shepherd.local');
  assert.equal(captured.options.headers['X-Title'], 'Shepherd');
});
