import { expect, test } from '@playwright/test';

import { OcrAnalyzer } from '../../src/adapters/ocr.ts';

// Policy v2: the lookalike rule must survive real OCR. A digit zero rendered in a
// browser is read back by Tesseract as a letter O ("microsOft") and still flags.
test('a rendered micros0ft lookalike is read back by OCR and flagged as impersonation', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 260 });
  await page.setContent(`<body style="margin:40px;font:28px -apple-system,Helvetica,Arial,sans-serif;background:#fff;color:#111">
    <p>Sign in at micros0ft-support.com to restore your account.</p></body>`);
  const png = await page.screenshot({ type: 'png' });
  const assessment = await new OcrAnalyzer().analyze(
    { frame_id: 'lookalike-1', source: 'example', image: `data:image/png;base64,${png.toString('base64')}` },
    new AbortController().signal,
  );
  expect(assessment.status).toBe('concern');
  expect(assessment.reasons).toContain('impersonation');
  expect(assessment.evidence.join(' ').toLowerCase()).toContain('micros');
});
