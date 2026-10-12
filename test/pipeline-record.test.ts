// u6w: the routed analyzer's local-only pipeline record. Built only when the
// runtime asks (journal on); never part of the Assessment, trace or SSE.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CloudGovernor, RoutedAnalyzer, type CloudJudgeOutcome, type CloudJudgePort, type LocalModelPort } from '../src/application/routing.ts';
import type { TextFrame } from '../src/domain/assessment.ts';
import type { PipelineRecord } from '../src/domain/pipeline.ts';

const NOW = Date.parse('2026-10-11T16:00:00Z');
const session = { session_id: 's-p', generation: 1 };
const grant = { id: 'g-p', ...session, source: 'native' as const, scope: 'redacted-text' as const, max_bytes: 2048 as const, version: 1 as const, granted_at: '2026-10-11T15:00:00Z', expires_at: '2026-10-11T17:00:00Z' };
// Weak rules signal with a number the redaction removes.
const weak = 'Your account 99881234 will be suspended today. Please buy gift cards now and send the codes.';
let sequence = 0;
const frame = (text: string): TextFrame => ({ frame_id: `p-${++sequence}`, source: 'native', ...session, consent: grant, text, captured_at: '2026-10-11T16:00:00Z' });

function routed(options: { local: unknown; cloud?: Extract<CloudJudgeOutcome, { ok: true }>; record?: (r: PipelineRecord) => void; governor?: CloudGovernor }) {
  const local: LocalModelPort = { model: 'fake-local', available: async () => true, assess: async () => options.local };
  const cloud: CloudJudgePort = {
    model: 'fake-cloud', available: () => true, redact: (excerpt) => excerpt.replace(/\d{4,}/g, '<number>'),
    measure: () => ({ bytes_out: 321, payload_sha256: 'e'.repeat(64) }),
    judge: async () => { if (!options.cloud) throw Error('no cloud'); return options.cloud; },
  };
  return new RoutedAnalyzer({ extractor: { extract: async (f) => ('text' in f ? f.text : '') }, local, cloud, consent: { live: () => true },
    now: () => NOW, governor: options.governor, onPipeline: options.record });
}
const verdict: Extract<CloudJudgeOutcome, { ok: true }> = { ok: true, verdict: 'scam', reasons: ['payment_pressure'], pattern: 'other', rationale: 'Asks for gift cards.', bytes_out: 640, payload_sha256: 'f'.repeat(64), cost: { known: true, usd: 0.0049 } };

test('no pipeline record is built unless the runtime asks for one', async () => {
  const result = await routed({ local: { risk: 'medium', reasons: ['payment_pressure'], cue: '' }, cloud: verdict }).analyze(frame(weak), new AbortController().signal);
  assert.equal(result.policy_row, '13');
  assert.equal(JSON.stringify(result).includes('Asks for gift cards'), false, 'model rationale never enters the Assessment');
});

test('rules, local and cloud tiers record what each actually received and returned', async () => {
  const records: PipelineRecord[] = [];
  const raw = { risk: 'medium', reasons: ['payment_pressure', 'unknown_thing'], cue: '' };
  const result = await routed({ local: raw, cloud: verdict, record: (r) => records.push(r) }).analyze(frame(weak), new AbortController().signal);
  assert.equal(records.length, 1);
  const [record] = records;
  assert.equal(record.frame_id, result.frame_id);
  assert.deepEqual(record.tiers.map((t) => t.tier), ['rules', 'local-model', 'cloud']);
  const [rules, local, cloud] = record.tiers;
  assert.ok(rules.tier === 'rules' && rules.output.reasons.includes('payment_pressure') && rules.input.text_characters === weak.length);
  assert.ok(local.tier === 'local-model');
  assert.deepEqual(local.output.raw, raw, 'the raw reply, before validation');
  assert.deepEqual(local.output.parsed, { risk: 'medium', reasons: ['payment_pressure'], cue: '' });
  assert.equal(local.input.text, weak);
  assert.ok(cloud.tier === 'cloud');
  // Excerpt contract v3: only the rules' matched span leaves, redacted.
  assert.equal(cloud.input.excerpt, 'Please buy gift cards now');
  assert.equal(cloud.input.excerpt_source, 'rules');
  assert.doesNotMatch(cloud.input.excerpt, /\d{4,}/);
  assert.deepEqual([cloud.input.payload_sha256, cloud.input.bytes_out, cloud.cached, cloud.output.dispatched], ['f'.repeat(64), 640, false, true]);
  assert.deepEqual([cloud.output.verdict, cloud.output.pattern, cloud.output.rationale], ['scam', 'other', { model_text: 'Asks for gift cards.' }]);
  assert.deepEqual(record.gate, { grant: true, provider: true, budget: true, anchor: true });
  assert.deepEqual(record.decision, { row: '13', status: 'concern', route: 'cloud', message: 'scam' });
  for (const tier of record.tiers) assert.ok(Number.isFinite(Date.parse(tier.started_at)) && tier.duration_ms >= 0);
});

test('a malformed local reply keeps its raw value and the failure kind', async () => {
  const records: PipelineRecord[] = [];
  const raw = { risk: 'high', reasons: [], cue: 'not on the page at all' };
  await routed({ local: raw, record: (r) => records.push(r) }).analyze(frame('Weekly garden club newsletter with tomato tips.'), new AbortController().signal);
  const local = records[0].tiers[1];
  assert.ok(local.tier === 'local-model');
  assert.deepEqual([local.output.raw, local.output.parsed, local.output.failure_kind], [raw, undefined, 'malformed']);
  assert.deepEqual(records[0].decision, { row: '6', status: 'inconclusive', route: 'local', message: 'default' });
});

test('a cache hit is recorded as cached and not dispatched', async () => {
  const records: PipelineRecord[] = [];
  const governor = new CloudGovernor();
  const analyzer = routed({ local: { risk: 'medium', reasons: ['payment_pressure'], cue: '' }, cloud: verdict, record: (r) => records.push(r), governor });
  await analyzer.analyze(frame(weak), new AbortController().signal);
  await analyzer.analyze(frame(weak), new AbortController().signal);
  const cloud = records[1].tiers[2];
  assert.ok(cloud.tier === 'cloud');
  assert.deepEqual([cloud.cached, cloud.output.dispatched, cloud.input.bytes_out], [true, false, 0]);
});

test('a failing pipeline sink never changes the analysis', async () => {
  const result = await routed({ local: { risk: 'low', reasons: [], cue: '' }, record: () => { throw Error('journal full'); } })
    .analyze(frame('Weekly garden club newsletter with tomato tips.'), new AbortController().signal);
  assert.equal(result.policy_row, '12c');
});
