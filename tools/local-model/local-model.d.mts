// Type declarations for the runtime bridge (src/adapters/llama-local.ts).
export class AnalysisCancelled extends Error {}
export type LocalFailure = { outcome: 'failed'; failureKind: 'timeout' | 'network' | 'malformed'; trace: unknown };
export type LocalSuccess = { outcome: 'success'; value: { risk: 'low' | 'medium' | 'high'; reasons: string[]; cue: string; quote: string | null; partial: boolean }; trace: unknown };
export class LocalModelAdapter {
  constructor(options?: { baseUrl?: string; model?: string; timeoutMs?: number; fetchImpl?: typeof fetch });
  readonly model: string;
  capabilities(): Promise<{ available: boolean; model: string }>;
  analyze(input: { text: string }, signal?: AbortSignal): Promise<LocalSuccess | LocalFailure>;
}
