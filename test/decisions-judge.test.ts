import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { createDecisionsTransport, DECISIONS_URL, DecisionsJudge, type DecisionsTransport } from '../src/adapters/decisions-judge.ts';
import { AnalysisCancelled } from '../src/application/analyzer.ts';
import { RoutedAnalyzer, type CloudJudgeRequest } from '../src/application/routing.ts';
import { parseAssessment, parseJudgeMeta, parseRouteStep, type Frame, type TextFrame } from '../src/domain/assessment.ts';

// contract plumbing evidence with a fake transport: no network, no model accuracy claim.
const model = 'cloudflare/clef-flash';
const frame: Frame = { frame_id: 'f', source: 'native', session_id: 's', generation: 1, captured_at: '2026-10-11T16:30:00Z', text: 'x' } as TextFrame;
const request = (excerpt = 'Your account will be suspended today. Please buy gift cards now.'): CloudJudgeRequest =>
  ({ excerpt, rulesReasons: ['payment_pressure'], localRisk: 'medium', localReasons: [], source: 'native', patternHints: [] });
const answer = (choice: string, probabilities: Record<string, number>, extra: Record<string, unknown> = {}) =>
  ({ model, provider: 'cloudflare', answers: { category: { type: 'choice', choice, confidence: Math.max(...Object.values(probabilities)), probabilities } }, ...extra });
const fake = (reply: unknown | ((body: string, signal: AbortSignal) => Promise<unknown>)) => {
  const bodies: string[] = [];
  const transport: DecisionsTransport = ({ body, signal }) => { bodies.push(body); return typeof reply === 'function' ? (reply as (b: string, s: AbortSignal) => Promise<unknown>)(body, signal) : Promise.resolve(reply); };
  return { bodies, transport };
};
const run = (judge: DecisionsJudge, req = request(), signal = new AbortController().signal) => judge.judge(req, signal, frame);

test('decisions: benign/suspicious/unknown map to benign/suspicious/unclear, pattern other, reasons []; distribution kept', async () => {
  for (const [choice, verdict] of [['benign', 'benign'], ['suspicious', 'suspicious'], ['unknown', 'unclear']] as const) {
    const probabilities = { benign: 0.1, suspicious: 0.1, unknown: 0.1, [choice]: 0.8 };
    const f = fake(answer(choice, probabilities));
    const outcome = await run(new DecisionsJudge({ model, transport: f.transport }));
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.deepEqual([outcome.verdict, outcome.pattern, outcome.reasons], [verdict, 'other', []]);
    assert.deepEqual(outcome.judge_meta, { classes: probabilities, concentration: 0.8, provider_confidence: 0.8, calibrated: false, basis: 'provider_distribution' });
    assert.equal(outcome.bytes_out, Buffer.byteLength(f.bodies[0]));
    assert.equal(outcome.payload_sha256, createHash('sha256').update(f.bodies[0]).digest('hex'));
    assert.deepEqual(outcome.cost, { known: false, usd: 0 }, 'no usage -> unknown cost, never free');
  }
  const priced = await run(new DecisionsJudge({ model, transport: fake(answer('suspicious', { benign: 0.1, suspicious: 0.8, unknown: 0.1 }, { usage: { cost: 0.0007 } })).transport }));
  assert.deepEqual(priced.cost, { known: true, usd: 0.0007 });
});

test('decisions: the body is the redacted, bounded excerpt plus closed codes; no caller extras', async () => {
  const f = fake(answer('suspicious', { benign: 0.1, suspicious: 0.8, unknown: 0.1 }));
  const judge = new DecisionsJudge({ model, transport: f.transport });
  const raw = `Email jane@example.com call 415-555-0199 acct 44171234 https://bank.example/verify?id=9 now. ${'pressure '.repeat(400)}`;
  await run(judge, { ...request(raw), title: 'Bank of June', url: 'https://bank.example' } as CloudJudgeRequest);
  const body = JSON.parse(f.bodies[0]);
  assert.deepEqual(Object.keys(body).sort(), ['model', 'questions', 'state']);
  assert.deepEqual(Object.keys(body.state).sort(), ['excerpt', 'signals']);
  assert.deepEqual(body.state.signals, { rules_reasons: ['payment_pressure'], local_risk: 'medium', local_reasons: [], source: 'native' });
  for (const leak of ['jane@example.com', '415-555-0199', '44171234', 'bank.example', 'Bank of June']) assert.ok(!f.bodies[0].includes(leak), leak);
  assert.ok(Buffer.byteLength(body.state.excerpt) <= 2048);
  assert.ok(body.state.excerpt.startsWith(judge.redact(raw).slice(0, 60)), 'the same redaction routing shows');
  assert.equal(judge.measure(request(raw)).bytes_out, Buffer.byteLength(f.bodies[0]));
});

test('decisions: invalid answers and unexpected models are malformed, still one counted call', async () => {
  const bad = [
    { ...answer('suspicious', { benign: 0.1, suspicious: 0.8, unknown: 0.1 }), model: 'typesafe/jev-1.13' },
    answer('suspicious', { benign: 0.3, suspicious: 0.3, unknown: 0.3 }),
    answer('benign', { benign: 0.1, suspicious: 0.8, unknown: 0.1 }),
    answer('scam', { benign: 0.1, suspicious: 0.8, unknown: 0.1 }),
    answer('suspicious', { benign: -0.1, suspicious: 1.1, unknown: 0 }),
    { model, answers: {} },
    null,
  ];
  for (const reply of bad) {
    const f = fake(reply);
    const outcome = await run(new DecisionsJudge({ model, transport: f.transport }));
    assert.deepEqual([outcome.ok, !outcome.ok && outcome.failure_kind], [false, 'malformed'], JSON.stringify(reply));
    assert.equal(outcome.bytes_out, Buffer.byteLength(f.bodies[0]));
    assert.equal(f.bodies.length, 1);
  }
});

test('decisions: provider errors and the own deadline are explicit failures; caller abort propagates', async () => {
  const status = (code: number) => fake(() => Promise.reject(Object.assign(new Error(`HTTP ${code}`), { status: code })));
  const network = await run(new DecisionsJudge({ model, transport: status(503).transport }));
  assert.deepEqual([network.ok, !network.ok && network.failure_kind], [false, 'network']);
  const limited = await run(new DecisionsJudge({ model, transport: status(429).transport }));
  assert.deepEqual([limited.ok, !limited.ok && limited.failure_kind], [false, 'rate_limit']);
  const hang = () => fake((_body: string, signal: AbortSignal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason))));
  const timedOut = await run(new DecisionsJudge({ model, transport: hang().transport, timeoutMs: 30 }));
  assert.deepEqual([timedOut.ok, !timedOut.ok && timedOut.failure_kind], [false, 'timeout']);
  const caller = new AbortController();
  const pending = run(new DecisionsJudge({ model, transport: hang().transport }), request(), caller.signal);
  caller.abort(new AnalysisCancelled());
  await assert.rejects(pending, AnalysisCancelled);
});

test('decisions: fixed destination, key only in the header, redirects refused', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return new Response('{}'); }) as typeof fetch;
  await createDecisionsTransport({ apiKey: 'test-key', fetchImpl })({ body: '{"a":1}', signal: new AbortController().signal });
  assert.equal(calls[0].url, DECISIONS_URL);
  assert.equal(calls[0].init.redirect, 'error');
  assert.equal((calls[0].init.headers as Record<string, string>).Authorization, 'Bearer test-key');
  assert.ok(!String(calls[0].init.body).includes('test-key'));
  assert.throws(() => new DecisionsJudge({ model: 'openai/gpt-x' as never }));
});

// Through the routing port: the gate decides consent (D1), nothing is sent without it.
const grant = { id: 'g', session_id: 's', generation: 1, source: 'native' as const, scope: 'redacted-text' as const, max_bytes: 2048 as const, version: 1 as const,
  granted_at: new Date(Date.now() - 60_000).toISOString(), expires_at: new Date(Date.now() + 3600_000).toISOString() };
const weak: TextFrame = { frame_id: 'w', source: 'native', session_id: 's', generation: 1, captured_at: '2026-10-11T16:30:00Z', consent: grant, text: 'Your account will be suspended today. Please buy gift cards now and send the codes.' };
const routed = (live: boolean, transport: DecisionsTransport) => new RoutedAnalyzer({
  extractor: { extract: async (f) => ('text' in f ? f.text : '') }, consent: { live: () => live },
  local: { model: 'l', available: async () => false, assess: async () => ({ risk: 'low', reasons: [], cue: '' }) },
  cloud: new DecisionsJudge({ model, transport }),
});

test('decisions via routing: no live grant -> zero transport calls; with a grant the step carries judge_meta', async () => {
  const none = fake(answer('suspicious', { benign: 0.1, suspicious: 0.8, unknown: 0.1 }));
  const refused = await routed(false, none.transport).analyze(weak, new AbortController().signal);
  assert.equal(none.bodies.length, 0);
  assert.equal(refused.trace.reduce((sum, s) => sum + s.remote_calls, 0), 0);
  const granted = fake(answer('suspicious', { benign: 0.1, suspicious: 0.8, unknown: 0.1 }));
  const result = parseAssessment(await routed(true, granted.transport).analyze(weak, new AbortController().signal));
  assert.equal(granted.bodies.length, 1);
  const cloud = result.trace.find((s) => s.tier === 'cloud');
  assert.equal(cloud?.remote_calls, 1);
  assert.equal(cloud?.bytes_out, Buffer.byteLength(granted.bodies[0]));
  assert.deepEqual(cloud?.judge_meta?.classes, { benign: 0.1, suspicious: 0.8, unknown: 0.1 });
  assert.equal(result.analyzer.id === 'cloud-judge' && result.analyzer.provider, 'openrouter', 'never labelled Anthropic');
});

test('judge_meta schema: uncalibrated cloud-only, closed classes, unit probabilities', () => {
  const meta = { classes: { suspicious: 0.8 }, concentration: 0.8, provider_confidence: null, calibrated: false, basis: 'provider_distribution' };
  assert.deepEqual(parseJudgeMeta(meta), meta);
  assert.throws(() => parseJudgeMeta({ ...meta, calibrated: true }));
  assert.throws(() => parseJudgeMeta({ ...meta, classes: { scam: 0.8 } }));
  assert.throws(() => parseJudgeMeta({ ...meta, concentration: 1.2 }));
  const local = { tier: 'rules', analyzer_id: 'local-ocr-rules', outcome: 'concern', duration_ms: 1, remote_calls: 0, bytes_out: 0, cost: { known: true, usd: 0 }, cached: false, versions: { policy: 3, prompt: 3, schema: 3 } };
  assert.throws(() => parseRouteStep({ ...local, judge_meta: meta }), /Only cloud steps/);
});
