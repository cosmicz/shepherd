import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';

test('supplemental demo pages and image assets stay on loopback; original eval corpus stays eight', async () => {
  // @ts-expect-error standalone JavaScript demo server
  const { server } = await import('../demo/serve.mjs');
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const get = (path: string, host = '127.0.0.1') => new Promise<{ status: number; headers: Record<string, unknown>; body: Buffer }>((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, headers: { Host: `${host}:${port}` } }, (res) => {
      const chunks: Buffer[] = []; res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) }));
    }); req.on('error', reject); req.end();
  });
  try {
    for (const host of ['account-review.localhost', 'device-update.localhost', 'community.localhost']) {
      const page = await get('/', host);
      assert.equal(page.status, 200);
      assert.match(page.body.toString(), /<img /);
      assert.match(String(page.headers['content-security-policy']), /img-src 'self'/);
      assert.doesNotMatch(page.body.toString(), /(?:src|href|action)=["']https?:\/\//);
      assert.match(page.body.toString(), /Local demo/);
    }
    const png = await get('/assets/bank-notice.png');
    assert.equal(png.status, 200); assert.equal(png.headers['content-type'], 'image/png');
    assert.equal(png.body.subarray(1, 4).toString(), 'PNG');
    assert.equal((await get('/assets/not-allowed.png')).status, 404);
    assert.equal((await get('/', 'a-facebook.com')).status, 421);
    const frozen = JSON.parse(await readFile(new URL('../demo/fixtures.json', import.meta.url), 'utf8'));
    assert.equal(frozen.pages.length, 8);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});
