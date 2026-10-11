import { spawn, type SpawnOptions } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { childEnvironment } from './process.ts';
import { parseTextFrame, record, type TextFrame } from '../domain/assessment.ts';

const MAX_TEXT_BYTES = 32 * 1024;
const bundledHelperPath = fileURLToPath(new URL('../../tools/shepherd-eyes/build/shepherd-eyes', import.meta.url));
const helperFields = new Set([
  'frame_id', 'captured_at', 'app', 'bundle_id', 'window_title', 'url', 'text', 'lines',
  'width', 'height', 'capture_ms', 'ocr_ms', 'excluded_windows', 'scope', 'reason',
]);

export interface NativeEyesChild {
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  kill(signal: NodeJS.Signals): boolean;
  on(event: 'error' | 'close', listener: (...args: unknown[]) => void): unknown;
}

export type NativeEyesLauncher = (executable: string, args: string[], options: SpawnOptions) => NativeEyesChild;

export interface NativeEyesOptions {
  executable?: string;
  scope?: 'display' | 'window';
  fps?: number;
  include_app?: string;
  exclude_nonce?: string;
}

export interface NativeEyesUnavailable {
  code: 'helper_unavailable' | 'permission_denied' | 'helper_failed' | 'helper_exited';
  message: string;
}

function launchHelper(executable: string, args: string[], options: SpawnOptions): NativeEyesChild {
  return spawn(executable, args, options);
}

function helperFailure(line: string): NativeEyesUnavailable {
  const value = record(JSON.parse(line));
  if (value.kind === 'unavailable') return { code: 'permission_denied', message: 'Screen Recording is unavailable.' };
  if (value.kind === 'usage') return { code: 'helper_unavailable', message: 'Native screen helper is unavailable.' };
  return { code: 'helper_failed', message: 'Native screen helper failed.' };
}

function boundedText(text: string): { text: string; lineCount: number; truncated: boolean } {
  if (Buffer.byteLength(text) <= MAX_TEXT_BYTES) return { text, lineCount: text ? text.split('\n').length : 0, truncated: false };
  let bytes = 0;
  let end = 0;
  let lineCount = 0;
  for (const line of text.split('\n')) {
    const lineBytes = Buffer.byteLength(line);
    const separator = lineCount === 0 ? 0 : 1;
    if (bytes + separator + lineBytes > MAX_TEXT_BYTES) break;
    bytes += separator + lineBytes;
    end += separator + line.length;
    lineCount += 1;
  }
  // Keep only complete OCR lines. A first line larger than the cap is omitted,
  // rather than cut mid-line and then treated as a complete screen reading.
  return { text: text.slice(0, end), lineCount, truncated: true };
}

function parseHelperLine(line: string): TextFrame {
  const raw = record(JSON.parse(line));
  if (Object.keys(raw).some((key) => !helperFields.has(key))) throw Error('Unknown native helper field');
  if (typeof raw.text !== 'string') throw Error('Invalid native helper text');

  const bounded = boundedText(raw.text);
  const rawUrl = raw.url;
  let url: string | null | undefined;
  let url_status: 'ok' | 'too_long' | 'absent';
  if (rawUrl === undefined || rawUrl === null) {
    url = null;
    url_status = 'absent';
  } else if (typeof rawUrl === 'string') {
    if (rawUrl.length > 2048) {
      url = null;
      url_status = 'too_long';
    } else {
      url = rawUrl;
      url_status = 'ok';
    }
  } else {
    throw Error('Invalid native helper URL');
  }

  const frame: Record<string, unknown> = {
    frame_id: raw.frame_id,
    source: 'native',
    text: bounded.text,
    captured_at: raw.captured_at,
    url,
    url_status,
    truncated: bounded.truncated || undefined,
  };
  for (const key of ['app', 'bundle_id', 'window_title', 'scope'] as const) {
    if (raw[key] !== undefined) frame[key] = raw[key];
  }
  if (raw.lines !== undefined) {
    if (!Array.isArray(raw.lines)) throw Error('Invalid native helper lines');
    frame.lines = raw.lines.slice(0, bounded.lineCount);
  }
  return parseTextFrame(frame);
}

/**
 * Turns the operator-authorized Swift helper's JSONL stream into transient native
 * TextFrames. The launch boundary is injectable so tests never run the helper.
 */
export class NativeEyesSource {
  private generation = 0;
  private stopCurrent?: () => void;

  constructor(
    private readonly publish: (frame: TextFrame) => void,
    private readonly launcher: NativeEyesLauncher = launchHelper,
    private readonly unavailable: (state: NativeEyesUnavailable) => void = () => {},
    private readonly options: NativeEyesOptions = {},
  ) {}

  start(): () => void {
    this.stopCurrent?.();
    const generation = ++this.generation;
    const args = ['--scope', this.options.scope ?? 'display'];
    if (this.options.fps !== undefined) args.push('--fps', String(this.options.fps));
    if (this.options.include_app) args.push('--include-app', this.options.include_app);
    if (this.options.exclude_nonce) args.push('--exclude-nonce', this.options.exclude_nonce);
    const executable = this.options.executable ?? process.env.SHEPHERD_EYES_BIN ?? bundledHelperPath;
    const child = this.launcher(executable, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'], env: childEnvironment() });
    let stdoutLines: ReturnType<typeof createInterface> | undefined;
    let stderrLines: ReturnType<typeof createInterface> | undefined;
    let reported = false;
    const report = (state: NativeEyesUnavailable) => {
      if (generation !== this.generation || reported) return;
      reported = true;
      this.unavailable(state);
    };
    const stop = () => {
      if (generation !== this.generation) return;
      this.generation += 1;
      stdoutLines?.close();
      stderrLines?.close();
      child.kill('SIGTERM');
    };
    this.stopCurrent = stop;
    if (!child.stdout) report({ code: 'helper_unavailable', message: 'Native screen helper is unavailable.' });
    else {
      stdoutLines = createInterface({ input: child.stdout });
      stdoutLines.on('line', (line) => {
        if (generation !== this.generation) return;
        try { this.publish(parseHelperLine(line)); }
        catch { /* Malformed helper output is discarded; it contains transient screen text. */ }
      });
    }
    if (child.stderr) {
      stderrLines = createInterface({ input: child.stderr });
      stderrLines.on('line', (line) => {
        try { report(helperFailure(line)); }
        catch { report({ code: 'helper_failed', message: 'Native screen helper failed.' }); }
      });
    }
    child.on('error', () => report({ code: 'helper_unavailable', message: 'Native screen helper is unavailable.' }));
    child.on('close', (code) => {
      if (code !== 0) report({ code: 'helper_exited', message: 'Native screen helper stopped unexpectedly.' });
    });
    return stop;
  }
}
