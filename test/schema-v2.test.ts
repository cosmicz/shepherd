import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  analyzeText, checkGrant, parseAssessment, parseEvent, toEvent,
  POLICY_VERSION, PROMPT_VERSION, SCHEMA_VERSION, type Assessment, type RouteStep,
} from '../src/domain/assessment.ts';
import { decodeFrame } from '../src/server/frame.ts';

// A response exactly as the rules-only runtime at 1d34e8a serialized it (no trace).
const legacy = {
  frame_id: 'legacy-1', source: 'example', status: 'concern', reasons: ['support_pressure'],
  evidence: ['Your computer is infected. Call support immediately'],
  message: 'This screen uses a pressure pattern. Pause and check who is asking before taking action.',
  analyzer: { id: 'local-ocr-rules', kind: 'rules', version: '1' },
  media_origin: 'not_assessed', route: 'local', duration_ms: 12,
};
const versions = { policy: POLICY_VERSION, prompt: PROMPT_VERSION, schema: SCHEMA_VERSION };
const rulesStep: RouteStep = { tier: 'rules', analyzer_id: 'local-ocr-rules', outcome: 'no_signal', duration_ms: 3, remote_calls: 0, bytes_out: 0, cost: { known: true, usd: 0 }, cached: false, versions };
const cloudStep: RouteStep = { tier: 'cloud', analyzer_id: 'cloud-judge', outcome: 'concern', duration_ms: 2400, remote_calls: 1, bytes_out: 812, payload_sha256: 'a'.repeat(64), cost: { known: true, usd: 0.0049 }, cached: false, versions };
const cloud = {
  ...legacy, frame_id: 'cloud-1', reasons: ['investment_pressure', 'impersonation'], evidence: ['guaranteed at the founder\'s price'],
  analyzer: { id: 'cloud-judge', kind: 'model', provider: 'anthropic', model: 'claude-opus-5' }, route: 'cloud',
  trace: [rulesStep, { ...rulesStep, tier: 'local-model', analyzer_id: 'local-model', outcome: 'inconclusive' }, cloudStep],
};

test('versions are the contract v2.1 values (r81)', () => {
  assert.deepEqual(versions, { policy: 3, prompt: 3, schema: 3 });
});

test('a 1d34e8a rules-only response still parses unchanged, with an empty trace', () => {
  const parsed = parseAssessment(structuredClone(legacy));
  assert.deepEqual({ ...parsed, trace: undefined }, { ...legacy, trace: undefined });
  assert.deepEqual(parsed.trace, []);
});

test('optional evidence-region accounting is additive and content-free in trace', () => {
  const parsed = parseAssessment({ ...legacy, evidence_regions: 2, trace: [{ ...rulesStep, regions: 2 }] });
  assert.equal(parsed.evidence_regions, 2);
  assert.equal(parsed.trace[0].regions, 2);
  for (const value of [
    { ...legacy, evidence_regions: -1 },
    { ...legacy, evidence_regions: 1.5 },
    { ...legacy, trace: [{ ...rulesStep, regions: -1 }] },
    { ...legacy, trace: [{ ...rulesStep, regions: 'two' }] },
  ]) assert.throws(() => parseAssessment(value));
});

test('model and cloud routes parse with their analyzer and trace', () => {
  const parsed = parseAssessment(structuredClone(cloud));
  assert.equal(parsed.route, 'cloud');
  assert.deepEqual(parsed.analyzer, cloud.analyzer);
  assert.equal(parsed.trace.length, 3);
  assert.equal(parsed.trace[2].bytes_out, 812);
  const local = parseAssessment({ ...legacy, analyzer: { id: 'local-model', kind: 'model', model: 'qwen3-8b-q4_k_m' }, route: 'local-model', reasons: ['family_emergency'],
    trace: [rulesStep, { ...rulesStep, tier: 'local-model', analyzer_id: 'local-model', outcome: 'concern' }] });
  assert.equal(local.route, 'local-model');
});

test('malformed routes, analyzers, reasons and traces are rejected', () => {
  const bad: unknown[] = [
    { ...legacy, route: 'cloud' },                                                         // route without matching analyzer
    { ...cloud, route: 'local' },
    { ...cloud, analyzer: { ...cloud.analyzer, provider: 'other' } },
    { ...cloud, analyzer: { id: 'local-model', kind: 'model' } },                          // missing model id
    { ...legacy, reasons: ['made_up'] },
    { ...cloud, trace: [rulesStep, rulesStep, rulesStep, rulesStep] },                     // more than 3 steps
    { ...cloud, trace: [{ ...rulesStep, bytes_out: 10 }] },                                // local tier sent bytes
    { ...cloud, trace: [{ ...rulesStep, remote_calls: 1 }] },
    { ...cloud, trace: [{ ...rulesStep, cost: { known: true, usd: 0.01 } }] },
    { ...cloud, trace: [{ ...cloudStep, remote_calls: 2 }] },
    { ...cloud, trace: [{ ...cloudStep, outcome: 'failed' }] },                            // failed needs failure_kind
    { ...cloud, trace: [{ ...cloudStep, failure_kind: 'timeout' }] },                      // status outcome cannot carry one
    { ...cloud, trace: [{ ...cloudStep, outcome: 'skipped', failure_kind: 'exploded' }] },
    { ...cloud, trace: [{ ...cloudStep, cost: { known: false, usd: 0.01 } }] },             // unknown cost is never priced
    { ...cloud, trace: [{ ...cloudStep, payload_sha256: 'xyz' }] },
    { ...cloud, trace: [{ ...cloudStep, bytes_out: -1 }] },
    { ...cloud, trace: [{ ...cloudStep, versions: { policy: 2, prompt: 1 } }] },
    { ...legacy, evidence: ['x'.repeat(201)] },
    { ...legacy, evidence: ['a', 'b', 'c', 'd'] },
    { ...legacy, source: 'monitor' },
    // the team F-TRACE: a model or cloud route must carry the step that decided it.
    { ...cloud, trace: undefined },
    { ...cloud, trace: [rulesStep] },
    { ...cloud, trace: [rulesStep, { ...cloudStep, outcome: 'skipped', failure_kind: 'no_consent', remote_calls: 0, bytes_out: 0, cost: { known: true, usd: 0 } }] },
    { ...legacy, analyzer: { id: 'local-model', kind: 'model', model: 'q' }, route: 'local-model' },
    { ...legacy, analyzer: { id: 'local-model', kind: 'model', model: 'q' }, route: 'local-model', trace: [rulesStep] },
  ];
  for (const value of bad) assert.throws(() => parseAssessment(structuredClone(value)), Error, JSON.stringify(value).slice(0, 160));
  // Failure kinds that are valid are accepted.
  // Row 9 shape: local-model route with the cloud tier skipped for lack of consent.
  assert.equal(parseAssessment({ ...legacy, status: 'inconclusive', reasons: [], analyzer: { id: 'local-model', kind: 'model', model: 'q' }, route: 'local-model',
    trace: [rulesStep, { ...rulesStep, tier: 'local-model', analyzer_id: 'local-model', outcome: 'inconclusive' }, { ...cloudStep, outcome: 'skipped', failure_kind: 'no_consent', remote_calls: 0, bytes_out: 0, payload_sha256: undefined, cost: { known: true, usd: 0 } }] }).trace[2].failure_kind, 'no_consent');
  assert.equal(parseAssessment({ ...cloud, trace: [{ ...cloudStep, outcome: 'failed', failure_kind: 'timeout', cost: { known: false, usd: 0 } }] }).trace[0].cost.known, false);
});

test('rules evidence spans are at most 200 characters and only the matched window', () => {
  const long = `Please buy gift cards now or your account will be closed ${'and keep reading '.repeat(20)}`;
  const result = analyzeText(`Garden club news. ${long}`, { frame_id: 'f', source: 'native' });
  assert.deepEqual(result.reasons, ['payment_pressure']);
  assert.ok(result.evidence[0].length <= 200 && result.evidence[0].includes('buy gift cards now') && !result.evidence[0].includes('Garden'));
  assert.equal(result.source, 'native');
});

test('event summaries carry the widened route and still drop evidence and trace', () => {
  const event = toEvent(parseAssessment(structuredClone(cloud)), 'shown', 'event-1', '2026-10-11T13:00:00Z');
  assert.equal(event.route, 'cloud');
  assert.ok(!('evidence' in event) && !('trace' in event));
  assert.equal(parseEvent({ ...event, route: 'local-model' }).route, 'local-model');
  assert.throws(() => parseEvent({ ...event, route: 'remote' }));
});

const session = { session_id: 'session-1', generation: 4 };
const textFrame = {
  frame_id: 'native-1', source: 'native', ...session, text: 'Your computer is infected. Call support now.',
  lines: [{ text: 'Your computer is infected.', x: 10, y: 20, w: 300, h: 18 }],
  app: 'Safari', bundle_id: 'com.apple.Safari', window_title: 'Alert', url: 'https://example.test/alert', captured_at: '2026-10-11T13:00:00Z',
  scope: 'display',
};
const grant = {
  id: 'grant-1', ...session, source: 'native', scope: 'redacted-text', max_bytes: 2048, version: 1,
  granted_at: '2026-10-11T13:00:00Z', expires_at: '2026-10-11T13:30:00Z',
};

test('decodeFrame accepts a native TextFrame and rejects malformed ones', () => {
  const decoded = decodeFrame(structuredClone(textFrame));
  assert.equal(decoded.frame.source, 'native');
  assert.equal(decoded.png, undefined);
  assert.equal(decodeFrame({ ...textFrame, url: null, lines: undefined, window_title: '' }).frame.source, 'native');
  // The native helper's Swift optionals are absent when unknown, and a blank screen yields empty text.
  const { app: _a, bundle_id: _b, window_title: _w, url: _u, scope: _sc, ...minimal } = textFrame;
  const sparse = decodeFrame({ ...minimal, text: '' }).frame;
  assert.equal(sparse.source, 'native');
  assert.ok('text' in sparse && sparse.text === '' && sparse.app === undefined && sparse.url === undefined && sparse.scope === undefined);
  assert.equal(decodeFrame(textFrame).frame.source === 'native' && (decodeFrame(textFrame).frame as { scope?: string }).scope, 'display');
  const dual = decodeFrame({ ...textFrame,
    display_text: 'A local-only notification',
    display_lines: [{ text: 'A local-only notification', x: 20, y: 30, w: 40, h: 18 }],
    evidence_regions: [{ x: 0, y: 6, w: 100, h: 80, source: 'rules' }],
  }).frame as { display_text?: string; display_lines?: unknown[]; evidence_regions?: unknown[] };
  assert.equal(dual.display_text, 'A local-only notification');
  assert.equal(dual.display_lines?.length, 1);
  assert.equal(dual.evidence_regions?.length, 1);
  const bad: unknown[] = [
    { ...textFrame, source: 'window' },
    { ...textFrame, text: 7 },
    { ...textFrame, scope: 'everything' },
    { ...textFrame, text: 'x'.repeat(32 * 1024 + 1) },
    { ...textFrame, lines: Array.from({ length: 2001 }, () => textFrame.lines[0]) },
    { ...textFrame, lines: [{ ...textFrame.lines[0], x: -1 }] },
    { ...textFrame, lines: [{ ...textFrame.lines[0], w: Number.NaN }] },
    { ...textFrame, url: 'x'.repeat(2049) },
    { ...textFrame, captured_at: 'yesterday' },
    { ...textFrame, app: 'x'.repeat(257) },
    { ...textFrame, bundle_id: 42 },
    { ...textFrame, captured_at: undefined },
    { ...textFrame, generation: -1 },
    { ...textFrame, display_text: 'x'.repeat(32 * 1024 + 1) },
    { ...textFrame, display_lines: [{ text: 'x', x: -1, y: 0, w: 1, h: 1 }] },
    { ...textFrame, evidence_regions: [{ x: 0, y: 0, w: 1, h: 1, source: 'display' }] },
    { ...textFrame, evidence_regions: [{ x: 0, y: 0, w: 0, h: 1, source: 'rules' }] },
    { frame_id: 'png-native', source: 'native', image: 'data:image/png;base64,AAAA' },
  ];
  for (const value of bad) assert.throws(() => decodeFrame(value), Error, JSON.stringify(value).slice(0, 120));
});

test('grant shape is validated at decode; bindings and expiry at dispatch', () => {
  const now = Date.parse('2026-10-11T13:10:00Z');
  const framed = decodeFrame({ ...textFrame, consent: grant }).frame;
  assert.equal(checkGrant(framed, now), 'ok');
  for (const consent of [{ ...grant, scope: 'pixels' }, { ...grant, max_bytes: 4096 }, { ...grant, version: 2 }, { ...grant, expires_at: grant.granted_at }]) {
    assert.throws(() => decodeFrame({ ...textFrame, consent }), Error, JSON.stringify(consent));
  }
  assert.equal(checkGrant(decodeFrame(textFrame).frame, now), 'no_consent', 'no grant');
  assert.equal(checkGrant(decodeFrame({ ...textFrame, consent: { ...grant, session_id: 'other' } }).frame, now), 'no_consent');
  assert.equal(checkGrant(decodeFrame({ ...textFrame, consent: { ...grant, generation: 3 } }).frame, now), 'no_consent');
  assert.equal(checkGrant(decodeFrame({ ...textFrame, consent: { ...grant, source: 'window' } }).frame, now), 'no_consent');
  assert.equal(checkGrant(framed, Date.parse(grant.expires_at)), 'no_consent', 'expired');
  const { session_id: _s, generation: _g, ...unbound } = textFrame;
  assert.equal(checkGrant(decodeFrame({ ...unbound, consent: grant }).frame, now), 'no_consent', 'frame without session envelope');
});

test('Assessment type keeps the trace for consumers', () => {
  const value: Assessment = parseAssessment(structuredClone(cloud));
  assert.equal(value.trace[0].tier, 'rules');
});
