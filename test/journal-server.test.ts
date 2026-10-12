import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ObservationRecorder } from '../src/application/observation.ts';
import { analyzeText, type Frame } from '../src/domain/assessment.ts';
import { startServer } from '../src/server/server.ts';

test('journal control is local-token protected, default-off, and never exposes journal content', async (t) => {
  const records: Array<[Frame, string]> = [];
  let deleted = 0;
  let enabled = false;
  const recorder: ObservationRecorder = {
    get enabled() { return enabled; },
    setEnabled(value) { enabled = value; },
    async record(frame, assessment) { if (enabled) records.push([frame, assessment.status]); },
    async deleteAll() { deleted++; },
  };
  const runtime = await startServer({ port: 0, recorder, analyzer: {
    analyze: async (frame) => analyzeText('Your computer is infected. Call support now.', frame),
    capabilities: async () => [],
  } });
  t.after(() => runtime.close());
  const token = (await (await fetch(`${runtime.origin}/api/session`)).json() as { token: string }).token;
  const headers = { Origin: runtime.origin, 'X-Shepherd-Token': token, 'Content-Type': 'application/json' };
  assert.equal((await fetch(`${runtime.origin}/api/journal`, { headers: { Origin: runtime.origin } })).status, 403);
  assert.deepEqual(await (await fetch(`${runtime.origin}/api/journal`, { headers })).json(), { available: true, enabled: false });
  assert.deepEqual(await (await fetch(`${runtime.origin}/api/journal`, { method: 'PUT', headers, body: JSON.stringify({ enabled: true }) })).json(), { available: true, enabled: true });
  const frame = { frame_id: 'f', source: 'native', text: 'safe', captured_at: '2026-10-11T15:45:00Z' };
  assert.equal((await fetch(`${runtime.origin}/api/analyze`, { method: 'POST', headers, body: JSON.stringify(frame) })).status, 200);
  assert.deepEqual(records.map(([recorded, status]) => [recorded.frame_id, status]), [['f', 'concern']]);
  assert.deepEqual(await (await fetch(`${runtime.origin}/api/journal`, { method: 'PUT', headers, body: JSON.stringify({ enabled: false }) })).json(), { available: true, enabled: false });
  assert.equal((await fetch(`${runtime.origin}/api/analyze`, { method: 'POST', headers, body: JSON.stringify({ ...frame, frame_id: 'later' }) })).status, 200);
  assert.equal(records.length, 1);
  assert.equal((await fetch(`${runtime.origin}/api/journal`, { method: 'DELETE', headers: { Origin: runtime.origin } })).status, 403);
  assert.equal((await fetch(`${runtime.origin}/api/journal`, { method: 'DELETE', headers })).status, 204);
  assert.equal(deleted, 1);
});

test('a journal recorder failure cannot change the assessment response', async (t) => {
  const recorder: ObservationRecorder = {
    enabled: true,
    setEnabled() {},
    async record() { throw Error('private storage unavailable'); },
    async deleteAll() {},
  };
  const runtime = await startServer({ port: 0, recorder, analyzer: {
    analyze: async (frame) => analyzeText('safe', frame),
    capabilities: async () => [],
  } });
  t.after(() => runtime.close());
  const token = (await (await fetch(`${runtime.origin}/api/session`)).json() as { token: string }).token;
  const headers = { Origin: runtime.origin, 'X-Shepherd-Token': token, 'Content-Type': 'application/json' };
  const frame = { frame_id: 'f', source: 'native', text: 'safe', captured_at: '2026-10-11T15:45:00Z' };
  assert.equal((await fetch(`${runtime.origin}/api/analyze`, { method: 'POST', headers, body: JSON.stringify(frame) })).status, 200);
});
