import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { request } from 'node:http';
import { test } from 'node:test';
import { startServer } from '../src/server/server.ts';
import { analyzeText } from '../src/domain/assessment.ts';
import { MAX_BODY_BYTES } from '../src/server/frame.ts';

const image = `data:image/png;base64,${(await readFile(new URL('../fixtures/support-warning.png', import.meta.url))).toString('base64')}`;
const frame = { frame_id: 'http-1', source: 'example' as const, image };

test('loopback boundary enforces origin, token, Host, types and size before analysis', async (t) => {
  let calls = 0;
  const runtime = await startServer({ port: 0, analyzer: {
    analyze: async (input) => { calls++; return analyzeText('Garden newsletter.', input); },
    capabilities: async () => [{ id: 'local-ocr-rules', kind: 'rules', route: 'local', available: true }],
  } });
  t.after(() => runtime.close());
  const session = await fetch(`${runtime.origin}/api/session`);
  const { token } = await session.json() as { token: string };
  const headers = { origin: runtime.origin, 'content-type': 'application/json', 'x-shepherd-token': token };
  const send = (body: string, extra: Record<string, string> = {}) => fetch(`${runtime.origin}/api/analyze`, { method: 'POST', headers: { ...headers, ...extra }, body });
  assert.equal((await send(JSON.stringify(frame), { origin: 'https://foreign.example' })).status, 403);
  assert.equal((await send(JSON.stringify(frame), { 'x-shepherd-token': 'wrong' })).status, 403);
  // Node fetch normalizes Host, so exercise this boundary with the raw HTTP client.
  const foreignHost = await new Promise<number | undefined>((resolve, reject) => {
    const req = request(`${runtime.origin}/api/session`, { headers: { host: 'evil.example' } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.end();
  });
  assert.equal(foreignHost, 403);
  assert.equal((await send(JSON.stringify(frame), { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await send(JSON.stringify(frame), { origin: '' })).status, 403);
  assert.equal((await send('{')).status, 400);
  assert.equal((await send(JSON.stringify({ ...frame, image: 'bad' }))).status, 400);
  assert.equal((await send('x'.repeat(MAX_BODY_BYTES + 1))).status, 413);
  assert.equal(calls, 0);
  const response = await send(JSON.stringify(frame));
  assert.equal(response.status, 200);
  assert.equal((await response.json() as { status: string }).status, 'no_signal');
  assert.equal(calls, 1);
  const foreign = await fetch(`${runtime.origin}/api/session`, { headers: { origin: 'https://foreign.example' } });
  assert.equal(foreign.status, 403);
  assert.equal(foreign.headers.get('access-control-allow-origin'), null);
});

test('HTTP analyzer rejects invalid provider results and does not overlap OCR work', async (t) => {
  let release!: () => void;
  let entered!: () => void;
  const ready = new Promise<void>((done) => { entered = done; });
  const pending = new Promise<void>((done) => { release = done; });
  const runtime = await startServer({ port: 0, analyzer: {
    analyze: async (input) => { entered(); await pending; return { ...analyzeText('Garden.', input), frame_id: 'wrong' }; },
    capabilities: async () => [{ id: 'local-ocr-rules', kind: 'rules', route: 'local', available: true }],
  } });
  t.after(() => runtime.close());
  const { token } = await (await fetch(`${runtime.origin}/api/session`)).json() as { token: string };
  const send = () => fetch(`${runtime.origin}/api/analyze`, { method: 'POST', headers: { origin: runtime.origin, 'content-type': 'application/json', 'x-shepherd-token': token }, body: JSON.stringify(frame) });
  const first = send();
  await ready;
  assert.equal((await send()).status, 429);
  release();
  assert.equal((await (await first).json() as { status: string }).status, 'unavailable');
});

test('disconnecting a browser request aborts the running analyzer', async (t) => {
  let entered!: () => void;
  let aborted!: () => void;
  const ready = new Promise<void>((done) => { entered = done; });
  const cancelled = new Promise<void>((done) => { aborted = done; });
  const runtime = await startServer({ port: 0, analyzer: {
    analyze: async (input, signal) => {
      entered();
      await new Promise<void>((done) => signal.addEventListener('abort', () => { aborted(); done(); }, { once: true }));
      return analyzeText('Garden.', input);
    },
    capabilities: async () => [{ id: 'local-ocr-rules', kind: 'rules', route: 'local', available: true }],
  } });
  t.after(() => runtime.close());
  const { token } = await (await fetch(`${runtime.origin}/api/session`)).json() as { token: string };
  const controller = new AbortController();
  const pending = fetch(`${runtime.origin}/api/analyze`, {
    method: 'POST', signal: controller.signal,
    headers: { origin: runtime.origin, 'content-type': 'application/json', 'x-shepherd-token': token }, body: JSON.stringify(frame),
  });
  await ready;
  controller.abort();
  await assert.rejects(pending);
  await cancelled;
});
