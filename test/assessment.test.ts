import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyzeText, makeUnavailable, parseAssessment, toEvent } from '../src/domain/assessment.ts';

const context = { frame_id: 'frame-1', source: 'example' as const };

test('support pressure produces a supported, bounded concern', () => {
  const result = analyzeText('Your computer is infected. Call support immediately. Do not close this window.', context);
  assert.equal(result.status, 'concern');
  assert.deepEqual(result.reasons, ['support_pressure']);
  assert.equal(result.analyzer.kind, 'rules');
  assert.equal(result.media_origin, 'not_assessed');
  assert.ok(result.evidence.length > 0);
});

test('benign and unreadable input are different outcomes', () => {
  assert.equal(analyzeText('Welcome to the neighborhood garden newsletter.', context).status, 'no_signal');
  assert.equal(analyzeText(' \n ', context).status, 'inconclusive');
  assert.equal(makeUnavailable(context).status, 'unavailable');
});

test('an isolated topic or prevention advice is not a pressure match', () => {
  assert.equal(analyzeText('This article explains computer viruses.', context).status, 'no_signal');
  assert.equal(analyzeText('Never pay with gift cards. Do not share your password.', context).status, 'no_signal');
  assert.equal(analyzeText('Pay immediately using gift cards to prevent your account closing.', context).status, 'concern');
});

test('malformed or inconsistent provider responses are rejected', () => {
  const result = analyzeText('Welcome to the garden newsletter.', context);
  assert.equal(parseAssessment(result).status, 'no_signal');
  assert.throws(() => parseAssessment({ ...result, status: 'safe' }));
  assert.throws(() => parseAssessment({ ...result, status: 'no_signal', reasons: ['support_pressure'] }));
  assert.throws(() => parseAssessment({ ...result, duration_ms: NaN }));
  assert.throws(() => parseAssessment({ ...result, analyzer: { kind: 'model' } }));
});

test('persistent summaries cannot contain transient evidence or arbitrary page text', () => {
  const result = analyzeText('Your computer is infected. Call support immediately. Do not close this window.', context);
  result.evidence.push('PRIVATE ACCOUNT 123456');
  const event = toEvent(result, 'shown', 'event-1', '2026-10-11T12:00:00Z');
  assert.deepEqual(Object.keys(event).sort(), ['action', 'created_at', 'duration_ms', 'id', 'reasons', 'source', 'status', 'route'].sort());
  assert.ok(!JSON.stringify(event).includes('PRIVATE'));
});

test('validation rejects unbounded evidence and unsupported routing or provenance', () => {
  const result = analyzeText('Welcome to the garden newsletter.', context);
  assert.throws(() => parseAssessment({ ...result, route: 'cloud' }));
  assert.throws(() => parseAssessment({ ...result, evidence: ['x'.repeat(513)] }));
  assert.throws(() => parseAssessment({ ...result, media_origin: 'authentic' }));
  assert.throws(() => parseAssessment({ ...result, message: 'x'.repeat(513) }));
});

test('unavailable assessments do not copy private frame payloads', () => {
  const frame = { ...context, image: 'PRIVATE PIXELS' };
  assert.ok(!JSON.stringify(makeUnavailable(frame)).includes('PRIVATE'));
  assert.ok(!JSON.stringify(analyzeText('Garden newsletter.', frame)).includes('PRIVATE'));
});
