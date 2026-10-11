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
  const excerpt = 'Inbox\thttps://suspicious.example/path?q=1234 or secure-login.de/account?token=abc123 micros0ft-help.support/fix?id=a1 bank-verify.ru/login paypal-help.shop/x?u=jdoe my.bank.me/statement Email jane@example.com; call +1 (415) 555-0199; SSN 123-45-6789; visit 1234 Main Street.';
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
  for (const host of ['secure-login.de', 'micros0ft-help.support', 'bank-verify.ru', 'paypal-help.shop', 'my.bank.me']) assert.equal(redactExcerpt(excerpt).includes(host), false);
  assert.equal(body.text.includes('suspicious.example'), false);
  assert.match(body.text, /<url>/);
  for (const secret of ['jane@example.com', '415', '555', '0199', '1234', 'Main Street', '\thttps://', 'secure-login.de', 'token=', 'id=', 'u=']) {
    assert.equal(body.text.includes(secret), false, `serialized body leaked ${secret}`);
  }
  assert.equal(body.bytesOut, Buffer.byteLength(body.text));
  assert.equal(body.value.response_format.json_schema.strict, true);
  assert.equal(body.value.usage.include, true);
});

test('redacts a bare host with port, path, and query as one URL token', () => {
  const hostWithPort = 'bank-verify.ru:8443/login?u=jdoe';
  assert.equal(redactExcerpt(hostWithPort), '<url>');
  const built = buildCloudRequest({
    excerpt: hostWithPort, rulesReasons: [], localRisk: 'low', localReasons: [],
    source: 'window', patternHints: [], model: 'm',
  });
  for (const secret of ['bank-verify.ru', '8443', '/login', 'u=jdoe']) assert.equal(built.text.includes(secret), false, `serialized body leaked ${secret}`);
});

test('parses only the closed cloud verdict schema', () => {
  const valid = parseVerdict({
    verdict: 'suspicious',
    reasons: ['impersonation'],
    pattern: 'tech_support',
    rationale: 'The excerpt uses a lookalike support identity.',
  });
  assert.equal(valid.verdict, 'suspicious');

  // v2.1: an unknown reason string is dropped, not a rejection; other_concern is closed.
  assert.deepEqual(parseVerdict({ verdict: 'scam', reasons: ['invented', 'payment_pressure'], pattern: 'tech_support', rationale: 'x' }).reasons, ['payment_pressure']);
  assert.deepEqual(parseVerdict({ verdict: 'suspicious', reasons: ['other_concern'], pattern: 'other', rationale: 'x' }).reasons, ['other_concern']);
  assert.throws(
    () => parseVerdict({ verdict: 'scam', reasons: [7], pattern: 'tech_support', rationale: 'x' }),
    /malformed/,
  );
  const overlong = parseVerdict({ verdict: 'benign', reasons: [], pattern: 'other', rationale: 'x'.repeat(301) });
  assert.equal(overlong.verdict, 'benign');
  assert.equal(overlong.rationale.length, 300);
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

test('dispatch reports invalid grants as an unattempted request and preserves caller cancellation', async () => {
  const rejected = await dispatchCloudJudge({
    context: { ...context, frame: { ...context.frame, consent: { ...grant, generation: 6 } } },
    request: { excerpt: 'x', rulesReasons: [], localRisk: 'low', localReasons: [], source: 'window', patternHints: [], model: 'm' },
    transport: async () => { throw new Error('must not call'); },
  });
  assert.deepEqual([rejected.remoteCalls, rejected.bytesOut, rejected.failureKind], [0, 0, 'no_consent']);

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

test('a grant revoked immediately before dispatch has zero calls and bytes', async () => {
  let calls = 0;
  const result = await dispatchCloudJudge({
    context: { ...context, now: new Date('2030-01-01T00:00:00.000Z') },
    request: { excerpt: 'x', rulesReasons: [], localRisk: 'low', localReasons: [], source: 'window', patternHints: [], model: 'm' },
    transport: async () => { calls += 1; return {}; },
  });
  assert.equal(calls, 0);
  assert.deepEqual([result.remoteCalls, result.bytesOut, result.failureKind], [0, 0, 'no_consent']);
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
  assert.equal(captured.options.redirect, 'error');
  assert.equal(captured.options.headers.Authorization, 'Bearer test-key');
  assert.equal(captured.options.headers['HTTP-Referer'], 'https://shepherd.local');
  assert.equal(captured.options.headers['X-Title'], 'Shepherd');
});
