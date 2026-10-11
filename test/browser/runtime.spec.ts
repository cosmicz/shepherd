import { readFile } from 'node:fs/promises';

import { expect, test } from '@playwright/test';

import { startServer } from '../../src/server/server.ts';

// Exercise server Origin/CORS checks without the fixture page's CSP masking them.
test.use({ bypassCSP: true });

test('Chromium can analyze on the service origin but cannot read a foreign token', async ({ page }) => {
  const runtime = await startServer({ port: 0 });
  const foreign = await startServer({ port: 0 });
  try {
    await page.goto(runtime.origin);
    const image = `data:image/png;base64,${(await readFile(new URL('../../fixtures/support-warning.png', import.meta.url))).toString('base64')}`;
    const result = await page.evaluate(async (image) => {
      const { token } = await (await fetch('/api/session')).json();
      const response = await fetch('/api/analyze', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Shepherd-Token': token },
        body: JSON.stringify({ frame_id: 'browser-1', source: 'example', image }),
      });
      return { status: response.status, assessment: await response.json() };
    }, image);
    expect(result.status).toBe(200);
    expect(result.assessment.status).toBe('concern');
    expect(result.assessment.analyzer.kind).toBe('rules');
    await page.goto(foreign.origin);
    const blocked = await page.evaluate(async (origin) => {
      try { await fetch(`${origin}/api/session`); return false; } catch { return true; }
    }, runtime.origin);
    expect(blocked).toBe(true);
  } finally { await Promise.all([runtime.close(), foreign.close()]); }
});
