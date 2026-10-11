import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseAssessment, type Assessment, type RouteStep, type TextFrame } from '../src/domain/assessment.ts';
import {
  AnalysisCancelled, CloudGovernor, LocalModelError, RoutedAnalyzer,
  type CloudJudgeOutcome, type CloudJudgePort, type ConsentPort, type LocalModelPort,
} from '../src/application/routing.ts';

const NOW = Date.parse('2026-10-11T13:30:00Z');
const texts = {
  strong: 'Your computer is infected. Call support now.',
  weak: 'Your account will be suspended today. Please buy gift cards now and send the codes.',
  twoWeak: 'Your account will be suspended today. Please buy gift cards now and send the codes. Sign in at paypa1-billing.com',
  none: 'Weekly garden club newsletter with tomato tips and a compost workshop on Saturday.',
  inconclusive: '',
};
let sequence = 0;
function frame(text: string, extra: Partial<TextFrame> = {}): TextFrame {
  const session = { session_id: 'session-1', generation: 3 };
  return {
    frame_id: `frame-${++sequence}`, source: 'native', ...session, text, captured_at: '2026-10-11T13:30:00Z',
    consent: { id: 'grant-1', ...session, source: 'native', scope: 'redacted-text', max_bytes: 2048, version: 1, granted_at: '2026-10-11T13:00:00Z', expires_at: '2026-10-11T14:00:00Z' },
    ...extra,
  };
}

type LocalPlan = { risk: 'low' | 'medium' | 'high'; reasons?: string[] } | 'unavailable' | 'malformed' | 'hang' | { invalid: unknown };
type CloudPlan = { verdict: 'scam' | 'suspicious' | 'benign' | 'unclear' } | { fail: 'refusal' | 'rate_limit' } | 'hang';
function harness(plan: { local?: LocalPlan; cloud?: CloudPlan; provider?: boolean; consent?: boolean | (() => boolean); governor?: CloudGovernor; extractFails?: boolean } = {}) {
  const calls = { local: 0, cloud: 0, attempts: [] as RouteStep[] };
  const local: LocalModelPort = {
    model: 'qwen3-8b-q4_k_m',
    available: async () => true,
    assess: (_text, signal) => {
      calls.local++;
      const step = plan.local ?? { risk: 'low' };
      if (step === 'hang') return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
      if (step === 'unavailable' || step === 'malformed') return Promise.reject(new LocalModelError(step));
      if ('invalid' in step) return Promise.resolve(step.invalid);
      return Promise.resolve({ risk: step.risk, reasons: step.reasons ?? (step.risk === 'low' ? [] : ['payment_pressure']), cue: 'compost workshop on Saturday' });
    },
  };
  const cloud: CloudJudgePort = {
    model: 'claude-opus-5',
    available: () => plan.provider ?? true,
    redact: (excerpt) => excerpt.replace(/\d{4,}/g, '<number>'),
    measure: () => ({ bytes_out: 777, payload_sha256: 'b'.repeat(64) }),
    judge: (_request, signal, _frame): Promise<CloudJudgeOutcome> => {
      calls.cloud++;
      const step = plan.cloud ?? { verdict: 'unclear' };
      if (step === 'hang') return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
      if ('fail' in step) return Promise.resolve({ ok: false, failure_kind: step.fail, bytes_out: 640, payload_sha256: 'c'.repeat(64), cost: { known: false, usd: 0 } });
      return Promise.resolve({ ok: true, verdict: step.verdict, reasons: step.verdict === 'scam' ? ['investment_pressure'] : [], pattern: 'celebrity_investment', rationale: 'model text', bytes_out: 812, payload_sha256: 'a'.repeat(64), cost: { known: true, usd: 0.0049 } });
    },
  };
  const consent: ConsentPort = { live: () => (typeof plan.consent === 'function' ? plan.consent() : plan.consent ?? true) };
  const analyzer = new RoutedAnalyzer({
    extractor: { extract: async (input) => { if (plan.extractFails) throw Error('OCR failed'); return 'text' in input ? input.text : ''; } },
    local, cloud, consent, governor: plan.governor, now: () => NOW,
    onAttempt: (step) => calls.attempts.push(step),
    deadlines: { local_ms: 40, cloud_ms: 40, total_ms: 200 },
  });
  return { analyzer, calls };
}
const run = (h: ReturnType<typeof harness>, input: TextFrame, signal = new AbortController().signal) => h.analyzer.analyze(input, signal);
const shape = (a: Assessment) => ({ row: a.policy_row, status: a.status, route: a.route, tiers: a.trace.map((s) => `${s.tier}:${s.outcome}${s.failure_kind ? `/${s.failure_kind}` : ''}`) });
const effects = (a: Assessment) => ({ speak: a.status === 'concern', family: a.status === 'concern' });
const remote = (a: Assessment) => a.trace.reduce((sum, s) => sum + s.remote_calls, 0);

// One case per row: route, outcome, exact adapter calls, trace and side effects.
const rows: Array<[string, Parameters<typeof harness>[0], string, { row: string; status: string; route: string; tiers: string[] }, { local: number; cloud: number; remote: number }]> = [
  ['1 rules unavailable', { extractFails: true }, texts.none, { row: undefined as never, status: 'unavailable', route: 'local', tiers: ['rules:unavailable'] }, { local: 0, cloud: 0, remote: 0 }],
  ['2 rules inconclusive', {}, texts.inconclusive, { row: '2', status: 'inconclusive', route: 'local', tiers: ['rules:inconclusive'] }, { local: 0, cloud: 0, remote: 0 }],
  ['3 strong concern', {}, texts.strong, { row: '3', status: 'concern', route: 'local', tiers: ['rules:concern'] }, { local: 0, cloud: 0, remote: 0 }],
  ['4 weak, local unavailable, gate open', { local: 'unavailable', cloud: { verdict: 'scam' } }, texts.weak, { row: '13', status: 'concern', route: 'cloud', tiers: ['rules:concern', 'local-model:failed/unavailable', 'cloud:concern'] }, { local: 1, cloud: 1, remote: 1 }],
  ['5 weak, local unavailable, no grant', { local: 'unavailable', consent: false }, texts.weak, { row: '5', status: 'inconclusive', route: 'local', tiers: ['rules:concern', 'local-model:failed/unavailable', 'cloud:skipped/no_consent'] }, { local: 1, cloud: 0, remote: 0 }],
  ['6 no signal, local malformed', { local: 'malformed' }, texts.none, { row: '6', status: 'inconclusive', route: 'local', tiers: ['rules:no_signal', 'local-model:failed/malformed'] }, { local: 1, cloud: 0, remote: 0 }],
  ['7 weak, local high', { local: { risk: 'high' } }, texts.weak, { row: '7', status: 'concern', route: 'local-model', tiers: ['rules:concern', 'local-model:concern'] }, { local: 1, cloud: 0, remote: 0 }],
  ['8 weak, local medium, gate open', { local: { risk: 'medium' }, cloud: { verdict: 'suspicious' } }, texts.weak, { row: '14', status: 'concern', route: 'cloud', tiers: ['rules:concern', 'local-model:inconclusive', 'cloud:concern'] }, { local: 1, cloud: 1, remote: 1 }],
  ['9 weak, local medium, no grant', { local: { risk: 'medium' }, consent: false }, texts.weak, { row: '9', status: 'inconclusive', route: 'local-model', tiers: ['rules:concern', 'local-model:inconclusive', 'cloud:skipped/no_consent'] }, { local: 1, cloud: 0, remote: 0 }],
  ['10 weak, local low, gate open', { local: { risk: 'low' }, cloud: { verdict: 'benign' } }, texts.weak, { row: '15', status: 'inconclusive', route: 'cloud', tiers: ['rules:concern', 'local-model:no_signal', 'cloud:inconclusive'] }, { local: 1, cloud: 1, remote: 1 }],
  ['11 weak, local low, no grant', { local: { risk: 'low' }, consent: false }, texts.weak, { row: '11', status: 'inconclusive', route: 'local-model', tiers: ['rules:concern', 'local-model:no_signal', 'cloud:skipped/no_consent'] }, { local: 1, cloud: 0, remote: 0 }],
  ['12 no signal, local medium, gate open', { local: { risk: 'medium' }, cloud: { verdict: 'scam' } }, texts.none, { row: '13', status: 'concern', route: 'cloud', tiers: ['rules:no_signal', 'local-model:inconclusive', 'cloud:concern'] }, { local: 1, cloud: 1, remote: 1 }],
  ['12b no signal, local high, no grant', { local: { risk: 'high' }, consent: false }, texts.none, { row: '12b', status: 'inconclusive', route: 'local-model', tiers: ['rules:no_signal', 'local-model:concern', 'cloud:skipped/no_consent'] }, { local: 1, cloud: 0, remote: 0 }],
  ['12c no signal, local low', { local: { risk: 'low' } }, texts.none, { row: '12c', status: 'no_signal', route: 'local-model', tiers: ['rules:no_signal', 'local-model:no_signal'] }, { local: 1, cloud: 0, remote: 0 }],
  ['15 benign clears a clean page', { local: { risk: 'medium' }, cloud: { verdict: 'benign' } }, texts.none, { row: '15', status: 'no_signal', route: 'cloud', tiers: ['rules:no_signal', 'local-model:inconclusive', 'cloud:no_signal'] }, { local: 1, cloud: 1, remote: 1 }],
  ['16 unclear', { local: { risk: 'medium' }, cloud: { verdict: 'unclear' } }, texts.none, { row: '16', status: 'inconclusive', route: 'cloud', tiers: ['rules:no_signal', 'local-model:inconclusive', 'cloud:inconclusive'] }, { local: 1, cloud: 1, remote: 1 }],
  ['17 cloud refusal', { local: { risk: 'medium' }, cloud: { fail: 'refusal' } }, texts.none, { row: '17', status: 'inconclusive', route: 'cloud', tiers: ['rules:no_signal', 'local-model:inconclusive', 'cloud:failed/refusal'] }, { local: 1, cloud: 1, remote: 1 }],
  ['18 provider unavailable', { local: { risk: 'medium' }, provider: false }, texts.weak, { row: '9', status: 'inconclusive', route: 'local-model', tiers: ['rules:concern', 'local-model:inconclusive', 'cloud:skipped/unavailable'] }, { local: 1, cloud: 0, remote: 0 }],
];

for (const [name, plan, text, expected, counts] of rows) {
  test(`composite row ${name}`, async () => {
    const h = harness(plan);
    const result = parseAssessment(await run(h, frame(text)));
    const got = shape(result);
    if (expected.row === undefined) delete (got as { row?: string }).row;
    assert.deepEqual(got, expected.row === undefined ? { status: expected.status, route: expected.route, tiers: expected.tiers } : expected);
    assert.deepEqual({ local: h.calls.local, cloud: h.calls.cloud, remote: remote(result) }, counts);
    assert.deepEqual(effects(result), { speak: expected.status === 'concern', family: expected.status === 'concern' });
    for (const step of result.trace) if (step.tier !== 'cloud') assert.deepEqual([step.remote_calls, step.bytes_out, step.cost], [0, 0, { known: true, usd: 0 }]);
    if (counts.cloud) {
      const cloud = result.trace.at(-1) as RouteStep;
      assert.ok(cloud.bytes_out > 0 && cloud.payload_sha256 && cloud.remote_calls === 1);
    }
    if (result.status === 'concern') assert.ok(result.reasons.length > 0);
  });
}

test('row 19: abort while the local model runs yields AnalysisCancelled, zero cloud calls', async () => {
  const h = harness({ local: 'hang' });
  const controller = new AbortController();
  const pending = run(h, frame(texts.weak), controller.signal);
  setTimeout(() => controller.abort(), 5);
  await assert.rejects(pending, AnalysisCancelled);
  assert.equal(h.calls.cloud, 0);
});

test('abort while OCR or text extraction runs is a cancellation, not unavailable', async () => {
  const analyzer = new RoutedAnalyzer({
    extractor: { extract: (_frame, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason))) },
    now: () => NOW,
  });
  const controller = new AbortController();
  const pending = analyzer.analyze(frame(texts.strong), controller.signal);
  setTimeout(() => controller.abort(), 5);
  await assert.rejects(pending, AnalysisCancelled);
});

test('abort before anything runs is a cancellation, not unavailable', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(run(harness(), frame(texts.strong), controller.signal), AnalysisCancelled);
});

test('revocation after the local result but before dispatch makes zero cloud calls', async () => {
  let checks = 0;
  const h = harness({ local: { risk: 'medium' }, consent: () => ++checks === 1 });
  const result = await run(h, frame(texts.weak));
  assert.equal(h.calls.cloud, 0);
  assert.deepEqual(shape(result).tiers.at(-1), 'cloud:skipped/no_consent');
  assert.equal(result.status, 'inconclusive');
});

test('revocation during the cloud call aborts it: no assessment, attempt still accounted', async () => {
  const h = harness({ local: { risk: 'medium' }, cloud: 'hang' });
  const controller = new AbortController();
  const pending = run(h, frame(texts.weak), controller.signal);
  setTimeout(() => controller.abort(), 5);
  await assert.rejects(pending, AnalysisCancelled);
  assert.equal(h.calls.cloud, 1);
  assert.equal(h.calls.attempts.length, 1);
  assert.deepEqual([h.calls.attempts[0].remote_calls, h.calls.attempts[0].bytes_out, h.calls.attempts[0].cost.known], [1, 777, false]);
});

test('local timeout with no grant: inconclusive, zero remote calls; late result discarded', async () => {
  const h = harness({ local: 'hang', consent: false });
  const result = await run(h, frame(texts.weak));
  assert.equal(result.status, 'inconclusive');
  assert.equal(remote(result), 0);
  assert.equal(shape(result).tiers[1], 'local-model:failed/timeout');
});

test('grant present but cloud unavailable, timing out or refusing is never no_signal', async () => {
  for (const plan of [{ provider: false }, { cloud: 'hang' as const }, { cloud: { fail: 'refusal' as const } }]) {
    const result = await run(harness({ local: { risk: 'medium' }, ...plan }), frame(texts.none));
    assert.equal(result.status, 'inconclusive', JSON.stringify(plan));
  }
  const timedOut = await run(harness({ local: { risk: 'medium' }, cloud: 'hang' }), frame(texts.none));
  assert.equal(shape(timedOut).tiers.at(-1), 'cloud:failed/timeout');
  assert.equal(timedOut.trace.at(-1)?.bytes_out, 777);
});

test('two weak cues never become a local concern', async () => {
  const result = await run(harness({ local: { risk: 'low' }, consent: false }), frame(texts.twoWeak));
  assert.equal(result.status, 'inconclusive');
  assert.equal(result.policy_row, '11');
});

test('high risk with no reasons is a malformed local result', async () => {
  const result = await run(harness({ local: { invalid: { risk: 'high', reasons: [], cue: '' } }, consent: false }), frame(texts.weak));
  assert.equal(shape(result).tiers[1], 'local-model:failed/malformed');
  assert.equal(result.policy_row, '5');
});

test('repeated identical uncertain frames hit the cache; distinct ones stop at the budget', async () => {
  const governor = new CloudGovernor();
  const same = harness({ local: { risk: 'medium' }, cloud: { verdict: 'unclear' }, governor });
  for (let i = 0; i < 10; i++) await run(same, frame(texts.none));
  assert.equal(same.calls.cloud, 1);
  const budget = harness({ local: { risk: 'medium' }, cloud: { verdict: 'unclear' }, governor: new CloudGovernor() });
  const results = [];
  for (let i = 0; i < 10; i++) results.push(await run(budget, frame(`${texts.none} item ${i} ${'x'.repeat(i)}`)));
  assert.equal(budget.calls.cloud, 6);
  assert.deepEqual(shape(results[9]).tiers.at(-1), 'cloud:skipped/budget');
});

test('a clean result on a truncated native frame is inconclusive', async () => {
  const result = await run(harness({ local: { risk: 'low' } }), frame(texts.none, { truncated: true }));
  assert.equal(result.status, 'inconclusive');
});

test('cloud concern names closed codes and pattern; model text is never the message', async () => {
  const result = await run(harness({ local: { risk: 'medium' }, cloud: { verdict: 'scam' } }), frame(texts.none));
  assert.deepEqual([result.verdict, result.pattern], ['scam', 'celebrity_investment']);
  assert.ok(!result.message.includes('model text'));
  assert.ok(result.reasons.includes('investment_pressure'));
});
