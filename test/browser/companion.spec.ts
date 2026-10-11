import { expect, test } from '@playwright/test';

import { analyzeText } from '../../src/domain/assessment.ts';
import { GrantRegistry } from '../../src/server/consent.ts';
import { startServer } from '../../src/server/server.ts';

test('companion starts paused, is keyboard reachable and links to the trace', async ({ page }) => {
  const runtime = await startServer({ port: 0 });
  try {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${runtime.origin}/companion`);
    await expect(page.locator('#state')).toHaveText('Paused. Nothing is being watched.');
    await expect(page.locator('#start')).toBeEnabled();
    await expect(page.locator('#pause')).toBeDisabled();
    await expect(page.locator('#grant')).toBeDisabled();
    await expect(page.locator('#scope')).toContainText('Nothing else leaves this computer.');
    await expect(page.locator('a[href="/trace"]')).toBeVisible();
    await page.keyboard.press('Tab');
    await expect(page.locator('#start')).toBeFocused();
    expect(errors).toEqual([]);
  } finally { await runtime.close(); }
});

test('Start captures this tab, shows the explanation, and the grant registers with the runtime', async ({ page }) => {
  const consent = new GrantRegistry();
  const runtime = await startServer({ port: 0, consent, analyzer: {
    analyze: async (frame) => analyzeText('Your computer is infected. Call support now.', frame),
    capabilities: async () => [{ id: 'local-ocr-rules', kind: 'rules', route: 'local', available: true }],
  } });
  try {
    await page.goto(`${runtime.origin}/companion`);
    await page.evaluate(() => {
      // Test double for the OS window picker (headless Chromium cannot grant display
      // capture): a canvas stream with on-screen text. Live OS permission is checked
      // separately from this test.
      navigator.mediaDevices.getDisplayMedia = async () => {
        const canvas = Object.assign(document.createElement('canvas'), { width: 640, height: 360 });
        const context = canvas.getContext('2d') as CanvasRenderingContext2D;
        const paint = () => { context.fillStyle = '#fff'; context.fillRect(0, 0, 640, 360); context.fillStyle = '#000'; context.font = '28px sans-serif'; context.fillText('Your computer is infected', 20, 80); };
        paint();
        setInterval(paint, 100);
        return canvas.captureStream(10);
      };
    });
    await page.click('#start');
    await expect(page.locator('#state')).toHaveText('Pause and check', { timeout: 15_000 });
    await expect(page.locator('#message')).toContainText('tech support scam');
    await expect(page.locator('#read')).toBeEnabled();
    await page.click('#grant');
    await expect(page.locator('#consent')).toContainText('Allowed for this session');
    await page.click('#pause');
    await expect(page.locator('#state')).toHaveText('Paused. Nothing is being watched.');
    await expect(page.locator('#consent')).toContainText('Not allowed');
  } finally { await runtime.close(); }
});
