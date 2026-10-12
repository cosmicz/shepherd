import { spawn, type SpawnOptions } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { parseTextFrame, record, type TextFrame, type TextLine } from '../domain/assessment.ts';
import type { Observation, ObservationSource } from '../application/observation.ts';
import { childEnvironment } from './process.ts';

const bundledHelperPath = fileURLToPath(new URL('../../tools/shepherd-accessibility/build/shepherd-accessibility', import.meta.url));
const helperFields = new Set(['app', 'bundle_id', 'window_title', 'url', 'url_status', 'text', 'nodes', 'reason']);

export interface AccessibilityChild {
  stdout: NodeJS.ReadableStream | null;
  kill(signal: NodeJS.Signals): boolean;
}
export type AccessibilityLauncher = (executable: string, args: string[], options: SpawnOptions) => AccessibilityChild;

export interface AccessibilityTreeOptions {
  executable?: string;
  interval_ms?: number;
  depth?: number;
  max_nodes?: number;
  exclude_nonce?: string;
  now?: () => number;
  id?: () => string;
}

function launchHelper(executable: string, args: string[], options: SpawnOptions): AccessibilityChild {
  return spawn(executable, args, options);
}

function orderedNodes(value: unknown): TextLine[] {
  if (!Array.isArray(value) || value.length > 2_000) throw Error('Invalid accessibility nodes');
  const nodes = value.map((item) => {
    const node = record(item);
    if (Object.keys(node).some((key) => !['role', 'text', 'x', 'y', 'w', 'h'].includes(key))) throw Error('Unknown accessibility node field');
    const { text, x, y, w, h } = node;
    if (typeof text !== 'string' || typeof x !== 'number' || typeof y !== 'number' || typeof w !== 'number' || typeof h !== 'number') throw Error('Invalid accessibility node');
    return { text, x, y, w, h };
  });
  // Validate line strings and geometry with the canonical wire parser below,
  // but establish the content order here rather than trusting helper ordering.
  return nodes.sort((left, right) => Number(left.y) - Number(right.y) || Number(left.x) - Number(right.x));
}

function parseHelperLine(line: string, captured_at: string, id: () => string) {
  const raw = record(JSON.parse(line));
  if (Object.keys(raw).some((key) => !helperFields.has(key))) throw Error('Unknown accessibility helper field');
  if (raw.reason !== 'change' && raw.reason !== 'interval') throw Error('Invalid accessibility reason');
  if (typeof raw.text !== 'string') throw Error('Invalid accessibility text');
  const lines = orderedNodes(raw.nodes);
  const text = lines.map((node) => node.text).join('\n');
  if (raw.text !== text) throw Error('Inconsistent accessibility text');
  return parseTextFrame({
    frame_id: id(), source: 'accessibility', text, lines, captured_at,
    ...(raw.app === undefined ? {} : { app: raw.app }),
    ...(raw.bundle_id === undefined ? {} : { bundle_id: raw.bundle_id }),
    ...(raw.window_title === undefined ? {} : { window_title: raw.window_title }),
    ...(raw.url === undefined ? { url: null, url_status: 'absent' } : { url: raw.url, url_status: raw.url_status }),
  });
}

/**
 * Turns the operator-authorized Accessibility helper's JSONL into transient
 * observations. The injected launch boundary keeps tests prompt-free.
 */
export class AccessibilityTreeSource implements ObservationSource {
  readonly id = 'accessibility';
  private generation = 0;
  private stopCurrent?: () => void;
  private readonly launcher: AccessibilityLauncher;
  private readonly options: AccessibilityTreeOptions;
  private readonly now: () => number;
  private readonly makeId: () => string;

  constructor(launcher: AccessibilityLauncher = launchHelper, options: AccessibilityTreeOptions = {}) {
    this.launcher = launcher;
    this.options = options;
    this.now = options.now ?? Date.now;
    // Keep Web Crypto's receiver intact; assigning randomUUID directly and
    // later invoking it as a method of this adapter throws in Node 22.
    this.makeId = options.id ?? (() => crypto.randomUUID());
  }

  private consumeFrames(publish: (frame: TextFrame) => void): () => void {
    this.stop();
    const generation = ++this.generation;
    const args: string[] = [];
    if (this.options.interval_ms !== undefined) args.push('--interval-ms', String(this.options.interval_ms));
    if (this.options.depth !== undefined) args.push('--depth', String(this.options.depth));
    if (this.options.max_nodes !== undefined) args.push('--max-nodes', String(this.options.max_nodes));
    if (this.options.exclude_nonce) args.push('--exclude-nonce', this.options.exclude_nonce);
    const executable = this.options.executable ?? process.env.SHEPHERD_ACCESSIBILITY_BIN ?? bundledHelperPath;
    const child = this.launcher(executable, args, { shell: false, stdio: ['ignore', 'pipe', 'ignore'], env: childEnvironment() });
    const lines = child.stdout ? createInterface({ input: child.stdout }) : undefined;
    lines?.on('line', (line) => {
      if (generation !== this.generation) return;
      try {
        const captured_at = new Date(this.now()).toISOString();
        const frame = parseHelperLine(line, captured_at, this.makeId);
        publish(frame);
      } catch { /* Discard malformed transient Accessibility text without logging it. */ }
    });
    const stop = () => {
      if (generation !== this.generation) return;
      this.generation += 1;
      lines?.close();
      child.kill('SIGTERM');
    };
    this.stopCurrent = stop;
    return stop;
  }

  start(publish: (observation: Observation) => void): () => void {
    return this.consumeFrames((frame) => {
      const captured_at = frame.captured_at;
      publish({
          id: this.makeId(), observed_at: captured_at, source: 'accessibility', frame_id: frame.frame_id,
          ...(frame.app === undefined ? {} : { app: frame.app }),
          ...(frame.bundle_id === undefined ? {} : { bundle_id: frame.bundle_id }),
          ...(frame.window_title === undefined ? {} : { window_title: frame.window_title }),
          payload: { ocr_text: frame.text, ocr_complete: true },
        });
    });
  }

  /** Runtime bridge: preserve AX URL/title/app for local rule and trace context. */
  startFrames(publish: (frame: TextFrame) => void): () => void { return this.consumeFrames(publish); }

  stop(): void { this.stopCurrent?.(); this.stopCurrent = undefined; }
}
