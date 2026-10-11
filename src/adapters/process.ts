import { spawn } from 'node:child_process';

export type ProcessRunner = typeof runProcess;

// Allowlist, never process.env: provider credentials and other secrets must not
// reach OCR or any other subprocess (F8). PATH locates the executable.
export function childEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? '/usr/bin:/bin', OMP_THREAD_LIMIT: '1' };
  if (process.env.TESSDATA_PREFIX) env.TESSDATA_PREFIX = process.env.TESSDATA_PREFIX;
  return env;
}

export function runProcess(executable: string, args: string[], input: Buffer, signal: AbortSignal, timeout_ms = 8000, max_output = 32_768): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(Error('OCR aborted')); return; }
    const child = spawn(executable, args, { shell: false, stdio: ['pipe', 'pipe', 'pipe'], env: childEnvironment() });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let failure: Error | undefined;
    const stop = (reason: string) => { failure ??= Error(reason); child.kill('SIGKILL'); };
    const abort = () => stop('OCR aborted');
    const timer = setTimeout(() => stop('OCR timeout'), timeout_ms);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > max_output) stop('OCR output limit');
      else chunks.push(chunk);
    });
    // Drain diagnostics without retaining or logging potentially private page data.
    child.stderr.on('data', () => {});
    child.stdin.on('error', () => stop('OCR input failed'));
    child.on('error', () => { failure ??= Error('OCR executable unavailable'); });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      if (failure) reject(failure);
      else if (code !== 0) reject(Error('OCR exit failure'));
      else resolve(Buffer.concat(chunks).toString('utf8'));
    });
    child.stdin.end(input);
  });
}
