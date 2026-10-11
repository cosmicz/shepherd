// Bridge from the llama-server adapter (tools/local-model) to LocalModelPort.
import { LocalModelAdapter } from '../../tools/local-model/local-model.mjs';
import { LocalModelError, type LocalModelPort } from '../application/routing.ts';

export class LlamaLocalModel implements LocalModelPort {
  readonly model: string;
  private readonly adapter: LocalModelAdapter;

  constructor(options: ConstructorParameters<typeof LocalModelAdapter>[0] = {}) {
    this.adapter = new LocalModelAdapter(options);
    this.model = this.adapter.model;
  }

  async available(): Promise<boolean> { return (await this.adapter.capabilities()).available; }

  // The composite validates the value; failures map to the policy's local failure kinds.
  async assess(text: string, signal: AbortSignal): Promise<unknown> {
    const result = await this.adapter.analyze({ text }, signal);
    if (result.outcome === 'success') return result.value;
    if (result.failureKind === 'malformed') throw new LocalModelError('malformed');
    if (result.failureKind === 'timeout') throw new DOMException('Local model deadline exceeded', 'TimeoutError');
    throw new LocalModelError('unavailable');
  }
}
