// Native in-place alert banner (contract). The runtime spawns the AppKit helper
// tools/shepherd-banner with the fixed template text and the pattern label only,
// never screen or model text; no shell, minimal environment. The helper prints one
// JSON line {"action":"call"|"fine"|"timeout"} and exits. One banner at a time;
// anything else (spawn failure, bad output, hard deadline) reports 'unavailable'.
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';

export type BannerAction = 'call' | 'fine' | 'timeout' | 'busy' | 'unavailable';
export interface BannerPort { show(text: string, pattern: string): Promise<BannerAction>; close(): void }
export type BannerSpawn = (binary: string, args: string[], options: { env: NodeJS.ProcessEnv; stdio: ['ignore', 'pipe', 'ignore'] }) => ChildProcess;

export interface NativeBannerOptions {
  binary: string;
  // Window title; carries the capture-exclusion nonce so Shepherd never reads its own banner.
  title: string;
  timeout_s?: number;
  spawn?: BannerSpawn;
}

const MAX_OUTPUT = 1024;

export class NativeBanner implements BannerPort {
  private child?: ChildProcess;
  private readonly timeout_s: number;
  private readonly spawn: BannerSpawn;

  constructor(private readonly options: NativeBannerOptions) {
    this.timeout_s = options.timeout_s ?? 45;
    this.spawn = options.spawn ?? (nodeSpawn as unknown as BannerSpawn);
  }

  show(text: string, pattern: string): Promise<BannerAction> {
    if (this.child) return Promise.resolve('busy');
    return new Promise((resolve) => {
      let child: ChildProcess;
      try {
        child = this.spawn(this.options.binary, ['--text', text, '--pattern', pattern, '--title', this.options.title, '--timeout', String(this.timeout_s)], {
          env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME }, stdio: ['ignore', 'pipe', 'ignore'],
        });
      } catch { resolve('unavailable'); return; }
      this.child = child;
      let output = '';
      let settled = false;
      const finish = (action: BannerAction) => {
        if (settled) return;
        settled = true;
        clearTimeout(hard);
        if (this.child === child) this.child = undefined;
        resolve(action);
      };
      // The helper closes itself at timeout_s; a hung helper is killed 5 s later.
      const hard = setTimeout(() => { child.kill('SIGKILL'); finish('unavailable'); }, (this.timeout_s + 5) * 1000);
      child.stdout?.on('data', (chunk: Buffer) => { if (output.length < MAX_OUTPUT) output += chunk.toString('utf8').slice(0, MAX_OUTPUT - output.length); });
      child.on('error', () => finish('unavailable'));
      child.on('exit', (code) => finish(code === 0 ? parseAction(output) : 'unavailable'));
    });
  }

  close(): void { this.child?.kill('SIGTERM'); }
}

export function parseAction(output: string): BannerAction {
  try {
    const action = (JSON.parse(output.trim().split('\n')[0] ?? '') as { action?: unknown }).action;
    return action === 'call' || action === 'fine' || action === 'timeout' ? action : 'unavailable';
  } catch { return 'unavailable'; }
}
