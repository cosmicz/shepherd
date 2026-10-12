// Bridge from the tea llama-server adapter (tools/local-model) to LocalModelPort.
// With a LlamaManager (contract) the tier follows the managed server: until it is
// ready the tier is unavailable at once, so warm-up never costs a 4 s timeout.
import { LocalModelAdapter } from '../../tools/local-model/local-model.mjs';
import { LocalModelError, type LocalModelPort } from '../application/routing.ts';
import type { LlamaState } from './llama-manager.ts';

const describe: Record<LlamaState['state'], string> = {
  disabled: 'Local model not started', starting: 'Local model server starting', warming: 'Local model warming up',
  ready: 'Local model ready', unavailable: 'Local model unavailable', stopped: 'Local model stopped',
};

export class LlamaLocalModel implements LocalModelPort {
  readonly model: string;
  private readonly adapter: LocalModelAdapter;
  private readonly manager?: { status(): LlamaState };

  constructor(options: ConstructorParameters<typeof LocalModelAdapter>[0] & { manager?: { status(): LlamaState } } = {}) {
    const { manager, ...adapterOptions } = options;
    this.adapter = new LocalModelAdapter(adapterOptions);
    this.model = this.adapter.model;
    this.manager = manager;
  }

  async available(): Promise<boolean> {
    if (this.manager) return this.manager.status().state === 'ready';
    return (await this.adapter.capabilities()).available;
  }

  // Human-readable state for capabilities and the companion.
  describe(): string | undefined {
    if (!this.manager) return undefined;
    const status = this.manager.status();
    return status.reason ? `${describe[status.state]}: ${status.reason}` : describe[status.state];
  }

  // The composite validates the value; failures map to the policy's local failure kinds.
  async assess(text: string, signal: AbortSignal): Promise<unknown> {
    if (this.manager && this.manager.status().state !== 'ready') throw new LocalModelError('unavailable');
    const result = await this.adapter.analyze({ text }, signal);
    if (result.outcome === 'success') return result.value;
    if (result.failureKind === 'malformed') throw new LocalModelError('malformed');
    // The adapter's own timer can fire first; report it as a timeout, not unavailable.
    if (result.failureKind === 'timeout') throw new LocalModelError('timeout');
    throw new LocalModelError('unavailable');
  }
}
