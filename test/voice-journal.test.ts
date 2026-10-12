// hf8 journal mapping: voice segments become su6 observations with source
// 'voice' and text-only payloads, so the private journal keeps recognised text
// and its classification, never audio, images or screen metadata.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FakeHelper, settle } from './support/fake-helper.ts';
import { PrivateEvidenceJournal, type EvidenceStorage } from '../src/adapters/evidence-journal.ts';
import { VoiceObservationSource, voiceObservation } from '../src/adapters/voice-source.ts';
import { ObservationCollector, type Observation, type ObservationSource } from '../src/application/observation.ts';
import { RoutedAnalyzer } from '../src/application/routing.ts';
import { parseTextFrame, type TextFrame } from '../src/domain/assessment.ts';

const scam = 'Your account will be suspended today. Please buy gift cards now and send the codes.';
const segment = (text: string, t_end = '2026-10-11T15:50:06.000Z') => ({ kind: 'segment', t_start: '2026-10-11T15:50:00.000Z', t_end, text, confidence: 0.9, reason: 'change', origin: 'system' });

test('a voice frame maps to a text-only observation with its session envelope', () => {
  const frame = parseTextFrame({ frame_id: 'voice-1', source: 'voice', text: 'hello there', captured_at: '2026-10-11T15:50:06.000Z', session_id: 's-1', generation: 3 });
  assert.deepEqual(voiceObservation(frame, 'ob-1'), {
    id: 'ob-1', observed_at: '2026-10-11T15:50:06.000Z', source: 'voice', frame_id: 'voice-1', session_id: 's-1', generation: 3,
    payload: { ocr_text: 'hello there', ocr_complete: true },
  });
});

function voiceRig() {
  const children: FakeHelper[] = [];
  let n = 0;
  const source = new VoiceObservationSource({
    launcher: () => { const child = new FakeHelper(); children.push(child); return child; }, executable: '/fake/shepherd-voice',
    id: () => `voice-${++n}`, observationId: () => `ob-${n}`, envelope: () => ({ session_id: 's-1', generation: 2 }),
  });
  return { source, children };
}

test('VoiceObservationSource implements the su6 port: off until start, observations until stop', async () => {
  const { source, children } = voiceRig();
  const port: ObservationSource = source;
  assert.equal(port.id, 'voice');
  assert.equal(children.length, 0);
  const seen: Observation[] = [];
  const stop = port.start((observation) => seen.push(observation));
  children[0].line({ kind: 'listening', locale: 'en-US' });
  children[0].line(segment('first words'));
  await settle();
  assert.equal(source.listening, true);
  stop();
  children[0].line(segment('after stop'));
  await settle();
  assert.deepEqual(seen.map((o) => [o.id, o.source, o.payload.ocr_text]), [['ob-1', 'voice', 'first words']]);
  assert.deepEqual(children[0].signals, ['SIGTERM']);
  assert.equal(source.listening, false);
});

test('end to end: a spoken scam segment is classified and journalled as text plus annotation, no image', async () => {
  const files = new Map<string, string>();
  const storage: EvidenceStorage = {
    prepare: async () => {}, remove: async (path) => { files.delete(path); },
    write: async (path, data, _mode, current) => { if (current()) files.set(path, data.toString()); },
    read: async (path) => files.get(path),
    clear: async (path) => { for (const key of files.keys()) if (key.startsWith(`${path}/`)) files.delete(key); },
  };
  const collector = new ObservationCollector(new PrivateEvidenceJournal('/private/journal', storage), { now: () => Date.parse('2026-10-11T15:50:07Z'), id: () => 'annotation-1' });
  collector.setEnabled(true);
  const analyzer = new RoutedAnalyzer({ extractor: { extract: async (f) => ('text' in f ? f.text : '') },
    local: { model: 'l', available: async () => true, assess: async () => ({ risk: 'high', reasons: ['payment_pressure'], cue: '' }) } });
  const { source, children } = voiceRig();
  const pending: Promise<void>[] = [];
  // The runtime analyses each voice frame, then hands observation and assessment to the collector.
  source.onFrame = (frame: TextFrame, observation: Observation) => {
    pending.push(analyzer.analyze(frame, new AbortController().signal).then((assessment) => collector.observe(observation, assessment)));
  };
  source.start(() => {});
  children[0].line(segment(scam));
  await settle();
  await Promise.all(pending);
  assert.deepEqual([...files.keys()].sort(), ['/private/journal/ob-1.json', '/private/journal/ob-1.txt']);
  assert.equal(files.get('/private/journal/ob-1.txt'), scam);
  const record = JSON.parse(files.get('/private/journal/ob-1.json') as string);
  assert.equal(record.source, 'voice');
  assert.equal(record.png_path, undefined);
  for (const key of ['app', 'bundle_id', 'window_title']) assert.equal(record[key], undefined);
  assert.equal(record.trigger, 'suspicious');
  assert.deepEqual(record.annotations.map((a: { kind: string; value: { status: string; policy_row?: string } }) => [a.kind, a.value.status, a.value.policy_row]), [['classification', 'concern', '7']]);
});
