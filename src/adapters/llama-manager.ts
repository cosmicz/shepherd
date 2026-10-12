// The runtime manages llama-server itself (contract, operator 14:57). It reuses a
// server already answering the loopback port and never signals one it did not
// start; otherwise it spawns llama-server for SHEPHERD_LOCAL_MODEL (no shell,
// minimal environment, output drained and never logged), polls /health, warms the
// model once and only then reports the local tier ready. A managed server that
// exits unexpectedly is restarted once after a backoff. Stop sends SIGTERM, then
// SIGKILL after a grace period, to its own child only.
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { accessSync, constants } from 'node:fs';

export type LlamaPhase = 'disabled' | 'starting' | 'warming' | 'ready' | 'unavailable' | 'stopped';
export interface LlamaState { state: LlamaPhase; managed: boolean; reason?: string }
export type SpawnLike = (binary: string, args: string[], options: { env: NodeJS.ProcessEnv; stdio: ['ignore', 'pipe', 'pipe'] }) => ChildProcess;

export interface LlamaManagerOptions {
  model?: string;
  binary?: string;
  host?: string;
  port?: number;
  healthTimeoutMs?: number;
  pollMs?: number;
  restartBackoffMs?: number;
  stopGraceMs?: number;
  spawn?: SpawnLike;
  fetchImpl?: typeof fetch;
  onChange?: (state: LlamaState) => void;
}

export class LlamaManager {
  private current: LlamaState = { state: 'disabled', managed: false };
  private child?: ChildProcess;
  private stopping = false;
  private restarted = false;
  private readonly options: Required<Omit<LlamaManagerOptions, 'model' | 'onChange'>> & Pick<LlamaManagerOptions, 'model' | 'onChange'>;

  constructor(options: LlamaManagerOptions = {}) {
    this.options = {
      binary: 'llama-server', host: '127.0.0.1', port: 8080, healthTimeoutMs: 60_000, pollMs: 500, restartBackoffMs: 3000, stopGraceMs: 5000,
      spawn: nodeSpawn as unknown as SpawnLike, fetchImpl: fetch, ...options,
    };
  }

  get baseUrl(): string { return `http://${this.options.host}:${this.options.port}`; }
  status(): LlamaState { return { ...this.current }; }

  private set(state: LlamaPhase, reason?: string): void {
    this.current = { state, managed: !!this.child, ...(reason ? { reason } : {}) };
    this.options.onChange?.(this.status());
  }

  private async healthy(): Promise<boolean> {
    try { return (await this.options.fetchImpl(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; }
  }

  private async warm(): Promise<boolean> {
    try {
      const response = await this.options.fetchImpl(`${this.baseUrl}/v1/chat/completions`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(30_000),
        body: JSON.stringify({ messages: [{ role: 'system', content: '/no_think' }, { role: 'user', content: 'warm' }], max_tokens: 1, chat_template_kwargs: { enable_thinking: false } }),
      });
      return response.ok;
    } catch { return false; }
  }

  async start(): Promise<void> {
    this.stopping = false;
    // Reuse a server someone else started; never manage or signal it.
    if (await this.healthy()) {
      this.set('warming');
      if (await this.warm()) this.set('ready'); else this.set('unavailable', 'Local model server answered but warm-up failed');
      return;
    }
    const model = this.options.model;
    if (!model) { this.set('unavailable', 'No local model configured (SHEPHERD_LOCAL_MODEL)'); return; }
    try { accessSync(model, constants.R_OK); } catch { this.set('unavailable', 'Local model file not found or unreadable'); return; }
    await this.launch(model);
  }

  private async launch(model: string): Promise<void> {
    let failure: string | undefined;
    const args = ['-m', model, '--host', this.options.host, '--port', String(this.options.port), '-c', '8192', '--jinja'];
    const child = this.options.spawn(this.options.binary, args, {
      // Minimal environment: nothing from the runtime (provider keys) reaches the child.
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin:/opt/homebrew/bin', HOME: process.env.HOME },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;
    this.set('starting');
    // Drain output without retaining or logging it.
    child.stdout?.on('data', () => {});
    child.stderr?.on('data', () => {});
    child.on('error', () => { failure = 'llama-server could not be started (binary missing or not executable)'; });
    child.on('exit', () => this.exited(child, model));

    const deadline = Date.now() + this.options.healthTimeoutMs;
    while (Date.now() < deadline && !failure && this.child === child) {
      if (await this.healthy()) break;
      await new Promise((resolve) => setTimeout(resolve, this.options.pollMs));
    }
    if (this.child !== child) return;
    if (failure) { this.child = undefined; this.set('unavailable', failure); return; }
    if (!(await this.healthy())) { await this.terminate(child); this.set('unavailable', 'Local model server did not pass its health check in time'); return; }
    this.set('warming');
    if (await this.warm()) this.set('ready');
    else { await this.terminate(child); this.set('unavailable', 'Local model warm-up failed'); }
  }

  private exited(child: ChildProcess, model: string): void {
    if (this.child !== child) return;
    this.child = undefined;
    if (this.stopping) return;
    this.set('unavailable', 'Local model server exited unexpectedly');
    if (this.restarted) return;
    this.restarted = true;
    setTimeout(() => { if (!this.stopping) void this.launch(model); }, this.options.restartBackoffMs);
  }

  private async terminate(child: ChildProcess): Promise<void> {
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    this.stopping = true;
    child.kill('SIGTERM');
    const graceful = await Promise.race([exited.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), this.options.stopGraceMs))]);
    if (!graceful) child.kill('SIGKILL');
    if (this.child === child) this.child = undefined;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const child = this.child;
    if (child) await this.terminate(child);
    this.set('stopped');
  }
}
