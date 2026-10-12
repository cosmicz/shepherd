export type Feed = { category: 'malware' | 'phishing'; url: string };
export type Manifest = { version: 1; source: string; revision: string; retrieved_at: string; feeds: Array<{ category: string; accepted: number; rejected: number; hosts: string[] }> };
export function normalizeHost(value: unknown): string | undefined;
export function refreshFeeds(options: { storage: string; feeds: readonly Feed[]; revisionUrl: string; licenseUrl: string; fetchImpl?: typeof fetch; now?: Date; timeoutMs?: number; maxBytes?: number }): Promise<Manifest>;
export function loadSnapshot(storage: string, options?: { now?: number; maxAgeMs?: number }): Promise<{ status: 'missing' | 'unavailable' } | { status: 'fresh' | 'stale'; manifest: Manifest; index: Map<string, string[]> }>;
export function tagJsonl(options: { storage: string; input: string; output: string; now?: number; maxAgeMs?: number }): Promise<{ records: number; freshness: 'fresh' | 'stale' }>;
