import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HttpAnalyzer } from '../src/adapters/http-analyzer.ts';
import { AnalysisCancelled, AnalysisTimeout } from '../src/application/analyzer.ts';
import { RoutedAnalyzer, type CloudJudgePort } from '../src/application/routing.ts';
import { analyzeText, parseAssessment, type Grant, type RouteStep, type TextFrame } from '../src/domain/assessment.ts';
import { GrantRegistry } from '../src/server/consent.ts';
import { startServer } from '../src/server/server.ts';

const versions = { policy: 2, prompt: 1, schema: 2 };
const step = (tier: RouteStep['tier'], extra: Partial<RouteStep> = {}): RouteStep => ({
  tier, analyzer_id: tier === 'rules' ? 'local-ocr-rules' : tier === 'local-model' ? 'local-model' : 'cloud-judge', outcome: 'inconclusive',
  duration_ms: 1, remote_calls: tier === 'cloud' ? 1 : 0, bytes_out: tier === 'cloud' ? 600 : 0, cost: tier === 'cloud' ? { known: false, usd: 0 } : { known: true, usd: 0 }, cached: false, versions, ...extra,
});
const cloudAssessment = (trace: RouteStep[]) => ({
  frame_id: 'f', source: 'native', status: 'inconclusive', reasons: [], evidence: [], message: 'm', media_origin: 'not_assessed', duration_ms: 1,
  analyzer: { id: 'cloud-judge', kind: 'model', provider: 'anthropic', model: 'm' }, route: 'cloud', trace,
});

test('trace: an uncached cloud attempt has at least one remote call; only a cache hit has zero', () => {
  assert.throws(() => parseAssessment(cloudAssessment([step('rules'), step('cloud', { remote_calls: 0, bytes_out: 0 })])));
  assert.throws(() => parseAssessment(cloudAssessment([step('rules'), step('cloud', { outcome: 'failed', failure_kind: 'timeout', remote_calls: 0, bytes_out: 0 })])));
  assert.equal(parseAssessment(cloudAssessment([step('rules'), step('cloud', { remote_calls: 0, bytes_out: 0, cached: true, cost: { known: true, usd: 0 } })])).trace[1].cached, true);
});

test('trace: tiers in fixed order rules, local-model, cloud, without duplicates', () => {
  const bad = [
    [step('cloud'), step('rules')],
    [step('rules'), step('rules'), step('cloud')],
    [step('rules'), step('cloud'), step('local-model')],
    [step('rules'), step('cloud'), step('cloud')],
  ];
  for (const trace of bad) assert.throws(() => parseAssessment(cloudAssessment(trace)), Error, trace.map((s) => s.tier).join(','));
  assert.equal(parseAssessment(cloudAssessment([step('rules'), step('local-model'), step('cloud')])).trace.length, 3);
});

const session = (id: string, generation = 1) => ({ session_id: id, generation });
const grantFor = (id: string, s: { session_id: string; generation: number }): Grant => ({
  id, ...s, source: 'native', scope: 'redacted-text', max_bytes: 2048, version: 1,
  granted_at: new Date(Date.now() - 60_000).toISOString(), expires_at: new Date(Date.now() + 3600_000).toISOString(),
});
const textFrame = (s: { session_id: string; generation: number }, consent?: Grant): TextFrame => ({
  frame_id: `f-${Math.random()}`, source: 'native', ...s, captured_at: new Date().toISOString(), ...(consent ? { consent } : {}),
  text: 'Weekly garden club newsletter with tomato tips and a compost workshop on Saturday.',
});

test('grant replay: rotating the session supersedes the old grant; replay is no_consent with zero dispatch', async () => {
  let dispatched = 0;
  const consent = new GrantRegistry();
  const cloud: CloudJudgePort = { model: 'm', available: () => true, redact: (x) => x, measure: () => ({ bytes_out: 1, payload_sha256: 'f'.repeat(64) }),
    judge: async () => { dispatched++; return { ok: true, verdict: 'unclear', reasons: [], pattern: 'other', rationale: '', bytes_out: 10, payload_sha256: 'f'.repeat(64), cost: { known: true, usd: 0.001 } }; } };
  const analyzer = new RoutedAnalyzer({ extractor: { extract: async (f) => ('text' in f ? f.text : '') }, consent, cloud,
    local: { model: 'l', available: async () => true, assess: async () => ({ risk: 'medium', reasons: ['impersonation'], cue: 'compost workshop on Saturday' }) } });
  const old = grantFor('g-old', session('s-1'));
  consent.register(old);
  consent.register(grantFor('g-new', session('s-2')));
  const replayed = await analyzer.analyze(textFrame(session('s-1'), old), new AbortController().signal);
  assert.equal(dispatched, 0);
  assert.deepEqual([replayed.trace.at(-1)?.outcome, replayed.trace.at(-1)?.failure_kind], ['skipped', 'no_consent']);
  assert.equal(consent.live(textFrame(session('s-1', 2), old), Date.now()), false, 'nor for a later generation of the old session');
});

test('client cancellation is typed: caller abort -> AnalysisCancelled, client deadline -> AnalysisTimeout', async (t) => {
  const runtime = await startServer({ port: 0, analyzer: {
    analyze: (_frame, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason))),
    capabilities: async () => [],
  } });
  t.after(() => runtime.close());
  const frame = textFrame(session('s-9'));
  const controller = new AbortController();
  const pending = new HttpAnalyzer(runtime.origin).analyze(frame, controller.signal);
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(pending, AnalysisCancelled);
  await assert.rejects(new HttpAnalyzer(runtime.origin, { timeout_ms: 60 }).analyze(frame, new AbortController().signal), AnalysisTimeout);
  assert.equal(new HttpAnalyzer(runtime.origin).timeout_ms, 22_000);
});

test('row 1: unavailable text extraction reports policy_row 1', async () => {
  const analyzer = new RoutedAnalyzer({ extractor: { extract: async () => { throw Error('OCR failed'); } } });
  const result = await analyzer.analyze(textFrame(session('s-1')), new AbortController().signal);
  assert.deepEqual([result.status, result.policy_row], ['unavailable', '1']);
});

// Rules are synchronous and not preempted: the bound is input
// capped at 32 KiB, backtracking-safe patterns, and the recorded duration.
const corpus = [
  'Your computer has been blocked. Your computer is infected with 3 viruses. Call Support immediately to unlock your computer.',
  'The court only takes gift cards for bail on weekends. Please buy\ngift cards at the pharmacy now and text me the numbers on the\nback.',
  'Medicare will never ask you to\npay with gift cards. If someone calls claiming to be from Medicare, hang up and call 1-800-MEDICARE yourself.',
  'Deals Registry Buy Again Gift Cards Customer Service Sell\nKitchen mixer\nAdd to Cart\nBuy Now',
  'Weather San Francisco 64 F Sunny\nNews Markets rally as rates hold\nSubscribe now\nSend gift cards to friends this holiday',
  'Sign in at rnicrosoft.com/account or support.microsoft.com and news.apple.com',
  'Personal invitation: Mars Colony pre-IPO allocation (48 hours). Your allocation is guaranteed at the founder\'s price.',
];
test('rules timing: p95 under 100 ms on the corpus; 32 KiB adversarial near-misses under 100 ms', () => {
  const durations: number[] = [];
  for (let round = 0; round < 20; round++) for (const text of corpus) {
    const started = performance.now();
    analyzeText(text, { frame_id: 'f', source: 'native' });
    durations.push(performance.now() - started);
  }
  durations.sort((a, b) => a - b);
  assert.ok(durations[Math.floor(durations.length * 0.95)] < 100, `p95 ${durations[Math.floor(durations.length * 0.95)]}`);
  const fill = (unit: string) => unit.repeat(Math.ceil(32_768 / unit.length)).slice(0, 32_768);
  for (const adversarial of [fill('your computer is nearly infected call support later '), fill('please buy gift card '), fill('a.'), fill('a-a.'), fill('call '), fill('pay with '), fill('microsoft-')]) {
    const started = performance.now();
    analyzeText(adversarial, { frame_id: 'f', source: 'native' });
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 100, `${adversarial.slice(0, 20)}: ${elapsed.toFixed(1)} ms`);
  }
});

test('the composite caps rules input at 32 KiB and treats the rest as truncated', async () => {
  const analyzer = new RoutedAnalyzer({ extractor: { extract: async () => `${'Garden news and tomato tips. '.repeat(2000)}` },
    local: { model: 'l', available: async () => true, assess: async () => ({ risk: 'low', reasons: [], cue: '' }) } });
  const result = await analyzer.analyze(textFrame(session('s-1')), new AbortController().signal);
  assert.equal(result.status, 'inconclusive', 'not unavailable, not a clean no_signal on partial text');
  assert.equal(result.trace[0].tier, 'rules');
  assert.ok(result.trace[0].duration_ms >= 0);
});

// One live grant: any new registration revokes every
// other grant id, even within the same session, generation and source.
test('a new grant revokes every other grant id: same session, generation and source', () => {
  const consent = new GrantRegistry();
  const s = session('s-one');
  const first = grantFor('g-first', s);
  const second = grantFor('g-second', s);
  consent.register(first);
  consent.register(second);
  assert.equal(consent.live(textFrame(s, first), Date.now()), false);
  assert.equal(consent.live(textFrame(s, second), Date.now()), true);
});

test('a new grant revokes every other grant id: same session and generation, source changed', () => {
  const consent = new GrantRegistry();
  const s = session('s-two');
  const windowGrant: Grant = { ...grantFor('g-window', s), source: 'window' };
  consent.register(windowGrant);
  consent.register(grantFor('g-native', s));
  const windowFrame = { frame_id: 'w', source: 'window' as const, image: 'x', ...s, consent: windowGrant };
  assert.equal(consent.live(windowFrame, Date.now()), false);
});
