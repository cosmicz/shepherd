import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ThreatTraceTagger } from '../src/adapters/threat-trace.ts';
import type { Frame } from '../src/domain/assessment.ts';
import { makeUnavailable } from '../src/domain/assessment.ts';
import type { PipelineRecord } from '../src/domain/pipeline.ts';
import { TraceHub } from '../src/server/trace.ts';

const snapshot = { status: 'fresh' as const, manifest: { source: 'fixture-feed', revision: 'abc', retrieved_at: new Date().toISOString() }, index: new Map([['listed.example', ['phishing']]]) };
const frame = (url: string | null, text = '') => ({ frame_id: 'f', source: 'native', url, text }) as Frame;
test('URL tags are exact-host annotations; no-match never implies safe', () => {
  const tagger = new ThreatTraceTagger(snapshot);
  const tags = tagger.tags(frame('https://LISTED.example./login'));
  assert.equal(tags[0].source, 'url'); assert.equal(tags[0].host, 'listed.example');
  assert.deepEqual(tags[0].lists, ['phishing']); assert.equal(tags[0].kind, 'listed');
  assert.deepEqual(tagger.tags(frame('https://listed.example.evil.invalid')), []);
  assert.deepEqual(tagger.tags(frame(null, 'https://listed.example')), []);
});
test('opt-in OCR tags are labelled mentions, and pixel handoff is frame-bound and consumed', () => {
  const tagger = new ThreatTraceTagger(snapshot, true);
  const pixel = { frame_id: 'p', source: 'window', image: 'unused' } as Frame;
  tagger.remember(pixel, 'Simulated address: https://listed.example\nAccount notice');
  assert.deepEqual(tagger.tags({ ...pixel, frame_id: 'other' }), []);
  assert.equal(tagger.tags(pixel)[0].source, 'ocr-mention');
  assert.deepEqual(tagger.tags(pixel), []);
  assert.deepEqual(tagger.tags(frame(null, '\n'.repeat(12) + 'https://listed.example')), []);
});

test('trace adds list provenance and bounded model explanations without changing the assessment', () => {
  const tagger = new ThreatTraceTagger(snapshot);
  const hub = new TraceHub({ tagger: (value) => tagger.tags(value) });
  const chunks: string[] = [];
  hub.subscribe({ destroyed: false, writeHead() {}, on() {}, write: (value: string) => chunks.push(value) } as never);
  const input = frame('https://listed.example/');
  const assessment = makeUnavailable(input);
  const before = structuredClone(assessment);
  hub.recordPipelineSummary({ frame_id: 'f', tiers: [
    { tier: 'local-model', model: 'fake-local', output: { parsed: { risk: 'medium', reasons: ['other_concern'], cue: 'x'.repeat(300) } } },
    { tier: 'cloud', model: 'fake-cloud', output: { verdict: 'suspicious', reasons: ['other_concern'], rationale: { model_text: 'y'.repeat(900) } } },
  ] } as PipelineRecord);
  hub.recordAssessment(assessment, input);
  const event = JSON.parse(chunks.find((c) => c.startsWith('event: event\n'))!.split('data: ')[1]);
  assert.equal(event.tags[0].source, 'url');
  assert.equal(event.model_explanations[0].quoted_cue.length, 160);
  assert.equal(event.model_explanations[1].model_authored_rationale.length, 512);
  assert.deepEqual(assessment, before);
  assert.equal(hub.counters.remote_calls, 0);
  const failing = new TraceHub({ tagger: () => { throw Error('offline feed failed'); } });
  assert.doesNotThrow(() => failing.recordAssessment(assessment, input));
});
