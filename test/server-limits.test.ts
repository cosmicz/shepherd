import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyzeText } from '../src/domain/assessment.ts';
import { MAX_BODY_BYTES, MAX_IMAGE_BYTES } from '../src/server/frame.ts';
import { startServer } from '../src/server/server.ts';
import { dataUrl, syntheticPng } from './png-fixture.ts';

test('near-cap frames pass the HTTP boundary; one byte over the body cap is 413 (F1/F2)', async (t) => {
  let calls = 0;
  const runtime = await startServer({ port: 0, analyzer: {
    analyze: async (input) => { calls++; return analyzeText('Garden newsletter.', input); },
    capabilities: async () => [{ id: 'local-ocr-rules', kind: 'rules', route: 'local', available: true }],
  } });
  t.after(() => runtime.close());
  const { token } = await (await fetch(`${runtime.origin}/api/session`)).json() as { token: string };
  const send = (body: string) => fetch(`${runtime.origin}/api/analyze`, {
    method: 'POST', headers: { origin: runtime.origin, 'content-type': 'application/json', 'x-shepherd-token': token }, body,
  });

  for (const total of [3_637_103, MAX_IMAGE_BYTES]) {
    const response = await send(JSON.stringify({ frame_id: `near-cap-${total}`, source: 'example', image: dataUrl(syntheticPng(2560, 1600, total)) }));
    assert.equal(response.status, 200, `decoded ${total} bytes`);
  }
  assert.equal(calls, 2);
  assert.equal((await send('x'.repeat(MAX_BODY_BYTES + 1))).status, 413);
  assert.equal(calls, 2);
});
