import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { HttpAnalyzer } from '../src/adapters/http-analyzer.ts';
import { startServer } from '../src/server/server.ts';

test('browser-facing analyzer uses the local token and validates real OCR results', async (t) => {
  const runtime = await startServer({ port: 0 });
  t.after(() => runtime.close());
  const client = new HttpAnalyzer(runtime.origin);
  const image = `data:image/png;base64,${(await readFile(new URL('../fixtures/support-warning.png', import.meta.url))).toString('base64')}`;
  const result = await client.analyze({ frame_id: 'client-1', source: 'example', image }, new AbortController().signal);
  assert.equal(result.status, 'concern');
  assert.equal(result.frame_id, 'client-1');
  assert.equal((await client.capabilities())[0].available, true);
});

test('client refuses remote endpoints and honors cancellation', async (t) => {
  assert.throws(() => new HttpAnalyzer('https://example.com'));
  const runtime = await startServer({ port: 0 });
  t.after(() => runtime.close());
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(new HttpAnalyzer(runtime.origin).analyze({ frame_id: '1', source: 'example', image: '' }, controller.signal));
});
