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
    // d29: cloud permission can be chosen before Start; nothing is registered yet.
    await expect(page.locator('#grant')).toBeEnabled();
    await expect(page.locator('#revoke')).toBeDisabled();
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
      // separately and recorded on the bead.
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

test('family test message and grant expiry with Extend', async ({ page }) => {
  const consent = new GrantRegistry();
  const runtime = await startServer({ port: 0, consent, analyzer: {
    analyze: async (frame) => analyzeText('Weekly garden club newsletter.', frame),
    capabilities: async () => [{ id: 'local-ocr-rules', kind: 'rules', route: 'local', available: true }],
  } });
  try {
    await page.goto(`${runtime.origin}/companion`);
    await page.click('#family-test');
    await expect(page.locator('#family')).toHaveText(/could not be sent/);
    await page.evaluate(() => {
      (window as unknown as { __shepherdGrantMs: number }).__shepherdGrantMs = 1200;
      navigator.mediaDevices.getDisplayMedia = async () => {
        const canvas = Object.assign(document.createElement('canvas'), { width: 320, height: 200 });
        (canvas.getContext('2d') as CanvasRenderingContext2D).fillRect(0, 0, 10, 10);
        return canvas.captureStream(5);
      };
    });
    await page.click('#start');
    await expect(page.locator('#state')).toHaveText('No warning signs found', { timeout: 15_000 });
    await page.click('#grant');
    await expect(page.locator('#consent')).toContainText('Allowed for this session');
    await expect(page.locator('#consent')).toContainText('Cloud permission expired', { timeout: 5_000 });
    await expect(page.locator('#grant')).toHaveText('Extend for this session');
    await expect(page.locator('#scope')).toContainText('Nothing else leaves this computer.');
    await page.evaluate(() => { (window as unknown as { __shepherdGrantMs: number }).__shepherdGrantMs = 3600_000; });
    await page.click('#grant');
    await expect(page.locator('#consent')).toContainText('Allowed for this session');
  } finally { await runtime.close(); }
});

// d29: allow before Start, bind on Start, Stop allowing always revokes and prevents the next bind.
test('cloud permission chosen before Start binds to the capture on Start; Stop allowing revokes and stops rebinding', async ({ page }) => {
  const consent = new GrantRegistry();
  const registered: Array<{ id: string; source: string; generation: number }> = [];
  const revoked: string[] = [];
  const register = consent.register.bind(consent);
  consent.register = (input: unknown) => { const grant = register(input); registered.push({ id: grant.id, source: grant.source, generation: grant.generation }); return grant; };
  consent.onRevoke((id) => revoked.push(id));
  const runtime = await startServer({ port: 0, consent, analyzer: {
    analyze: async (frame) => analyzeText('Weekly garden club newsletter with tomato tips.', frame),
    capabilities: async () => [{ id: 'local-ocr-rules', kind: 'rules', route: 'local', available: true }],
  } });
  try {
    await page.goto(`${runtime.origin}/companion`);
    await page.evaluate(() => {
      navigator.mediaDevices.getDisplayMedia = async () => {
        const canvas = Object.assign(document.createElement('canvas'), { width: 640, height: 360 });
        const context = canvas.getContext('2d') as CanvasRenderingContext2D;
        const paint = () => { context.fillStyle = '#fff'; context.fillRect(0, 0, 640, 360); context.fillStyle = '#000'; context.font = '28px sans-serif'; context.fillText('Weekly garden club newsletter', 20, 80); };
        paint();
        setInterval(paint, 100);
        return canvas.captureStream(10);
      };
    });
    // Before Start: a preference only, with the scope statement shown.
    await page.click('#grant');
    await expect(page.locator('#consent')).toContainText('Allowed once you start watching');
    await expect(page.locator('#consent')).toContainText('Nothing else leaves this computer.');
    await expect(page.locator('#grant')).toBeDisabled();
    await expect(page.locator('#revoke')).toBeEnabled();
    expect(registered).toEqual([]);
    // Start binds the real grant to this capture's source and generation, and repeats the scope.
    await page.click('#start');
    await expect(page.locator('#consent')).toContainText('Allowed for this session', { timeout: 15_000 });
    await expect(page.locator('#consent')).toContainText('Nothing else leaves this computer.');
    expect(registered).toHaveLength(1);
    // Same source rule as the frames: the canvas stand-in reports no browser surface, so 'window'.
    expect(registered[0].source).toBe('window');
    // Stop allowing revokes it and clears the preference.
    await page.click('#revoke');
    await expect(page.locator('#consent')).toContainText('Not allowed');
    await expect.poll(() => revoked).toContain(registered[0].id);
    // The next Start does not bind anything.
    await page.click('#pause');
    await page.click('#start');
    await expect(page.locator('#pause')).toBeEnabled({ timeout: 15_000 });
    await page.waitForTimeout(500);
    expect(registered).toHaveLength(1);
    await expect(page.locator('#consent')).toContainText('Not allowed');
  } finally { await runtime.close(); }
});

// d29 race (the team): Stop allowing while the bind's registration is in flight
// must leave no live grant, and no frame may carry one.
test('Stop allowing during the in-flight bind revokes the late grant; no frame carries it', async ({ page }) => {
  const consent = new GrantRegistry();
  const registered: string[] = [];
  const revoked: string[] = [];
  const carried: string[] = [];
  const register = consent.register.bind(consent);
  consent.register = (input: unknown) => { const grant = register(input); registered.push(grant.id); return grant; };
  consent.onRevoke((id) => revoked.push(id));
  const runtime = await startServer({ port: 0, consent, analyzer: {
    analyze: async (frame) => { if (frame.consent) carried.push(frame.consent.id); return analyzeText('Weekly garden club newsletter with tomato tips.', frame); },
    capabilities: async () => [{ id: 'local-ocr-rules', kind: 'rules', route: 'local', available: true }],
  } });
  try {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    await page.route('**/api/consent', async (route) => { if (route.request().method() === 'POST') await held; await route.continue(); });
    await page.goto(`${runtime.origin}/companion`);
    await page.evaluate(() => {
      navigator.mediaDevices.getDisplayMedia = async () => {
        const canvas = Object.assign(document.createElement('canvas'), { width: 640, height: 360 });
        const context = canvas.getContext('2d') as CanvasRenderingContext2D;
        const paint = () => { context.fillStyle = '#fff'; context.fillRect(0, 0, 640, 360); context.fillStyle = '#000'; context.font = '28px sans-serif'; context.fillText('Weekly garden club newsletter', 20, 80); };
        paint();
        setInterval(paint, 100);
        return canvas.captureStream(10);
      };
    });
    await page.click('#grant');
    await page.click('#start');
    await expect(page.locator('#pause')).toBeEnabled({ timeout: 15_000 });
    await page.click('#revoke');
    release();
    await expect.poll(() => registered.length).toBe(1);
    await expect.poll(() => revoked).toContain(registered[0]);
    await expect(page.locator('#consent')).toContainText('Not allowed');
    await page.waitForTimeout(1500);
    expect(consent.live({ frame_id: 'x', source: 'window', image: '', consent: undefined } as never, Date.now())).toBe(false);
    expect(carried).toEqual([]);
  } finally { await runtime.close(); }
});
