import { expect, test } from '@playwright/test';

import type { Capability } from '../../src/application/analyzer.ts';
import { analyzeText } from '../../src/domain/assessment.ts';
import { startServer } from '../../src/server/server.ts';

test('local status shows configured model identity without hiding readiness or rendering markup', async ({ page }) => {
  let local: Capability | undefined;
  const runtime = await startServer({ port: 0, analyzer: {
    analyze: async (frame) => analyzeText('Weekly garden club newsletter.', frame),
    capabilities: async () => local ? [local] : [],
  } });
  const cases = [
    { model: 'Llama-3.2-3B-Instruct-Q4_K_M.gguf', available: true, expected: 'Local model ready · Configured model: Llama-3.2-3B-Instruct-Q4_K_M.gguf' },
    { model: 'Qwen3-8B-Q4_K_M.gguf', available: false, limitation: 'Local model server starting', expected: 'Local model server starting · Configured model: Qwen3-8B-Q4_K_M.gguf' },
    { model: 'Qwen3-8B-Q4_K_M.gguf', available: false, limitation: 'Local model warming up', expected: 'Local model warming up · Configured model: Qwen3-8B-Q4_K_M.gguf' },
    { model: 'Qwen3-8B-Q4_K_M.gguf', available: false, limitation: 'Local model unavailable: warm-up failed', expected: 'Local model unavailable: warm-up failed · Configured model: Qwen3-8B-Q4_K_M.gguf' },
    { model: '/private/models/alternative.gguf', available: true, expected: 'Local model ready · Configured model: alternative.gguf' },
    { model: 'C:\\private\\models\\alternative.gguf', available: true, expected: 'Local model ready · Configured model: alternative.gguf' },
    { model: '  ', available: true, expected: 'Local model ready · Configured model: not reported' },
    { model: undefined, available: false, expected: 'Local model unavailable · Configured model: not reported' },
    { model: '<img src=x onerror=alert(1)>', available: true, expected: 'Local model ready · Configured model: <img src=x onerror=alert(1)>' },
    { model: 'm'.repeat(300), available: true, expected: 'Local model ready · Configured model: ' + 'm'.repeat(160) },
  ];
  try {
    for (const { expected, ...value } of cases) {
      local = { id: 'local-model', kind: 'model', route: 'local-model', ...value };
      await page.goto(`${runtime.origin}/companion`);
      await expect(page.locator('#tiers')).toHaveText(expected);
      await expect(page.locator('#tiers img')).toHaveCount(0);
    }
    local = undefined;
    await page.goto(`${runtime.origin}/companion`);
    await expect(page.locator('#tiers')).toHaveText('Local model not configured');
    await page.route('**/api/capabilities', (route) => route.abort());
    await page.reload();
    await expect(page.locator('#tiers')).toHaveText('Local runtime not reachable');
  } finally { await runtime.close(); }
});
