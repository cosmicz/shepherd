// Type declarations for the runtime bridge (src/adapters/openrouter-judge.ts).
export class AnalysisCancelled extends Error {}
export class CloudPreconditionError extends Error { failureKind: string }
export interface CloudRequestInput {
  model: string; excerpt: string; rulesReasons: string[]; localRisk: 'low' | 'medium' | 'high'; localReasons: string[]; source: string; patternHints: string[];
}
export function redactExcerpt(excerpt: string): string;
export function buildCloudRequest(input: CloudRequestInput): { value: unknown; text: string; bytesOut: number; redactedExcerpt: string };
export function parseVerdict(value: unknown): { verdict: 'scam' | 'suspicious' | 'benign' | 'unclear'; reasons: string[]; pattern: string; rationale: string };
export type Transport = (request: { body: string; signal: AbortSignal }) => Promise<unknown>;
export function createOpenRouterTransport(options: { apiKey: string; fetchImpl?: typeof fetch; referer?: string; title?: string }): Transport;
export type DispatchResult =
  | { outcome: 'success'; verdict: ReturnType<typeof parseVerdict>; remoteCalls: 1; bytesOut: number; body: string; redactedExcerpt: string; cost: { known: boolean; usd: number } }
  | { outcome: 'inconclusive'; failureKind: string; remoteCalls: 0 | 1; bytesOut: number; body: string; redactedExcerpt: string; cost: { known: boolean; usd: number } };
export function dispatchCloudJudge(args: {
  context: { signal: AbortSignal; frame: unknown; now?: Date; providerReachable: boolean; inFlight: number; budgetAvailable: boolean };
  request: CloudRequestInput; transport: Transport; timeoutMs?: number;
}): Promise<DispatchResult>;
