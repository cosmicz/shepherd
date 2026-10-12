import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { LlamaManager, type SpawnLike } from '../src/adapters/llama-manager.ts';

// Fake child process and fake health/warm-up endpoint: no real binary runs here.
class FakeChild extends EventEmitter {
  signals: string[] = [];
  exitOn: string[];
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  constructor(exitOn = ['SIGTERM', 'SIGKILL']) { super(); this.exitOn = exitOn; }
  kill(signal: string) { this.signals.push(signal); if (this.exitOn.includes(signal)) setTimeout(() => this.emit('exit', null, signal), 1); return true; }
}
async function modelFile() {
  const file = join(await mkdtemp(join(tmpdir(), 'llama-')), 'model.gguf');
  await writeFile(file, 'GGUF');
  return file;
}
function rig(opts: { healthyAfter?: number; alreadyRunning?: boolean; warmOk?: boolean; spawnError?: boolean; exitOn?: string[] } = {}) {
  const spawned: Array<{ binary: string; args: string[]; env: Record<string, string | undefined>; child: FakeChild }> = [];
  let healthCalls = 0;
  let up = !!opts.alreadyRunning;
  const fetchImpl = (async (url: string) => {
    if (url.endsWith('/health')) {
      healthCalls++;
      if (!up && spawned.length && !opts.spawnError && healthCalls > (opts.healthyAfter ?? 1)) up = true;
      if (!up) throw new Error('ECONNREFUSED');
      return new Response('{"status":"ok"}', { status: 200 });
    }
    return new Response('{}', { status: opts.warmOk === false ? 500 : 200 });
  }) as unknown as typeof fetch;
  const spawn: SpawnLike = (binary, args, options) => {
    const child = new FakeChild(opts.exitOn);
    spawned.push({ binary, args, env: options.env as Record<string, string | undefined>, child });
    if (opts.spawnError) setTimeout(() => child.emit('error', Object.assign(new Error('spawn llama-server ENOENT'), { code: 'ENOENT' })), 1);
    return child as never;
  };
  return { spawned, fetchImpl, spawn, setUp: (value: boolean) => { up = value; } };
}
const fast = { pollMs: 5, healthTimeoutMs: 400, restartBackoffMs: 10, stopGraceMs: 50 };

test('spawns llama-server with the known flags, no shell, minimal env; starting -> warming -> ready', async () => {
  const r = rig({ healthyAfter: 3 });
  const states: string[] = [];
  const manager = new LlamaManager({ model: await modelFile(), port: 18080, spawn: r.spawn, fetchImpl: r.fetchImpl, onChange: (s) => states.push(s.state), ...fast });
  await manager.start();
  assert.equal(manager.status().state, 'ready');
  assert.equal(manager.status().managed, true);
  assert.deepEqual(states.filter((s, i) => s !== states[i - 1]), ['starting', 'warming', 'ready']);
  const [{ binary, args, env }] = r.spawned;
  assert.equal(binary, 'llama-server');
  assert.deepEqual(args.slice(2), ['--host', '127.0.0.1', '--port', '18080', '-c', '8192', '--jinja']);
  assert.equal(args[0], '-m');
  assert.ok(!('OPENROUTER_API_KEY' in env) && Object.keys(env).every((key) => ['PATH', 'HOME'].includes(key)), Object.keys(env).join(','));
  await manager.stop();
  assert.deepEqual(r.spawned[0].child.signals, ['SIGTERM']);
});

test('reuses a server that already answers and never signals it', async () => {
  const r = rig({ alreadyRunning: true });
  const manager = new LlamaManager({ model: await modelFile(), spawn: r.spawn, fetchImpl: r.fetchImpl, ...fast });
  await manager.start();
  assert.deepEqual([manager.status().state, manager.status().managed, r.spawned.length], ['ready', false, 0]);
  await manager.stop();
  assert.equal(r.spawned.length, 0);
});

test('missing model or binary: unavailable with a reason, the runtime carries on', async () => {
  const noModel = new LlamaManager({ model: '/nonexistent/model.gguf', spawn: rig().spawn, fetchImpl: rig().fetchImpl, ...fast });
  await noModel.start();
  assert.equal(noModel.status().state, 'unavailable');
  assert.match(noModel.status().reason ?? '', /model file/i);
  const r = rig({ spawnError: true });
  const noBinary = new LlamaManager({ model: await modelFile(), spawn: r.spawn, fetchImpl: r.fetchImpl, ...fast });
  await noBinary.start();
  assert.equal(noBinary.status().state, 'unavailable');
  assert.match(noBinary.status().reason ?? '', /llama-server/i);
  const unset = new LlamaManager({ spawn: rig().spawn, fetchImpl: rig().fetchImpl, ...fast });
  await unset.start();
  assert.equal(unset.status().state, 'unavailable');
});

test('health timeout or failed warm-up: unavailable and the managed child is stopped', async () => {
  const never = rig({ healthyAfter: 10_000 });
  const timeout = new LlamaManager({ model: await modelFile(), spawn: never.spawn, fetchImpl: never.fetchImpl, ...fast });
  await timeout.start();
  assert.equal(timeout.status().state, 'unavailable');
  assert.match(timeout.status().reason ?? '', /health/i);
  assert.deepEqual(never.spawned[0].child.signals, ['SIGTERM']);
  const cold = rig({ warmOk: false });
  const warm = new LlamaManager({ model: await modelFile(), spawn: cold.spawn, fetchImpl: cold.fetchImpl, ...fast });
  await warm.start();
  assert.equal(warm.status().state, 'unavailable');
  assert.match(warm.status().reason ?? '', /warm/i);
});

test('crash: unavailable, one restart after backoff; a second crash stays unavailable', async () => {
  const r = rig();
  const manager = new LlamaManager({ model: await modelFile(), spawn: r.spawn, fetchImpl: r.fetchImpl, ...fast });
  await manager.start();
  r.setUp(false);
  r.spawned[0].child.emit('exit', 1, null);
  assert.equal(manager.status().state, 'unavailable');
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(r.spawned.length, 2, 'one restart');
  assert.equal(manager.status().state, 'ready');
  r.setUp(false);
  r.spawned[1].child.emit('exit', 1, null);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(r.spawned.length, 2, 'no second restart');
  assert.equal(manager.status().state, 'unavailable');
});

test('stop escalates to SIGKILL when the child ignores SIGTERM', async () => {
  const r = rig({ exitOn: ['SIGKILL'] });
  const manager = new LlamaManager({ model: await modelFile(), spawn: r.spawn, fetchImpl: r.fetchImpl, ...fast });
  await manager.start();
  await manager.stop();
  assert.deepEqual(r.spawned[0].child.signals, ['SIGTERM', 'SIGKILL']);
});

// Opt-in: real binary and model (standing llama-server approval). SHEPHERD_LLAMA_IT=1.
test('real llama-server: managed start to ready, then clean stop', { skip: process.env.SHEPHERD_LLAMA_IT !== '1' }, async () => {
  const manager = new LlamaManager({ model: `${process.env.HOME}/models/gguf/qwen3-8b-q4_k_m.gguf`, port: 18081 });
  await manager.start();
  assert.equal(manager.status().state, 'ready', manager.status().reason);
  assert.equal(manager.status().managed, true);
  await manager.stop();
  assert.equal(manager.status().state, 'stopped');
  await assert.rejects(fetch('http://127.0.0.1:18081/health'));
});

test('the local tier follows the manager: unavailable instantly until ready, state in capabilities', async () => {
  const { LlamaLocalModel } = await import('../src/adapters/llama-local.ts');
  const { RoutedAnalyzer, LocalModelError } = await import('../src/application/routing.ts');
  let state: { state: 'starting' | 'ready'; managed: boolean; reason?: string } = { state: 'starting', managed: true };
  let calls = 0;
  const fetchImpl = (async () => { calls++; return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ risk: 'low', reasons: [], cue: '' }) } }] })); }) as unknown as typeof fetch;
  const local = new LlamaLocalModel({ fetchImpl, manager: { status: () => state } });
  assert.equal(await local.available(), false);
  const started = performance.now();
  await assert.rejects(local.assess('text', new AbortController().signal), (e) => e instanceof LocalModelError && e.failure_kind === 'unavailable');
  assert.ok(performance.now() - started < 50 && calls === 0, 'no request and no 4 s wait while starting');
  const caps = await new RoutedAnalyzer({ extractor: { extract: async () => '' }, local }).capabilities();
  assert.match(caps.find((c) => c.id === 'local-model')?.limitation ?? '', /starting/i);
  state = { state: 'ready', managed: true };
  assert.equal(await local.available(), true);
  assert.deepEqual((await local.assess('text', new AbortController().signal) as { risk: string }).risk, 'low');
});
