// a cloud attempt the adapter refuses before dispatch
// (its own grant re-check) sent nothing, so it is a skipped no_consent step with
// zero calls and bytes, no budget use and no /trace attempt; never failed/network.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OpenRouterJudge } from '../src/adapters/openrouter-judge.ts';
import { CloudGovernor, RoutedAnalyzer, type CloudJudgePort } from '../src/application/routing.ts';
import { parseAssessment, type Grant, type RouteStep, type TextFrame } from '../src/domain/assessment.ts';
import { TraceHub } from '../src/server/trace.ts';

// Weak rules signal, so a rules span anchors the excerpt and routing asks the cloud.
const weak = 'Your account will be suspended today. Please buy gift cards now and send the codes.';
const session = { session_id: 's-r2', generation: 1 };
// The grant expired a second ago by the adapter's wall clock, while routing's
// injected clock still sees it live: the race window between the two checks.
const expires = Date.now() - 1000;
const grant: Grant = { id: 'g-r2', ...session, source: 'native', scope: 'redacted-text', max_bytes: 2048, version: 1,
  granted_at: new Date(expires - 3600_000).toISOString(), expires_at: new Date(expires).toISOString() };
const frame = (id: string): TextFrame => ({ frame_id: id, source: 'native', ...session, consent: grant, text: weak, captured_at: new Date(expires - 60_000).toISOString() });

function harness(cloud: CloudJudgePort, governor = new CloudGovernor()) {
  const attempts: RouteStep[] = [];
  const analyzer = new RoutedAnalyzer({
    extractor: { extract: async (f) => ('text' in f ? f.text : '') },
    local: { model: 'l', available: async () => true, assess: async () => ({ risk: 'medium', reasons: ['payment_pressure'], cue: '' }) },
    cloud, consent: { live: () => true }, governor, now: () => expires - 60_000, onAttempt: (step) => attempts.push(step),
  });
  return { analyzer, attempts };
}

test('grant expiring between the routing gate and the adapter re-check: skipped no_consent, zero calls, no /trace attempt', async () => {
  let transported = 0;
  const judge = new OpenRouterJudge({ model: 'anthropic/claude-opus-5', transport: async () => { transported++; throw Error('must not dispatch'); } });
  const governor = new CloudGovernor({ per_window: 1, window_ms: 600_000, usd_per_day: 0.5, unknown_usd: 0.02, cache_ttl_ms: 600_000, cache_size: 50 });
  const { analyzer, attempts } = harness(judge, governor);
  const result = parseAssessment(await analyzer.analyze(frame('f-r2'), new AbortController().signal));
  assert.equal(transported, 0);
  assert.deepEqual([result.policy_row, result.status, result.route], ['9', 'inconclusive', 'local-model']);
  const cloud = result.trace.filter((step) => step.tier === 'cloud');
  assert.deepEqual(cloud.map((s) => [s.outcome, s.failure_kind, s.remote_calls, s.bytes_out, s.payload_sha256]), [['skipped', 'no_consent', 0, 0, undefined]]);
  assert.equal(attempts.length, 0, 'no /trace attempt for a request that never left');
  const hub = new TraceHub();
  for (const step of attempts) hub.recordAttempt(step);
  hub.recordAssessment(result);
  assert.deepEqual([hub.counters.remote_calls, hub.counters.bytes_out, hub.counters.cost_unknown_attempts], [0, 0, 0]);
  // Nothing was dispatched, so the one-call budget is still available.
  assert.equal(governor.allows(expires - 60_000), true);
});

test('a dispatched cloud failure still counts one call and its bytes', async () => {
  const live: Grant = { ...grant, expires_at: new Date(Date.now() + 3600_000).toISOString() };
  const judge = new OpenRouterJudge({ model: 'anthropic/claude-opus-5', transport: async () => { throw Error('HTTP 503'); } });
  const { analyzer, attempts } = harness(judge);
  const result = await analyzer.analyze({ ...frame('f-r2-sent'), consent: live }, new AbortController().signal);
  const cloud = result.trace.filter((step) => step.tier === 'cloud');
  assert.deepEqual(cloud.map((s) => [s.outcome, s.remote_calls]), [['failed', 1]]);
  assert.ok(cloud[0].bytes_out > 0);
  assert.equal(attempts.length, 1);
});
