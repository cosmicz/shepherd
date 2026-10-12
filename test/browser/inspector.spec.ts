import { expect, test } from '@playwright/test';

import { TraceHub } from '../../src/server/trace.ts';
import { startServer, type JournalReader } from '../../src/server/server.ts';

// A 1x1 PNG.
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const pipeline = { version: 1, frame_id: 'f-rec', source: 'native', started_at: '2026-10-11T16:00:00.000Z', versions: { policy: 3, prompt: 3, schema: 3 },
  tiers: [
    { tier: 'rules', analyzer_id: 'local-ocr-rules', started_at: '2026-10-11T16:00:00.000Z', duration_ms: 3, input: { text_characters: 60, capped: false }, output: { status: 'concern', reasons: ['payment_pressure'], evidence: ['buy gift cards now'] } },
    { tier: 'cloud', analyzer_id: 'cloud-judge', model: 'anthropic/claude-opus-5', started_at: '2026-10-11T16:00:01.000Z', duration_ms: 2100, cached: false,
      input: { excerpt: 'Please buy gift cards now', excerpt_source: 'rules', payload_sha256: 'f'.repeat(64), bytes_out: 640 },
      output: { verdict: 'scam', reasons: ['payment_pressure'], pattern: 'other', rationale: { model_text: 'Asks for gift cards.' }, dispatched: true, cost: { known: true, usd: 0.0049 } } },
  ],
  gate: { grant: true, provider: true, budget: true, anchor: true }, decision: { row: '13', status: 'concern', route: 'cloud', message: 'scam' } };
const journal: JournalReader = { read: async (id) => (id === 'f-rec' ? {
  record: { id: 'ob-1', source: 'native', frame_id: 'f-rec', app: 'Safari', window_title: 'Account notice', captured_at: '2026-10-11T16:00:00.000Z' },
  annotations: [{ id: 'a-1', observation_id: 'ob-1', kind: 'pipeline', value: pipeline }], ocr_text: 'Your account will be suspended. Please buy gift cards now.', png,
} : undefined) };
const step = { tier: 'rules', analyzer_id: 'local-ocr-rules', outcome: 'concern', duration_ms: 3, remote_calls: 0, bytes_out: 0, cost: { known: true, usd: 0 }, cached: false, versions: { policy: 3, prompt: 3, schema: 3 } };
const event = (frame_id: string) => ({ frame_id, source: 'native', status: 'concern', reasons: ['payment_pressure'], evidence: [], message: 'm', media_origin: 'not_assessed',
  analyzer: { id: 'local-ocr-rules', kind: 'rules', version: '1' }, route: 'local', duration_ms: 5, policy_row: '3', trace: [step] }) as never;

test('the inspector is off by default, needs confirmation, and adds the local journal record to an expanded row', async ({ page }) => {
  const trace = new TraceHub();
  const runtime = await startServer({ port: 0, trace, journal });
  try {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${runtime.origin}/trace`);
    await expect(page.locator('#inspect-note')).toContainText('Off');
    await page.waitForTimeout(300);
    trace.recordAssessment(event('f-unrec'));
    trace.recordAssessment(event('f-rec'));
    await expect(page.locator('#events tr.row')).toHaveCount(2);
    const recorded = page.locator('#events tr.row[data-frame="f-rec"]');
    const detail = recorded.locator('xpath=following-sibling::tr[1]');
    // Off: expanding shows the live record only, never the journal.
    await recorded.click();
    await expect(detail).toBeVisible();
    await expect(page.locator('#events .journal')).toHaveCount(0);
    await recorded.click();
    // Dismissing the confirmation leaves the inspector off.
    page.once('dialog', (dialog) => dialog.dismiss());
    await page.click('#inspect');
    await expect(page.locator('#inspector')).toHaveAttribute('data-on', 'false');
    page.once('dialog', (dialog) => dialog.accept());
    await page.click('#inspect');
    await expect(page.locator('#inspector')).toHaveAttribute('data-on', 'true');
    await recorded.click();
    const journalBox = detail.locator('.journal');
    await expect(journalBox).toContainText('Recognised text');
    await expect(journalBox).toContainText('Please buy gift cards now.');
    await expect(journalBox.locator('img')).toHaveCount(1);
    await expect(journalBox).toContainText('cloud · anthropic/claude-opus-5 · 2100 ms');
    await expect(journalBox).toContainText('Model text (never spoken or sent): Asks for gift cards.');
    await expect(journalBox).toContainText('"row": "13"');
    const unrecorded = page.locator('#events tr.row[data-frame="f-unrec"]');
    await unrecorded.click();
    await expect(unrecorded.locator('xpath=following-sibling::tr[1]').locator('.journal')).toContainText('Not recorded');
    // Turning it off removes every journal section.
    await page.click('#inspect');
    await expect(page.locator('#events .journal')).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally { await runtime.close(); }
});
