import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import type { ChildProcess } from 'node:child_process';
import { NativeBanner, parseAction, type BannerSpawn } from '../src/adapters/banner.ts';

class FakeBanner extends EventEmitter {
  stdout = new PassThrough();
  signals: string[] = [];
  kill(signal: string) { this.signals.push(signal); return true; }
  reply(line: string, code = 0) { this.stdout.write(line); setImmediate(() => this.emit('exit', code)); }
}
const rig = () => {
  const spawned: Array<{ binary: string; args: string[]; env: NodeJS.ProcessEnv; child: FakeBanner }> = [];
  const spawn: BannerSpawn = (binary, args, options) => {
    const child = new FakeBanner();
    spawned.push({ binary, args, env: options.env, child });
    return child as unknown as ChildProcess;
  };
  return { spawned, banner: new NativeBanner({ binary: '/opt/shepherd-banner', title: 'Shepherd alert n-123', spawn }) };
};

test('banner: argv carries only the template text, pattern label, title and timeout; minimal env', async () => {
  const { spawned, banner } = rig();
  const shown = banner.show('This looks like a scam. Call Danny.', 'investment offer');
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].binary, '/opt/shepherd-banner');
  assert.deepEqual(spawned[0].args, ['--text', 'This looks like a scam. Call Danny.', '--pattern', 'investment offer', '--title', 'Shepherd alert n-123', '--timeout', '45']);
  assert.deepEqual(Object.keys(spawned[0].env).sort(), ['HOME', 'PATH']);
  spawned[0].child.reply('{"action":"call"}\n');
  assert.equal(await shown, 'call');
});

test('banner: fine and timeout pass through; bad output or a non-zero exit is unavailable', async () => {
  for (const [line, code, expected] of [['{"action":"fine"}\n', 0, 'fine'], ['{"action":"timeout"}\n', 0, 'timeout'], ['{"action":"delete"}\n', 0, 'unavailable'], ['not json', 0, 'unavailable'], ['{"action":"call"}\n', 1, 'unavailable']] as const) {
    const { spawned, banner } = rig();
    const shown = banner.show('t', 'p');
    spawned[0].child.reply(line, code);
    assert.equal(await shown, expected, line);
  }
  assert.equal(parseAction('{"action":"fine"}\n{"action":"call"}'), 'fine', 'first line only');
});

test('banner: one at a time; a second show while one is open is busy; free again after exit', async () => {
  const { spawned, banner } = rig();
  const first = banner.show('t', 'p');
  assert.equal(await banner.show('t', 'p'), 'busy');
  assert.equal(spawned.length, 1);
  spawned[0].child.reply('{"action":"fine"}\n');
  await first;
  const second = banner.show('t', 'p');
  assert.equal(spawned.length, 2);
  spawned[1].child.reply('{"action":"call"}\n');
  assert.equal(await second, 'call');
});

test('banner: spawn error is unavailable; close sends SIGTERM to the open banner', async () => {
  const { spawned, banner } = rig();
  const failed = banner.show('t', 'p');
  spawned[0].child.emit('error', new Error('ENOENT'));
  assert.equal(await failed, 'unavailable');
  const open = banner.show('t', 'p');
  banner.close();
  assert.deepEqual(spawned[1].child.signals, ['SIGTERM']);
  spawned[1].child.emit('exit', null);
  assert.equal(await open, 'unavailable');
});
