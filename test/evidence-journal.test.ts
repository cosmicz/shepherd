import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PrivateEvidenceJournal, type EvidenceStorage } from '../src/adapters/evidence-journal.ts';
import type { JournalEntry } from '../src/application/observation.ts';

const entry: JournalEntry = {
  trigger: 'suspicious',
  observation: { id: 'ob-1', observed_at: '2026-10-11T15:40:00.000Z', source: 'window', frame_id: 'frame-1', app: 'Browser', payload: { image: 'data:image/png;base64,c3ludGhldGlj', ocr_text: 'full OCR stays local', ocr_complete: true } },
  annotations: [{ id: 'a-1', observation_id: 'ob-1', created_at: '2026-10-11T15:40:01.000Z', kind: 'classification', value: { status: 'concern', reasons: ['support_pressure'], route: 'local', duration_ms: 1, analyzer: { id: 'local-ocr-rules', kind: 'rules', version: '1' } } }],
};

test('private journal writes paired synthetic image/OCR/metadata with restrictive modes', async () => {
  const calls: Array<{ path: string; data?: string | Buffer; mode?: number }> = [];
  const storage: EvidenceStorage = {
    prepare: async (path) => { calls.push({ path, mode: 0o700 }); },
    write: async (path, data, mode, current) => { if (current()) calls.push({ path, data, mode }); },
    read: async () => undefined,
    remove: async (path) => { calls.push({ path: `remove:${path}` }); },
    clear: async () => {},
  };
  const journal = new PrivateEvidenceJournal('/private/shepherd/journal', storage);
  await journal.write(entry, () => true);
  assert.deepEqual(calls.map((call) => [call.path, call.mode]), [
    ['/private/shepherd/journal', 0o700],
    ['/private/shepherd/journal/ob-1.png', 0o600],
    ['/private/shepherd/journal/ob-1.txt', 0o600],
    ['/private/shepherd/journal/ob-1.json', 0o600],
  ]);
  const record = JSON.parse(String(calls[3].data));
  assert.deepEqual(record, {
    id: 'ob-1', captured_at: '2026-10-11T15:40:00.000Z', source: 'window', frame_id: 'frame-1', app: 'Browser',
    ocr_complete: true, png_path: 'ob-1.png', ocr_path: 'ob-1.txt', trigger: 'suspicious', annotations: entry.annotations,
  });
  assert.equal(String(calls[1].data), 'synthetic');
  assert.equal(String(calls[2].data), 'full OCR stays local');
});

test('private journal never commits a record after its generation guard closes', async () => {
  const calls: string[] = [];
  const storage: EvidenceStorage = {
    prepare: async () => { calls.push('prepare'); },
    write: async (path, _data, _mode, current) => { if (current()) calls.push(path); },
    read: async () => undefined,
    remove: async () => {},
    clear: async () => {},
  };
  await new PrivateEvidenceJournal('/private/shepherd/journal', storage).write(entry, () => false);
  assert.deepEqual(calls, []);
});

test('private journal reads only metadata and annotations, and delete-all clears every artifact', async () => {
  const files = new Map<string, string | Buffer>();
  const storage: EvidenceStorage = {
    prepare: async () => {},
    write: async (path, data, _mode, current) => { if (current()) files.set(path, data); },
    read: async (path) => files.get(path),
    remove: async (path) => { files.delete(path); },
    clear: async (path) => { for (const key of files.keys()) if (key.startsWith(`${path}/`)) files.delete(key); },
  };
  const journal = new PrivateEvidenceJournal('/private/shepherd/journal', storage);
  await journal.write(entry, () => true);
  const read = await journal.read('ob-1');
  assert.deepEqual(read, {
    record: {
      id: 'ob-1', captured_at: '2026-10-11T15:40:00.000Z', source: 'window', frame_id: 'frame-1', app: 'Browser',
      ocr_complete: true, png_path: 'ob-1.png', ocr_path: 'ob-1.txt', trigger: 'suspicious',
    },
    annotations: entry.annotations,
    ocr_text: 'full OCR stays local',
    png: 'data:image/png;base64,c3ludGhldGlj',
  });
  await journal.deleteAll();
  assert.equal(files.size, 0);
  assert.equal(await journal.read('ob-1'), undefined);
});
