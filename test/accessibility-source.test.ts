import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { AccessibilityTreeSource, type AccessibilityChild, type AccessibilityLauncher } from '../src/adapters/accessibility.ts';
import { parseTextFrame } from '../src/domain/assessment.ts';

class FakeChild implements AccessibilityChild {
  readonly stdout = new PassThrough();
  readonly signals: NodeJS.Signals[] = [];
  kill(signal: NodeJS.Signals): boolean { this.signals.push(signal); return true; }
  line(value: unknown): void { this.stdout.write(`${JSON.stringify(value)}\n`); }
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test('the text-frame wire parser preserves the additive accessibility source', () => {
  const frame = parseTextFrame({ frame_id: 'ax-1', source: 'accessibility', text: '', captured_at: '2026-10-11T15:00:00Z' });
  assert.equal(frame.source, 'accessibility');
});

function helperLine(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    app: 'Safari', bundle_id: 'com.apple.Safari', window_title: 'Example',
    url: null, url_status: 'absent', reason: 'change',
    text: 'First line\nSecond line',
    nodes: [
      { role: 'AXStaticText', text: 'Second line', x: 10, y: 40, w: 60, h: 12 },
      { role: 'AXStaticText', text: 'First line', x: 10, y: 20, w: 50, h: 12 },
    ],
    ...overrides,
  };
}

test('accessibility adapter launches only the injected helper and maps ordered JSONL nodes to an accessibility observation', async () => {
  const child = new FakeChild();
  const launches: Array<{ executable: string; args: string[]; shell?: boolean | string; stdio?: unknown; env?: NodeJS.ProcessEnv }> = [];
  const launcher: AccessibilityLauncher = (executable, args, options) => {
    launches.push({ executable, args, shell: options.shell, stdio: options.stdio, env: options.env });
    return child;
  };
  const received: unknown[] = [];
  const source = new AccessibilityTreeSource(launcher, {
    executable: '/approved/shepherd-accessibility', interval_ms: 1_000, depth: 8, max_nodes: 50, exclude_nonce: 'session-17',
    now: () => 1_000, id: (() => { let next = 0; return () => `id-${++next}`; })(),
  });

  const stop = source.start((observation) => received.push(observation));
  child.line(helperLine());
  await tick();

  assert.equal(launches.length, 1);
  assert.equal(launches[0].executable, '/approved/shepherd-accessibility');
  assert.deepEqual(launches[0].args, ['--interval-ms', '1000', '--depth', '8', '--max-nodes', '50', '--exclude-nonce', 'session-17']);
  assert.equal(launches[0].shell, false);
  assert.deepEqual(launches[0].stdio, ['ignore', 'pipe', 'ignore']);
  assert.ok(launches[0].env?.PATH);
  assert.deepEqual(received, [{
    id: 'id-2', observed_at: '1970-01-01T00:00:01.000Z', source: 'accessibility', frame_id: 'id-1',
    app: 'Safari', bundle_id: 'com.apple.Safari', window_title: 'Example',
    payload: { ocr_text: 'First line\nSecond line', ocr_complete: true },
  }]);

  stop();
  child.line(helperLine({ text: 'late' }));
  await tick();
  assert.deepEqual(child.signals, ['SIGTERM']);
  assert.equal(received.length, 1, 'a late helper line cannot publish after stop');
});

test('accessibility adapter discards malformed, inconsistent, and unknown helper lines without retaining text', async () => {
  const child = new FakeChild();
  const source = new AccessibilityTreeSource(() => child, { executable: '/approved/shepherd-accessibility' });
  const received: unknown[] = [];
  source.start((observation) => received.push(observation));
  child.stdout.write('{not json}\n');
  child.line(helperLine({ unexpected: true }));
  child.line(helperLine({ text: 'not the ordered node text' }));
  child.line(helperLine({ url: 'https://example.test', url_status: 'absent' }));
  child.line(helperLine({ text: '', nodes: [] }));
  await tick();
  assert.equal(received.length, 1);
  assert.deepEqual((received[0] as { payload: { ocr_text: string } }).payload, { ocr_text: '', ocr_complete: true });
});

test('runtime frame bridge keeps the AX URL so the rules and trace retain local provenance', async () => {
  const child = new FakeChild();
  const source = new AccessibilityTreeSource(() => child, { executable: '/approved/shepherd-accessibility', now: () => 1_000, id: () => 'ax-1' });
  const frames: unknown[] = [];
  source.startFrames((frame) => frames.push(frame));
  child.line(helperLine({ url: 'https://lookalike.example/login', url_status: 'ok' }));
  await tick();
  assert.deepEqual(frames, [{
    frame_id: 'ax-1', source: 'accessibility', text: 'First line\nSecond line',
    lines: [{ text: 'First line', x: 10, y: 20, w: 50, h: 12 }, { text: 'Second line', x: 10, y: 40, w: 60, h: 12 }],
    captured_at: '1970-01-01T00:00:01.000Z', app: 'Safari', bundle_id: 'com.apple.Safari', window_title: 'Example',
    url: 'https://lookalike.example/login', url_status: 'ok',
  }]);
});
