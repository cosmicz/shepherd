// Shared test double for local helper processes (voice, accessibility, eyes).
// It stands in for child_process.spawn so adapter tests never execute a helper,
// open a microphone or trigger a macOS permission prompt.
import { EventEmitter } from 'node:events';
import type { SpawnOptions } from 'node:child_process';
import { PassThrough } from 'node:stream';

export class FakeHelper extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly signals: NodeJS.Signals[] = [];
  kill(signal: NodeJS.Signals): boolean { this.signals.push(signal); return true; }
  // One JSON line on stdout (a string is written verbatim, for malformed lines).
  line(value: unknown): void { this.stdout.write(`${typeof value === 'string' ? value : JSON.stringify(value)}\n`); }
  diagnostic(text: string): void { this.stderr.write(`${text}\n`); }
  exit(code: number | null): void { this.emit('close', code); }
  fail(error = Error('spawn ENOENT')): void { this.emit('error', error); }
}

export interface Launch { executable: string; args: string[]; options: SpawnOptions }

// A launcher for adapters that inject one; every launch is recorded.
export function fakeLauncher() {
  const launches: Launch[] = [];
  const helpers: FakeHelper[] = [];
  const launch = (executable: string, args: string[], options: SpawnOptions) => {
    launches.push({ executable, args, options });
    const helper = new FakeHelper();
    helpers.push(helper);
    return helper;
  };
  return { launch, launches, helpers, get last() { return helpers.at(-1) as FakeHelper; } };
}

// Lets readline deliver lines written to a PassThrough.
export const settle = () => new Promise((resolve) => setImmediate(resolve));
