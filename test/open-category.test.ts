// Contract v2.1 open category: a concern outside the named
// categories surfaces as other_concern, never as a familiar label it is not.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyzeText, parseAssessment, toEvent, type Assessment, type Frame, type Pattern, type TextFrame } from '../src/domain/assessment.ts';
import { demoPersona } from '../src/domain/persona.ts';
import { decide } from '../src/domain/policy.ts';
import { patternOf, speechKind, speechText } from '../src/domain/templates.ts';
import { patternReason, RoutedAnalyzer, type CloudJudgeOutcome, type CloudJudgePort, type LocalModelPort } from '../src/application/routing.ts';
import { Session, type CaptureHandle } from '../src/application/session.ts';

const NOW = Date.parse('2026-10-11T14:40:00Z');
const session = { session_id: 'session-oc', generation: 1 };
const grant = { id: 'grant-oc', ...session, source: 'native' as const, scope: 'redacted-text' as const, max_bytes: 2048 as const, version: 1 as const, granted_at: '2026-10-11T14:00:00Z', expires_at: '2026-10-11T15:00:00Z' };
let sequence = 0;
const frame = (text: string, extra: Partial<TextFrame> = {}): TextFrame => ({
  frame_id: `oc-${++sequence}`, source: 'native', ...session, text, captured_at: '2026-10-11T14:40:00Z', ...extra,
});

// A novel attack no rule names: identity documents and card images for a parking spot.
const novel = 'Hello neighbour, the building portal is moving. Please verify your account by uploading a photo of your passport and both sides of your bank card to keep your parking spot.';
const cue = 'uploading a photo of your passport and both sides of your bank card';
const benign = 'Weekly garden club newsletter with tomato tips and a compost workshop on Saturday.';

function routed(options: { local: unknown; cloud?: Extract<CloudJudgeOutcome, { ok: true }>; consent?: boolean; quoteExcerpts?: boolean }) {
  const calls = { cloud: 0 };
  const local: LocalModelPort = { model: 'fake-local', available: async () => true, assess: async () => options.local };
  const cloud: CloudJudgePort = {
    model: 'fake-cloud', available: () => true, redact: (excerpt) => excerpt,
    measure: () => ({ bytes_out: 100, payload_sha256: 'd'.repeat(64) }),
    judge: async () => { calls.cloud++; if (!options.cloud) throw Error('unexpected cloud call'); return options.cloud; },
  };
  const analyzer = new RoutedAnalyzer({
    extractor: { extract: async (input) => ('text' in input ? input.text : '') },
    local, cloud, consent: { live: () => options.consent ?? false }, now: () => NOW, quoteExcerpts: options.quoteExcerpts,
  });
  return { analyzer, calls };
}
const run = (r: ReturnType<typeof routed>, input: TextFrame) => r.analyzer.analyze(input, new AbortController().signal);
const egress = (a: Assessment) => ({ remote_calls: a.trace.reduce((n, s) => n + s.remote_calls, 0), bytes_out: a.trace.reduce((n, s) => n + s.bytes_out, 0) });
const tiers = (a: Assessment) => a.trace.map((s) => `${s.tier}:${s.outcome}${s.failure_kind ? `/${s.failure_kind}` : ''}`);

// The fallback runs only when no tier named a reason. Before the open-category change no routed
// concern reaches it (rules or local reasons are always present), so the bug was
// latent; the mapping itself is the contract.
test('cloud pattern other maps to other_concern, never impersonation', () => {
  assert.equal(patternReason.other, 'other_concern');
  for (const [pattern, reason] of Object.entries(patternReason)) {
    if (reason === 'impersonation') assert.equal(pattern, 'government_impersonation');
  }
});

test('the novel fixture matches no rule', () => {
  assert.equal(analyzeText(novel, { frame_id: 'x', source: 'native' }).status, 'no_signal');
});

test('row 12d: novel threat, local high other_concern with a verbatim cue, no consent -> spoken caution, zero egress', async () => {
  const r = routed({ local: { risk: 'high', reasons: ['other_concern'], cue } });
  const a = parseAssessment(await run(r, frame(novel)));
  assert.deepEqual([a.policy_row, a.status, a.route], ['12d', 'concern', 'local-model']);
  assert.deepEqual(a.reasons, ['other_concern']);
  assert.deepEqual(egress(a), { remote_calls: 0, bytes_out: 0 });
  assert.equal(r.calls.cloud, 0);
  assert.deepEqual(tiers(a), ['rules:no_signal', 'local-model:concern', 'cloud:skipped/no_consent']);
  assert.equal(patternOf(a), 'other');
  assert.equal(speechKind(a), 'suspicious');
  assert.equal(speechText('suspicious', patternOf(a), {}), 'This page has signs of pressure to act quickly or share something private. Pause and check with someone you trust before doing anything.');
  // History records it with the open category.
  assert.deepEqual(toEvent(a, 'shown', 'e-1', '2026-10-11T14:40:00.000Z').reasons, ['other_concern']);
});

test('row 12d with a live grant but the quote path off: no excerpt is possible, so it settles locally', async () => {
  const r = routed({ local: { risk: 'high', reasons: ['other_concern'], cue }, consent: true });
  const a = await run(r, frame(novel, { consent: grant }));
  assert.deepEqual([a.policy_row, a.status, a.route], ['12d', 'concern', 'local-model']);
  assert.deepEqual(tiers(a), ['rules:no_signal', 'local-model:concern', 'cloud:skipped/no_anchor']);
  assert.deepEqual(egress(a), { remote_calls: 0, bytes_out: 0 });
  assert.equal(r.calls.cloud, 0);
});

test('row 12 still asks the cloud when the quote path is on and the quote carries a pressure term', async () => {
  const pressing = 'verify your account by uploading a photo of your passport';
  const r = routed({
    local: { risk: 'high', reasons: ['other_concern'], cue: pressing }, consent: true, quoteExcerpts: true,
    cloud: { ok: true, verdict: 'suspicious', reasons: [], pattern: 'other', rationale: 'model text', bytes_out: 100, payload_sha256: 'd'.repeat(64), cost: { known: true, usd: 0.004 } },
  });
  const a = await run(r, frame(novel, { consent: grant }));
  assert.equal(r.calls.cloud, 1);
  assert.deepEqual([a.policy_row, a.status, a.route], ['14', 'concern', 'cloud']);
  assert.ok(a.reasons.includes('other_concern') && !a.reasons.includes('impersonation'));
});

test('other_concern without a valid cue is malformed: inconclusive, not a concern', async () => {
  for (const bad of ['a photo of your driving licence please', '', 'bank']) {
    const a = await run(routed({ local: { risk: 'high', reasons: ['other_concern'], cue: bad } }), frame(novel));
    assert.deepEqual([a.policy_row, a.status], ['6', 'inconclusive'], `cue ${JSON.stringify(bad)}`);
    assert.deepEqual(tiers(a), ['rules:no_signal', 'local-model:failed/malformed']);
  }
});

test('unknown reason strings are dropped; with none left a valid cue makes other_concern, else malformed', async () => {
  const kept = await run(routed({ local: { risk: 'high', reasons: ['qr_code_parking_scam'], cue } }), frame(novel));
  assert.deepEqual([kept.policy_row, kept.status, kept.reasons], ['12d', 'concern', ['other_concern']]);
  const dropped = await run(routed({ local: { risk: 'high', reasons: ['qr_code_parking_scam'], cue: 'not on the page at all' } }), frame(novel));
  assert.deepEqual([dropped.policy_row, dropped.status], ['6', 'inconclusive']);
  // A known reason survives beside an unknown one and keeps its usual row (12b without consent).
  const mixed = await run(routed({ local: { risk: 'high', reasons: ['payment_pressure', 'qr_code_parking_scam'], cue: '' } }), frame(novel));
  assert.deepEqual([mixed.policy_row, mixed.status], ['12b', 'inconclusive']);
  // Non-string reasons are still malformed.
  const junk = await run(routed({ local: { risk: 'high', reasons: [42], cue } }), frame(novel));
  assert.deepEqual([junk.policy_row, junk.status], ['6', 'inconclusive']);
});

test('local medium with other_concern keeps row 12b; low stays no_signal on a benign page', async () => {
  const medium = await run(routed({ local: { risk: 'medium', reasons: ['other_concern'], cue } }), frame(novel));
  assert.deepEqual([medium.policy_row, medium.status], ['12b', 'inconclusive']);
  const low = await run(routed({ local: { risk: 'low', reasons: [], cue: '' } }), frame(benign));
  assert.deepEqual([low.policy_row, low.status], ['12c', 'no_signal']);
});

test('policy: 12d only for rules no_signal + local high + other_concern behind a closed gate', () => {
  const none = { status: 'no_signal' as const, reasons: [] };
  const high = { kind: 'result' as const, risk: 'high' as const, reasons: ['other_concern' as const] };
  const closed = { grant: false, provider: true, budget: true };
  assert.deepEqual(decide({ rules: none, local: high, gate: closed }), { kind: 'final', row: '12d', status: 'concern', route: 'local-model', message: 'caution', skipped: 'no_consent' });
  assert.deepEqual(decide({ rules: none, local: high, gate: { grant: true, provider: true, budget: true } }), { kind: 'call-cloud', row: '12' });
  assert.equal((decide({ rules: none, local: { ...high, reasons: ['payment_pressure'] }, gate: closed }) as { row: string }).row, '12b');
  // A weak rules concern with local high is row 7 regardless of other_concern.
  assert.equal((decide({ rules: { status: 'concern', reasons: ['payment_pressure'] }, local: high, gate: closed }) as { row: string }).row, '7');
});

async function sessionOutcome(assessment: Assessment) {
  const spoken: string[] = [];
  const alerts: Pattern[] = [];
  const appended: string[] = [];
  const input: Frame = { frame_id: assessment.frame_id, source: 'native', text: novel, captured_at: '2026-10-11T14:40:00Z' };
  const capture: CaptureHandle = { source: 'native', frame: async () => input, stop: () => {}, onEnded: () => {} };
  const s = new Session({
    analyze: async () => assessment, append: (event) => { appended.push(event.reasons.join(',')); }, speak: (text) => { spoken.push(text); },
    cancelSpeech: () => {}, onChange: () => {}, interval_ms: 0, persona: demoPersona, notifyFamily: async (pattern) => { alerts.push(pattern); },
  });
  s.setPreferences({ history: true, speech: true, family: true });
  await s.start(async () => capture);
  return { spoken: spoken.length, alerts: alerts.length, appended };
}

test('row 12d speaks and records history but never alerts family; row 7 still alerts', async () => {
  const a = await run(routed({ local: { risk: 'high', reasons: ['other_concern'], cue } }), frame(novel));
  assert.deepEqual(await sessionOutcome(a), { spoken: 1, alerts: 0, appended: ['other_concern'] });
  const row7 = await run(routed({ local: { risk: 'high', reasons: ['payment_pressure'], cue: '' } }), frame('Your account will be suspended today. Please buy gift cards now and send the codes.'));
  assert.equal(row7.policy_row, '7');
  assert.equal((await sessionOutcome(row7)).alerts, 1);
});
