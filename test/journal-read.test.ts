// u6w: GET /api/journal/observation/{id} returns one recorded observation with
// its annotations (including the pipeline record) on loopback, with the token.
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { test } from 'node:test';
import { startServer, type JournalReader } from '../src/server/server.ts';

const entry = { record: { id: 'ob-1', source: 'native', frame_id: 'f-1', ocr_complete: true }, annotations: [{ id: 'a-1', observation_id: 'ob-1', kind: 'pipeline', value: { version: 1 } }], ocr_text: 'text', png: null };
function journal(): JournalReader & { reads: string[] } {
  const reads: string[] = [];
  return { reads, read: async (id) => { reads.push(id); return id === 'ob-1' ? entry : undefined; } };
}

test('a recorded observation is returned with its annotations; unrecorded is 404', async (t) => {
  const reader = journal();
  const runtime = await startServer({ port: 0, journal: reader });
  t.after(() => runtime.close());
  const { token } = await (await fetch(`${runtime.origin}/api/session`)).json() as { token: string };
  const get = (id: string, headers: Record<string, string> = { 'x-shepherd-token': token }) => fetch(`${runtime.origin}/api/journal/observation/${id}`, { headers });
  const found = await get('ob-1');
  assert.equal(found.status, 200);
  assert.equal(found.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await found.json(), entry);
  assert.equal((await get('ob-2')).status, 404);
  assert.equal((await get('..%2Fsecrets')).status, 400);
  assert.equal((await get('ob-1', {})).status, 403, 'token required');
  assert.equal((await get('ob-1', { 'x-shepherd-token': 'wrong' })).status, 403);
  // fetch drops a forbidden Origin header, so send this one with node:http.
  const foreign = await new Promise<number>((resolve, reject) => {
    request(`${runtime.origin}/api/journal/observation/ob-1`, { headers: { 'x-shepherd-token': token, origin: 'http://evil.example' } },
      (response) => { response.resume(); resolve(response.statusCode ?? 0); }).on('error', reject).end();
  });
  assert.equal(foreign, 403, 'foreign origin refused (global guard)');
  assert.deepEqual(reader.reads, ['ob-1', 'ob-2']);
});

test('without a journal the endpoint does not exist', async (t) => {
  const runtime = await startServer({ port: 0 });
  t.after(() => runtime.close());
  const { token } = await (await fetch(`${runtime.origin}/api/session`)).json() as { token: string };
  assert.equal((await fetch(`${runtime.origin}/api/journal/observation/ob-1`, { headers: { 'x-shepherd-token': token } })).status, 404);
});
