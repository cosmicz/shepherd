import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { RecordingJudge, ReplayJudge } from '../src/adapters/replay-judge.ts';
import { RoutedAnalyzer, type CloudJudgePort } from '../src/application/routing.ts';
import { parseAssessment, type Grant, type TextFrame } from '../src/domain/assessment.ts';
import { GrantRegistry } from '../src/server/consent.ts';

const now = Date.now();
const grant: Grant = { id: 'g', session_id: 's', generation: 1, source: 'native', scope: 'redacted-text', max_bytes: 2048, version: 1, granted_at: new Date(now - 1000).toISOString(), expires_at: new Date(now + 60_000).toISOString() };
const mars = 'join the private pre-IPO\nround for Mars Colony One before it lists\npublicly. Only 200 founding allocations exist';
const frame = (text: string): TextFrame => ({ frame_id: `f-${Math.random()}`, source: 'native', session_id: 's', generation: 1, consent: grant, captured_at: new Date(now).toISOString(), text });
const live: CloudJudgePort = { model: 'anthropic/claude-opus-5', available: () => true, redact: (x) => x, measure: () => ({ bytes_out: 9, payload_sha256: 'a'.repeat(64) }),
  judge: async () => ({ ok: true, verdict: 'scam', reasons: ['investment_pressure'], pattern: 'celebrity_investment', rationale: 'private model text', bytes_out: 900, payload_sha256: 'b'.repeat(64), cost: { known: true, usd: 0.007 } }) };
function analyzer(cloud: CloudJudgePort) {
  const consent = new GrantRegistry();
  consent.register(grant);
  return new RoutedAnalyzer({ extractor: { extract: async (f) => ('text' in f ? f.text : '') }, consent, cloud,
    local: { model: 'l', available: async () => true, assess: async () => ({ risk: 'medium', reasons: ['investment_pressure'], cue: '' }) } });
}

test('record during rehearsal, replay offline: verdict served locally and labelled as replay, never as a remote call', async () => {
  const file = join(await mkdtemp(join(tmpdir(), 'shepherd-replay-')), 'cloud-replay.json');
  const recorded = await analyzer(new RecordingJudge(live, file)).analyze(frame(mars), new AbortController().signal);
  assert.equal(recorded.verdict, 'scam');
  const saved = await readFile(file, 'utf8');
  assert.ok(!saved.includes('pre-IPO') && !saved.includes('private model text'), 'no screen or model text recorded');

  const replayed = parseAssessment(await analyzer(new ReplayJudge({ file, model: 'anthropic/claude-opus-5' })).analyze(frame(mars), new AbortController().signal));
  assert.deepEqual([replayed.status, replayed.verdict, replayed.pattern], ['concern', 'scam', 'celebrity_investment']);
  assert.equal(replayed.analyzer.id === 'cloud-judge' && replayed.analyzer.model, 'replay:anthropic/claude-opus-5');
  const step = replayed.trace.at(-1);
  assert.deepEqual([step?.remote_calls, step?.bytes_out, step?.cached, step?.cost.usd], [0, 0, true, 0]);
});

test('a replay miss never invents a verdict: inconclusive with no remote call', async () => {
  const file = join(await mkdtemp(join(tmpdir(), 'shepherd-replay-')), 'empty.json');
  const result = parseAssessment(await analyzer(new ReplayJudge({ file, model: 'm' })).analyze(frame(mars), new AbortController().signal));
  assert.equal(result.status, 'inconclusive');
  assert.deepEqual([result.trace.at(-1)?.remote_calls, result.trace.at(-1)?.failure_kind], [0, 'unavailable']);
});

// the local adapter marks results computed on truncated text as
// partial; a clean local result on partial text is inconclusive, never no_signal.
test('a partial local-model result never yields no_signal', async () => {
  const consent = new GrantRegistry();
  const analyzer = new RoutedAnalyzer({ extractor: { extract: async (f) => ('text' in f ? f.text : '') }, consent,
    local: { model: 'l', available: async () => true, assess: async () => ({ risk: 'low', reasons: [], cue: '', partial: true }) } });
  const result = await analyzer.analyze(frame('Weekly garden club newsletter with tomato tips.'), new AbortController().signal);
  assert.equal(result.status, 'inconclusive');
  const whole = await new RoutedAnalyzer({ extractor: { extract: async (f) => ('text' in f ? f.text : '') }, consent,
    local: { model: 'l', available: async () => true, assess: async () => ({ risk: 'low', reasons: [], cue: '', partial: false }) } }).analyze(frame('Weekly garden club newsletter with tomato tips.'), new AbortController().signal);
  assert.equal(whole.status, 'no_signal');
});

// a 4,782-character screen whose family-emergency
// text sits after the local model's 4,096-character input cap. Through the real
// bridge the local adapter marks the result partial, so no row-12c no_signal.
test('bridge: a screen longer than the local input cap is partial and never no_signal', async () => {
  const { LlamaLocalModel } = await import('../src/adapters/llama-local.ts');
  const fetchImpl = (async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ risk: 'low', reasons: [], cue: '' }) } }] }))) as unknown as typeof fetch;
  const head = 'Weekly garden club newsletter with tomato tips and compost notes. '.repeat(72);
  const text = `${head}\nGrandma it is me, I am in jail and need bail money tonight, do not tell Mom.`;
  assert.ok(head.length > 4096 && text.length > 4700);
  const analyzer = new RoutedAnalyzer({ extractor: { extract: async () => text }, local: new LlamaLocalModel({ fetchImpl }) });
  const result = await analyzer.analyze(frame(text), new AbortController().signal);
  assert.notEqual(result.policy_row === '12c' && result.status === 'no_signal', true);
  assert.equal(result.status, 'inconclusive');
});

// a caller-aborted cloud attempt record carries its excerpt source.
test('an aborted cloud attempt record carries excerpt_source', async () => {
  const attempts: string[] = [];
  const consent = new GrantRegistry();
  consent.register(grant);
  const hang: CloudJudgePort = { model: 'm', available: () => true, redact: (x) => x, measure: () => ({ bytes_out: 5, payload_sha256: 'c'.repeat(64) }),
    judge: (_r, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason))) };
  let started!: () => void;
  const dispatched = new Promise<void>((resolve) => { started = resolve; });
  const analyzer = new RoutedAnalyzer({ extractor: { extract: async (f) => ('text' in f ? f.text : '') }, consent,
    cloud: { ...hang, judge: (r, s, f) => { started(); return hang.judge(r, s, f); } },
    local: { model: 'l', available: async () => true, assess: async () => ({ risk: 'medium', reasons: ['investment_pressure'], cue: '' }) },
    onAttempt: (step) => attempts.push(step.excerpt_source ?? 'missing') });
  const controller = new AbortController();
  const pending = analyzer.analyze(frame(mars), controller.signal);
  await dispatched;
  controller.abort();
  await assert.rejects(pending);
  assert.deepEqual(attempts, ['rules']);
});

// replays are marked as such and never counted as cache hits.
test('replayed steps are marked replayed; /trace counts them apart from cache hits', async () => {
  const { TraceHub } = await import('../src/server/trace.ts');
  const file = join(await mkdtemp(join(tmpdir(), 'shepherd-replay-')), 'empty.json');
  const result = parseAssessment(await analyzer(new ReplayJudge({ file, model: 'm' })).analyze(frame(mars), new AbortController().signal));
  assert.equal(result.trace.at(-1)?.replayed, true);
  const hub = new TraceHub();
  hub.recordAssessment(result);
  assert.deepEqual([hub.counters.cached_hits, hub.counters.replayed], [0, 1]);
});
