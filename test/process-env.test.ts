import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runProcess } from '../src/adapters/process.ts';

test('subprocesses receive an allowlisted environment, never the parent secrets (F8)', async (t) => {
  process.env.ANTHROPIC_API_KEY = 'sk-test-must-not-leak';
  process.env.SHEPHERD_TEST_SECRET = 'private-value';
  t.after(() => { delete process.env.ANTHROPIC_API_KEY; delete process.env.SHEPHERD_TEST_SECRET; });
  const script = 'process.stdout.write(JSON.stringify(process.env))';
  const env = JSON.parse(await runProcess(process.execPath, ['-e', script], Buffer.alloc(0), new AbortController().signal, 5000)) as Record<string, string>;
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.SHEPHERD_TEST_SECRET, undefined);
  assert.equal(env.PATH, process.env.PATH, 'PATH is kept so the executable can be found');
  assert.ok(Object.keys(env).every((key) => ['PATH', 'OMP_THREAD_LIMIT', 'TESSDATA_PREFIX', '__CF_USER_TEXT_ENCODING'].includes(key)), Object.keys(env).join(','));
});
