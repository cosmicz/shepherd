import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AccessibilitySource, ObservationCollector, ScreenFrameSource, VoiceSourceStub, type JournalPort } from '../src/application/observation.ts';
import type { Assessment, Frame } from '../src/domain/assessment.ts';
import type { PipelineRecord } from '../src/domain/pipeline.ts';

const frame: Frame = {
  frame_id: 'frame-1', source: 'window', session_id: 'session-1', generation: 2,
  image: 'data:image/png;base64,c3ludGhldGlj',
};
const concern: Assessment = {
  frame_id: 'frame-1', source: 'window', status: 'concern', reasons: ['support_pressure'], evidence: [],
  message: 'm', analyzer: { id: 'local-ocr-rules', kind: 'rules', version: '1' }, media_origin: 'not_assessed',
  route: 'local', duration_ms: 1, trace: [], policy_row: '3',
};

function rig() {
  let now = 1_000;
  const writes: Parameters<JournalPort['write']>[0][] = [];
  const journal: JournalPort = { write: async (entry, current) => { if (current()) writes.push(entry); }, read: async () => undefined, deleteAll: async () => {} };
  return { writes, advance: (ms: number) => { now += ms; }, collector: new ObservationCollector(journal, { now: () => now, id: (() => { let n = 0; return () => `ob-${++n}`; })(), periodic_ms: 60_000 }) };
}

test('ScreenFrameSource keeps capture payload and classifier annotation separate', () => {
  const source = new ScreenFrameSource({ now: () => 1_000, id: () => 'ob-1' });
  const received: unknown[] = [];
  const stop = source.start((observation) => received.push(observation));
  source.observe(frame, 'full OCR text', true);
  stop();
  source.observe(frame, 'late OCR', true);
  assert.deepEqual(received, [{
    id: 'ob-1', observed_at: '1970-01-01T00:00:01.000Z', source: 'window', frame_id: 'frame-1',
    session_id: 'session-1', generation: 2,
    payload: { image: frame.image, ocr_text: 'full OCR text', ocr_complete: true },
  }]);
  assert.deepEqual(source.classification('ob-1', concern), {
    id: 'ob-1:classification', observation_id: 'ob-1', created_at: '1970-01-01T00:00:01.000Z', kind: 'classification',
    value: { status: 'concern', reasons: ['support_pressure'], route: 'local', duration_ms: 1, policy_row: '3', analyzer: { id: 'local-ocr-rules', kind: 'rules', version: '1' } },
  });
});

test('screen source and collector bind their default UUID generator', async () => {
  const source = new ScreenFrameSource({ now: () => 1_000 });
  const observation = source.observe(frame, undefined, false);
  assert.match(observation.id, /^[0-9a-f-]{36}$/);

  const writes: Parameters<JournalPort['write']>[0][] = [];
  const collector = new ObservationCollector({ write: async (entry) => { writes.push(entry); }, read: async () => undefined, deleteAll: async () => {} }, { now: () => 1_000 });
  collector.setEnabled(true);
  await collector.observe(observation, concern);
  assert.match(writes[0].annotations[0].id, /^[0-9a-f-]{36}$/);
});

test('accessibility and voice sources are declared inert stubs', () => {
  for (const source of [new AccessibilitySource(), new VoiceSourceStub()]) {
    let called = 0;
    const stop = source.start(() => { called++; });
    stop(); source.stop();
    assert.equal(called, 0);
  }
});

test('collector is disabled by default, samples on its fake clock, and always records suspicious events', async () => {
  const h = rig();
  const observation = { id: 'ob-1', observed_at: '1970-01-01T00:00:01.000Z', source: 'window' as const, frame_id: 'frame-1', payload: { image: 'synthetic', ocr_text: 'full OCR', ocr_complete: true } };
  await h.collector.observe(observation, { ...concern, status: 'no_signal', reasons: [] });
  assert.equal(h.writes.length, 0);
  h.collector.setEnabled(true);
  await h.collector.observe(observation, { ...concern, status: 'no_signal', reasons: [] });
  h.advance(59_999);
  await h.collector.observe({ ...observation, id: 'ob-2' }, { ...concern, frame_id: 'frame-2', status: 'no_signal', reasons: [] });
  await h.collector.observe({ ...observation, id: 'ob-3' }, concern);
  assert.deepEqual(h.writes.map((item) => [item.observation.id, item.trigger, item.annotations.length]), [['ob-1', 'periodic', 1], ['ob-3', 'suspicious', 1]]);
});

test('collector attaches a local pipeline record as a separate annotation', async () => {
  const h = rig();
  h.collector.setEnabled(true);
  const pipeline = { version: 1, frame_id: 'frame-1', source: 'window', started_at: '1970-01-01T00:00:01.000Z', versions: { policy: 3, prompt: 3, schema: 3 }, tiers: [], decision: { row: '3', status: 'concern', route: 'local', message: 'scam' } } as unknown as PipelineRecord;
  await h.collector.observe({ id: 'ob-1', observed_at: '1970-01-01T00:00:01.000Z', source: 'window', frame_id: 'frame-1', payload: { image: 'synthetic', ocr_complete: true } }, concern, pipeline);
  assert.deepEqual(h.writes[0].annotations.map((annotation) => annotation.kind), ['classification', 'pipeline']);
  assert.equal(h.writes[0].annotations[1].value, pipeline);
});

test('revocation discards an already-queued write and journal failures do not throw into analysis', async () => {
  let release!: () => void;
  const writes: unknown[] = [];
  const journal: JournalPort = { write: async (entry, current) => { await new Promise<void>((resolve) => { release = resolve; }); if (current()) writes.push(entry); }, read: async () => undefined, deleteAll: async () => {} };
  const collector = new ObservationCollector(journal, { now: () => 1_000, id: () => 'id' });
  collector.setEnabled(true);
  const pending = collector.observe({ id: 'ob', observed_at: 't', source: 'window', frame_id: 'f', payload: { image: 'synthetic', ocr_complete: false } }, concern);
  collector.setEnabled(false);
  release();
  await pending;
  assert.equal(writes.length, 0);

  const failing = new ObservationCollector({ write: async () => { throw Error('disk full'); }, read: async () => undefined, deleteAll: async () => {} }, { now: () => 1_000, id: () => 'id' });
  failing.setEnabled(true);
  await failing.observe({ id: 'ob', observed_at: 't', source: 'window', frame_id: 'f', payload: { image: 'synthetic', ocr_complete: false } }, concern);
  assert.equal(failing.lastError, 'Journal could not save this observation.');
});
