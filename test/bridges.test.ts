import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LlamaLocalModel } from '../src/adapters/llama-local.ts';
import { OpenRouterJudge } from '../src/adapters/openrouter-judge.ts';
import { LocalModelError, RoutedAnalyzer } from '../src/application/routing.ts';
import type { Grant, TextFrame } from '../src/domain/assessment.ts';
import { GrantRegistry } from '../src/server/consent.ts';

// Fakes only: no request leaves the process.
const chat = (content: unknown, ok = true) => (async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }), { status: ok ? 200 : 500 })) as unknown as typeof fetch;
const now = Date.now();
const session = { session_id: 's-1', generation: 1 };
const grant: Grant = { id: 'g-1', ...session, source: 'native', scope: 'redacted-text', max_bytes: 2048, version: 1, granted_at: new Date(now - 60_000).toISOString(), expires_at: new Date(now + 3600_000).toISOString() };
const frame: TextFrame = { frame_id: 'f-1', source: 'native', ...session, consent: grant, captured_at: new Date(now).toISOString(),
  text: 'Weekly club letter. Contact jo@example.com or 415-555-0172 about account 99881234.' };

test('local bridge maps the tea adapter: value, malformed, unavailable', async () => {
  const value = { risk: 'high', reasons: ['family_emergency'], cue: 'bail request' };
  assert.deepEqual(await new LlamaLocalModel({ fetchImpl: chat(value) }).assess('bail request', new AbortController().signal), { ...value, quote: 'bail request', partial: false });
  await assert.rejects(new LlamaLocalModel({ fetchImpl: chat({ risk: 'high', reasons: [], cue: '' }) }).assess('t', new AbortController().signal), (e) => e instanceof LocalModelError && e.failure_kind === 'malformed');
  await assert.rejects(new LlamaLocalModel({ fetchImpl: chat(value, false) }).assess('t', new AbortController().signal), (e) => e instanceof LocalModelError && e.failure_kind === 'unavailable');
  assert.equal(await new LlamaLocalModel({ fetchImpl: (async () => { throw Error('refused'); }) as unknown as typeof fetch }).available(), false);
});

test('cloud bridge: redacted body, exact bytes and hash, closed verdict, cost from usage', async () => {
  const bodies: string[] = [];
  const judge = new OpenRouterJudge({ model: 'anthropic/claude-opus-5', transport: async ({ body }) => {
    bodies.push(body);
    return { choices: [{ message: { content: JSON.stringify({ verdict: 'scam', reasons: ['investment_pressure'], pattern: 'celebrity_investment', rationale: 'model text' }) } }], usage: { cost: 0.0048 } };
  } });
  const request = { excerpt: frame.text, rulesReasons: [], localRisk: 'medium' as const, localReasons: ['impersonation' as const], source: 'native' as const, patternHints: [] };
  const result = await judge.judge(request, new AbortController().signal, frame);
  assert.ok(result.ok);
  assert.deepEqual([result.verdict, result.pattern, result.cost], ['scam', 'celebrity_investment', { known: true, usd: 0.0048 }]);
  assert.equal(result.bytes_out, Buffer.byteLength(bodies[0]));
  assert.deepEqual(judge.measure(request), { bytes_out: result.bytes_out, payload_sha256: result.payload_sha256 });
  for (const secret of ['jo@example.com', '415-555-0172', '99881234']) assert.ok(!bodies[0].includes(secret), secret);
  assert.equal(new OpenRouterJudge({ model: 'm' }).available(), false, 'no key, no transport, not available');
});

test('routed analyzer over both bridges: consented uncertain frame reaches the judge once', async () => {
  let dispatched = 0;
  const consent = new GrantRegistry();
  consent.register(grant);
  const analyzer = new RoutedAnalyzer({
    extractor: { extract: async (f) => ('text' in f ? f.text : '') }, consent, quoteExcerpts: true,
    local: new LlamaLocalModel({ fetchImpl: chat({ risk: 'medium', reasons: ['impersonation'], cue: 'about account 99881234' }) }),
    cloud: new OpenRouterJudge({ model: 'anthropic/claude-opus-5', transport: async () => { dispatched++; return { choices: [{ message: { content: JSON.stringify({ verdict: 'suspicious', reasons: ['impersonation'], pattern: 'other', rationale: 'r' }) } }], usage: { cost: 0.004 } }; } }),
  });
  const result = await analyzer.analyze(frame, new AbortController().signal);
  assert.deepEqual([result.status, result.route, result.policy_row, dispatched], ['concern', 'cloud', '14', 1]);
  assert.deepEqual(result.analyzer, { id: 'cloud-judge', kind: 'model', provider: 'openrouter', model: 'anthropic/claude-opus-5' });
});

// Contract v2.1 runtime witness (r81): a novel scam no rule names, through the
// real local bridge, with cloud consent absent, surfaces a spoken caution and
// nothing leaves the machine; without a verbatim cue it stays inconclusive.
test('routed analyzer over both bridges: novel other_concern settles on device at row 12d (r81)', async () => {
  let dispatched = 0;
  const novel: TextFrame = { ...frame, frame_id: 'f-novel', consent: undefined,
    text: 'Hello neighbour, the building portal is moving. Please verify your account by uploading a photo of your passport and both sides of your bank card to keep your parking spot.' };
  const analyzer = (cue: string) => new RoutedAnalyzer({
    extractor: { extract: async (f) => ('text' in f ? f.text : '') }, consent: new GrantRegistry(),
    local: new LlamaLocalModel({ fetchImpl: chat({ risk: 'high', reasons: ['other_concern'], cue }) }),
    cloud: new OpenRouterJudge({ model: 'anthropic/claude-opus-5', transport: async () => { dispatched++; throw Error('no dispatch expected'); } }),
  });
  const surfaced = await analyzer('a photo of your passport').analyze(novel, new AbortController().signal);
  assert.deepEqual([surfaced.status, surfaced.route, surfaced.policy_row, surfaced.reasons], ['inconclusive', 'local-model', '12d', []]);
  assert.deepEqual(surfaced.trace.map((s) => [s.remote_calls, s.bytes_out]), [[0, 0], [0, 0], [0, 0]]);
  const unquoted = await analyzer('a photo of your licence').analyze({ ...novel, frame_id: 'f-novel-2' }, new AbortController().signal);
  assert.deepEqual([unquoted.status, unquoted.policy_row], ['inconclusive', '6']);
  assert.equal(dispatched, 0);
});
