import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { NativeEyesSource, type NativeEyesChild, type NativeEyesLauncher } from '../src/adapters/native-eyes.ts';

class FakeChild extends EventEmitter implements NativeEyesChild {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly killed: NodeJS.Signals[] = [];
  kill(signal: NodeJS.Signals): boolean { this.killed.push(signal); return true; }
  line(value: unknown): void { this.stdout.write(`${JSON.stringify(value)}\n`); }
  diagnostic(value: unknown): void { this.stderr.write(`${JSON.stringify(value)}\n`); }
}

function frame(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    frame_id: 'native-1', captured_at: '2026-10-11T14:00:00Z', app: 'Safari', bundle_id: 'com.apple.Safari',
    window_title: 'Alert', url: 'https://example.test/alert', text: 'Your computer is infected. Call support now.',
    lines: [{ text: 'Your computer is infected. Call support now.', x: 1, y: 2, w: 3, h: 4 }],
    width: 100, height: 100, capture_ms: 2, ocr_ms: 3, excluded_windows: 1, scope: 'display', reason: 'change', ...overrides,
  };
}

function source(options: Record<string, unknown> = {}) {
  const child = new FakeChild();
  const starts: Array<{ executable: string; args: string[]; env: NodeJS.ProcessEnv | undefined }> = [];
  const launcher: NativeEyesLauncher = (executable, args, options) => {
    starts.push({ executable, args, env: options.env });
    return child;
  };
  const received: unknown[] = [];
  const unavailable: unknown[] = [];
  return {
    child, starts, received, unavailable,
    source: new NativeEyesSource((value) => received.push(value), launcher, (value) => unavailable.push(value), { scope: 'window', fps: 1, ...options }),
  };
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test('native eyes launches through an injected child, publishes TextFrames, and terminates on pause', async () => {
  const h = source();
  const stop = h.source.start();
  h.child.line(frame());
  await tick();
  assert.equal(h.starts.length, 1);
  assert.match(h.starts[0].executable, /tools\/shepherd-eyes\/build\/shepherd-eyes$/);
  assert.deepEqual(h.starts[0].args, ['--scope', 'window', '--fps', '1']);
  assert.deepEqual(h.received, [{
    frame_id: 'native-1', source: 'native', text: 'Your computer is infected. Call support now.',
    captured_at: '2026-10-11T14:00:00Z', app: 'Safari', bundle_id: 'com.apple.Safari', window_title: 'Alert',
    url: 'https://example.test/alert', url_status: 'ok',
    lines: [{ text: 'Your computer is infected. Call support now.', x: 1, y: 2, w: 3, h: 4 }], scope: 'display',
  }]);
  stop();
  h.child.line(frame({ frame_id: 'late' }));
  await tick();
  assert.deepEqual(h.child.killed, ['SIGTERM']);
  assert.equal(h.received.length, 1, 'a late line cannot publish after pause');
});

test('native eyes discards malformed and unknown helper lines but continues with the next valid line', async () => {
  const h = source();
  h.source.start();
  h.child.line({ ...frame(), unexpected: true });
  h.child.stdout.write('{not json}\n');
  h.child.line(frame({ frame_id: 'valid-after-bad', url: null }));
  await tick();
  assert.equal(h.received.length, 1);
  assert.deepEqual(h.received[0], {
    frame_id: 'valid-after-bad', source: 'native', text: 'Your computer is infected. Call support now.',
    captured_at: '2026-10-11T14:00:00Z', app: 'Safari', bundle_id: 'com.apple.Safari', window_title: 'Alert', url: null,
    url_status: 'absent', lines: [{ text: 'Your computer is infected. Call support now.', x: 1, y: 2, w: 3, h: 4 }], scope: 'display',
  });
});

test('native eyes retains only complete UTF-8 lines within 32 KiB and marks oversized URLs unavailable', async () => {
  const h = source();
  h.source.start();
  const firstLine = 'é'.repeat(900); // 1,800 UTF-8 bytes and within the per-line schema limit.
  const keptLines = Array.from({ length: 18 }, () => firstLine);
  const rawLines = [...keptLines, 'ß'.repeat(900)];
  h.child.line(frame({
    text: rawLines.join('\n'),
    lines: rawLines.map((text, index) => ({ text, x: 1, y: index * 20, w: 3, h: 4 })),
    url: `https://example.test/${'x'.repeat(2050)}`,
  }));
  await tick();
  assert.equal(h.received.length, 1);
  const parsed = h.received[0] as { text: string; truncated: boolean; url: null; url_status: string; lines: Array<{ text: string }> };
  assert.equal(parsed.text, keptLines.join('\n'));
  assert.equal(Buffer.byteLength(parsed.text), 32_417);
  assert.equal(parsed.truncated, true);
  assert.equal(parsed.url, null);
  assert.equal(parsed.url_status, 'too_long');
  assert.deepEqual(parsed.lines.map((line) => line.text), keptLines);
});

test('native eyes uses a configured helper path and reports a missing binary as a bounded unavailable state', async () => {
  const h = source({ executable: '/approved/shepherd-eyes' });
  h.source.start();
  h.child.emit('error', Object.assign(new Error('spawn /approved/shepherd-eyes ENOENT secrets must not surface'), { code: 'ENOENT' }));
  await tick();
  assert.equal(h.starts[0].executable, '/approved/shepherd-eyes');
  assert.deepEqual(h.unavailable, [{ code: 'helper_unavailable', message: 'Native screen helper is unavailable.' }]);
});

test('native eyes maps helper stderr and unexpected exits to privacy-safe unavailable states, and ignores them after stop', async () => {
  const h = source();
  const stop = h.source.start();
  h.child.diagnostic({ kind: 'unavailable', message: 'Screen Recording was denied for secret account 1234' });
  await tick();
  assert.deepEqual(h.unavailable, [{ code: 'permission_denied', message: 'Screen Recording is unavailable.' }]);
  h.child.emit('close', 9);
  await tick();
  assert.equal(h.unavailable.length, 1, 'the first active failure is retained');
  stop();
  h.child.diagnostic({ kind: 'capture', message: 'late private text' });
  h.child.emit('error', Error('late error'));
  await tick();
  assert.equal(h.unavailable.length, 1, 'late failures after stop cannot publish');

  const exited = source();
  exited.source.start();
  exited.child.emit('close', 9);
  await tick();
  assert.deepEqual(exited.unavailable, [{ code: 'helper_exited', message: 'Native screen helper stopped unexpectedly.' }]);
});
