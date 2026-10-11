// Composite analyzer, the contract v2 (child btb): rules -> local model ->
// cloud judge, driven by the pure policy in domain/policy.ts. Every tier runs
// under AbortSignal.any([caller, deadline]); the caller's abort is checked first
// and surfaces as AnalysisCancelled, which yields no Assessment at all.
import { createHash } from 'node:crypto';

import {
  analyzeText, checkGrant, makeUnavailable, reasonCodes,
  POLICY_VERSION, PROMPT_VERSION, SCHEMA_VERSION,
  type Analyzer, type Assessment, type FailureKind, type Frame, type Pattern, type Reason, type RouteStep, type Status,
} from '../domain/assessment.ts';
import { decide, type CloudView, type Decision, type Gate, type LocalView, type Risk, type Verdict } from '../domain/policy.ts';
import { AnalysisCancelled, type AnalyzerPort, type Capability } from './analyzer.ts';

export { AnalysisCancelled };

export const DEADLINES = { extract_ms: 8000, local_ms: 4000, cloud_ms: 10_000, total_ms: 16_000 } as const;

// Tier 0 input: OCR for pixel frames, the helper's text for native frames.
export interface TextExtractor { extract(frame: Frame, signal: AbortSignal): Promise<string> }

export interface LocalModelResult { risk: Risk; reasons: Reason[]; cue: string }
export class LocalModelError extends Error {
  constructor(readonly failure_kind: 'unavailable' | 'malformed') { super(failure_kind); this.name = 'LocalModelError'; }
}
// Implemented by tea (llama-server). Throws LocalModelError; honours the signal.
export interface LocalModelPort {
  readonly model: string;
  assess(text: string, signal: AbortSignal): Promise<unknown>;
  available(): Promise<boolean>;
}

export interface CloudJudgeRequest {
  excerpt: string; rulesReasons: Reason[]; localRisk: Risk; localReasons: Reason[]; source: Frame['source']; patternHints: Pattern[];
}
export type CloudJudgeOutcome =
  | { ok: true; verdict: Verdict; reasons: Reason[]; pattern: Pattern; rationale: string; bytes_out: number; payload_sha256: string; cost: { known: boolean; usd: number } }
  | { ok: false; failure_kind: Exclude<FailureKind, 'no_consent' | 'budget' | 'no_anchor'>; bytes_out: number; payload_sha256?: string; cost: { known: boolean; usd: number } };
// Implemented over the gsg adapter. redact() is the same redaction judge() applies.
export interface CloudJudgePort {
  readonly model: string;
  available(): boolean;
  redact(excerpt: string): string;
  // Exact serialized body size and hash, for attempts that never return.
  measure(request: CloudJudgeRequest): { bytes_out: number; payload_sha256: string };
  // The frame lets the adapter re-check its own grant preconditions at dispatch.
  judge(request: CloudJudgeRequest, signal: AbortSignal, frame: Frame): Promise<CloudJudgeOutcome>;
}

// Live consent authority (server-side grant registry): a grant carried by the
// frame counts only while the registry still holds it unrevoked.
export interface ConsentPort { live(frame: Frame, now: number): boolean }

// Per-session bounds: at most 6 dispatches per 10 minutes and USD 0.50 known
// cost per day; an attempt with unknown cost counts as USD 0.02.
export class CloudGovernor {
  private dispatches: number[] = [];
  private spend: Array<{ at: number; usd: number }> = [];
  private cache = new Map<string, { at: number; verdict: Extract<CloudJudgeOutcome, { ok: true }> }>();
  constructor(private readonly limits = { per_window: 6, window_ms: 10 * 60_000, usd_per_day: 0.5, unknown_usd: 0.02, cache_ttl_ms: 10 * 60_000, cache_size: 50 }) {}

  allows(now: number): boolean {
    this.dispatches = this.dispatches.filter((at) => now - at < this.limits.window_ms);
    this.spend = this.spend.filter((item) => now - item.at < 24 * 3600_000);
    return this.dispatches.length < this.limits.per_window && this.spend.reduce((sum, item) => sum + item.usd, 0) < this.limits.usd_per_day;
  }
  record(now: number, cost: { known: boolean; usd: number }): void {
    this.dispatches.push(now);
    this.spend.push({ at: now, usd: cost.known ? cost.usd : this.limits.unknown_usd });
  }
  cached(key: string, now: number) {
    const hit = this.cache.get(key);
    if (hit && now - hit.at < this.limits.cache_ttl_ms) return hit.verdict;
    this.cache.delete(key);
    return undefined;
  }
  remember(key: string, now: number, verdict: Extract<CloudJudgeOutcome, { ok: true }>): void {
    this.cache.set(key, { at: now, verdict });
    while (this.cache.size > this.limits.cache_size) this.cache.delete(this.cache.keys().next().value as string);
  }
  // Pause, source change and session end clear the cache.
  clear(): void { this.cache.clear(); }
}

const versions = { policy: POLICY_VERSION, prompt: PROMPT_VERSION, schema: SCHEMA_VERSION };
const free = { known: true, usd: 0 };
const patternReason: Record<Pattern, Reason> = {
  tech_support: 'support_pressure', celebrity_investment: 'investment_pressure', family_emergency: 'family_emergency',
  government_impersonation: 'impersonation', prize_or_lottery: 'prize_claim', romance: 'payment_pressure',
  credential_phishing: 'credential_pressure', remote_access: 'remote_access', other: 'impersonation',
};
const messages = {
  concern: 'This screen uses a pressure pattern. Pause and check who is asking before taking action.',
  caution: 'This page has signs of a scam. Pause and check with someone you trust before doing anything.',
  no_signal: 'No configured pressure pattern was found. This does not verify who is behind the screen.',
  inconclusive: 'Shepherd could not tell whether this screen is safe to act on. Pause and check with someone you trust.',
  unavailable: 'The local analyzer could not assess this screen. Try again or check the local service.',
} as const;

// AbortSignal.any([caller, timeout]) with a timer that keeps the process alive
// until the tier settles (AbortSignal.timeout's timer does not) and is cleared after.
function deadline(caller: AbortSignal, ms: number): { signal: AbortSignal; clear: () => void } {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(new DOMException('Tier deadline exceeded', 'TimeoutError')), Math.max(1, ms));
  return { signal: AbortSignal.any([caller, timeout.signal]), clear: () => clearTimeout(timer) };
}
// Resolves with the work, or rejects as soon as the signal aborts, so a late
// completion after its deadline is discarded rather than interpreted.
function within<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    work.then((value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
      (error) => { signal.removeEventListener('abort', onAbort); reject(error); });
  });
}
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

const WINDOW_CHARS = 300;
const squash = (value: string) => value.replace(/\s+/g, ' ').trim();
// The text around an anchor: on line-structured text (OCR, native helper) the
// anchor's line and its immediate neighbours; otherwise 300 characters each side.
function anchorWindow(text: string, anchor: string): string | undefined {
  const needle = squash(anchor).toLowerCase();
  if (!needle) return undefined;
  const lines = text.split('\n');
  const line = lines.findIndex((item) => squash(item).toLowerCase().includes(needle));
  if (line >= 0) {
    const around = squash(lines.slice(Math.max(0, line - 1), line + 2).join(' '));
    const at = around.toLowerCase().indexOf(needle);
    return around.slice(Math.max(0, at - WINDOW_CHARS), at + needle.length + WINDOW_CHARS);
  }
  const flat = squash(text);
  const at = flat.toLowerCase().indexOf(needle);
  return at < 0 ? undefined : flat.slice(Math.max(0, at - WINDOW_CHARS), at + needle.length + WINDOW_CHARS);
}

function parseLocal(value: unknown): LocalModelResult {
  const result = value as Partial<LocalModelResult> | null;
  if (!result || !['low', 'medium', 'high'].includes(result.risk as string) || !Array.isArray(result.reasons)
    || !result.reasons.every((reason) => (reasonCodes as readonly string[]).includes(reason))
    || (result.risk !== 'low' && result.reasons.length === 0) || typeof result.cue !== 'string' || result.cue.length > 120) {
    throw new LocalModelError('malformed');
  }
  return { risk: result.risk as Risk, reasons: [...new Set(result.reasons)], cue: result.cue };
}

export interface RoutedOptions {
  extractor: TextExtractor;
  local?: LocalModelPort;
  cloud?: CloudJudgePort;
  consent?: ConsentPort;
  governor?: CloudGovernor;
  now?: () => number;
  // Content-free record of every cloud attempt, including aborted ones (/trace).
  onAttempt?: (step: RouteStep) => void;
  deadlines?: Partial<Record<keyof typeof DEADLINES, number>>;
}

export class RoutedAnalyzer implements AnalyzerPort {
  private readonly governor: CloudGovernor;
  private readonly now: () => number;
  private readonly limits: { extract_ms: number; local_ms: number; cloud_ms: number; total_ms: number };
  constructor(private readonly options: RoutedOptions) {
    this.governor = options.governor ?? new CloudGovernor();
    this.now = options.now ?? Date.now;
    this.limits = { ...DEADLINES, ...options.deadlines };
  }

  async capabilities(): Promise<Capability[]> {
    const list: Capability[] = [{ id: 'local-ocr-rules', kind: 'rules', route: 'local', available: true }];
    if (this.options.local) list.push({ id: 'local-model', kind: 'model', route: 'local-model', model: this.options.local.model, available: await this.options.local.available().catch(() => false) });
    if (this.options.cloud) list.push({ id: 'cloud-judge', kind: 'model', route: 'cloud', model: this.options.cloud.model, available: this.options.cloud.available() });
    return list;
  }

  clearCache(): void { this.governor.clear(); }

  async analyze(frame: Frame, caller: AbortSignal): Promise<Assessment> {
    const started = performance.now();
    const elapsed = () => performance.now() - started;
    const cancelled = () => { if (caller.aborted) throw new AnalysisCancelled(); };
    cancelled();
    const context = { frame_id: frame.frame_id, source: frame.source };
    const trace: RouteStep[] = [];

    // Tier 0: text, then rules.
    let text: string;
    const extraction = deadline(caller, this.limits.extract_ms);
    try { text = await within(this.options.extractor.extract(frame, extraction.signal), extraction.signal); }
    catch { extraction.clear(); cancelled(); return { ...makeUnavailable(context), duration_ms: Math.round(elapsed()), trace: [{ tier: 'rules', analyzer_id: 'local-ocr-rules', outcome: 'unavailable', duration_ms: Math.round(elapsed()), remote_calls: 0, bytes_out: 0, cost: free, cached: false, versions }] }; }
    extraction.clear();
    cancelled();
    const rulesStarted = performance.now();
    const rules = analyzeText(text, context, 'text' in frame ? { url: frame.url } : {});
    trace.push({ tier: 'rules', analyzer_id: 'local-ocr-rules', outcome: rules.status, duration_ms: Math.round(performance.now() - rulesStarted), remote_calls: 0, bytes_out: 0, cost: free, cached: false, versions });
    let decision = decide({ rules });
    let local: LocalView | undefined;
    let localResult: LocalModelResult | undefined;

    // Tier 1: local model.
    if (decision.kind === 'call-local') {
      cancelled();
      const localStarted = performance.now();
      const { signal, clear } = deadline(caller, Math.min(this.limits.local_ms, this.limits.total_ms - elapsed()));
      try {
        if (!this.options.local) throw new LocalModelError('unavailable');
        localResult = parseLocal(await within(this.options.local.assess(text, signal), signal));
        local = { kind: 'result', risk: localResult.risk, reasons: localResult.reasons };
      } catch (error) {
        cancelled();
        local = { kind: 'failed', failure_kind: error instanceof LocalModelError ? error.failure_kind : signal.aborted ? 'timeout' : 'unavailable' };
      } finally { clear(); }
      const outcome: RouteStep['outcome'] = local.kind === 'failed' ? 'failed' : local.risk === 'low' ? 'no_signal' : local.risk === 'high' ? 'concern' : 'inconclusive';
      trace.push({ tier: 'local-model', analyzer_id: 'local-model', outcome, ...(local.kind === 'failed' ? { failure_kind: local.failure_kind } : {}), duration_ms: Math.round(performance.now() - localStarted), remote_calls: 0, bytes_out: 0, cost: free, cached: false, versions });
      decision = decide({ rules, local, gate: this.gate(frame) });
    }

    // Tier 2: cloud judge, behind the gate re-checked immediately before dispatch.
    let cloud: CloudView | undefined;
    let judged: Extract<CloudJudgeOutcome, { ok: true }> | undefined;
    let excerpt: string | undefined;
    if (decision.kind === 'call-cloud') {
      cancelled();
      excerpt = this.excerpt(text, rules.evidence, localResult?.cue, this.options.cloud as CloudJudgePort);
      decision = decide({ rules, local, gate: { ...this.gate(frame), anchor: excerpt !== undefined } });
    }
    if (decision.kind === 'call-cloud') {
      const port = this.options.cloud as CloudJudgePort;
      const cloudStarted = performance.now();
      const request: CloudJudgeRequest = {
        excerpt: excerpt as string, rulesReasons: rules.reasons, localRisk: localResult?.risk ?? 'medium',
        localReasons: localResult?.reasons ?? [], source: frame.source, patternHints: [],
      };
      const key = [sha256(port.redact(request.excerpt)), port.model, versions.prompt, versions.schema, versions.policy, frame.source, frame.session_id ?? ''].join('|');
      const hit = this.governor.cached(key, this.now());
      if (hit) {
        judged = hit;
        trace.push({ tier: 'cloud', analyzer_id: 'cloud-judge', outcome: 'concern', duration_ms: 0, remote_calls: 0, bytes_out: 0, payload_sha256: hit.payload_sha256, cost: free, cached: true, versions });
      } else {
        const { signal, clear } = deadline(caller, Math.min(this.limits.cloud_ms, this.limits.total_ms - elapsed()));
        let outcome: CloudJudgeOutcome;
        cancelled();
        try { outcome = await within(port.judge(request, signal, frame), signal); }
        catch {
          // Counted at dispatch even when it never returns: the body may have left.
          const { bytes_out, payload_sha256 } = port.measure(request);
          outcome = { ok: false, failure_kind: caller.aborted || !signal.aborted ? 'network' : 'timeout', bytes_out, payload_sha256, cost: { known: false, usd: 0 } };
        } finally { clear(); }
        this.governor.record(this.now(), outcome.cost);
        if (caller.aborted) {
          // Content-free attempt record for /trace; the analysis itself yields nothing.
          this.options.onAttempt?.({ tier: 'cloud', analyzer_id: 'cloud-judge', outcome: 'failed', failure_kind: 'network', duration_ms: Math.round(performance.now() - cloudStarted), remote_calls: 1, bytes_out: outcome.bytes_out, ...(outcome.payload_sha256 ? { payload_sha256: outcome.payload_sha256 } : {}), cost: outcome.cost, cached: false, versions });
          throw new AnalysisCancelled();
        }
        if (outcome.ok) { judged = outcome; this.governor.remember(key, this.now(), outcome); }
        trace.push({
          tier: 'cloud', analyzer_id: 'cloud-judge', outcome: outcome.ok ? 'concern' : 'failed', ...(outcome.ok ? {} : { failure_kind: outcome.failure_kind }),
          duration_ms: Math.round(performance.now() - cloudStarted), remote_calls: 1, bytes_out: outcome.bytes_out,
          ...(outcome.payload_sha256 ? { payload_sha256: outcome.payload_sha256 } : {}), cost: outcome.cost, cached: false, versions,
        });
        this.options.onAttempt?.(trace.at(-1) as RouteStep);
      }
      cloud = judged ? { kind: 'verdict', verdict: judged.verdict, reasons: judged.reasons, pattern: judged.pattern } : { kind: 'failed', failure_kind: (trace.at(-1) as RouteStep).failure_kind as Exclude<FailureKind, 'no_consent' | 'budget' | 'no_anchor'> };
      decision = decide({ rules, local, gate: { grant: true, provider: true, budget: true }, cloud });
      // The cloud step's outcome is the status it produced.
      const last = trace.at(-1) as RouteStep;
      if (judged && decision.kind === 'final') last.outcome = decision.status;
    }

    cancelled();
    if (decision.kind !== 'final') throw Error('Routing did not settle');
    if (decision.skipped) trace.push({ tier: 'cloud', analyzer_id: 'cloud-judge', outcome: 'skipped', failure_kind: decision.skipped, duration_ms: 0, remote_calls: 0, bytes_out: 0, cost: free, cached: false, versions });
    return this.assessment(frame, decision, rules, localResult, judged, trace, Math.round(elapsed()));
  }

  private gate(frame: Frame): Gate {
    const now = this.now();
    const grant = checkGrant(frame, now) === 'ok' && (this.options.consent?.live(frame, now) ?? false);
    return { grant, provider: !!this.options.cloud?.available(), budget: this.governor.allows(now) };
  }

  // Anchored excerpt: windows around the rules' matched spans, else
  // around the local model's cue found in the text; undefined when nothing
  // anchors, and then nothing is sent. The screen head is never an excerpt.
  // Redacted and capped at 2048 bytes.
  private excerpt(text: string, evidence: string[], cue: string | undefined, port: CloudJudgePort): string | undefined {
    const anchors = evidence.length ? evidence.flatMap((item) => item.split(' … ')) : cue && cue.trim().length >= 8 ? [cue.trim()] : [];
    const windows = anchors.map((anchor) => anchorWindow(text, anchor)).filter((item): item is string => !!item);
    if (!windows.length) return undefined;
    let excerpt = port.redact(windows.join(' … '));
    while (Buffer.byteLength(excerpt) > 2048) excerpt = excerpt.slice(0, Math.floor(excerpt.length * 0.9));
    return excerpt;
  }

  private assessment(frame: Frame, decision: Extract<Decision, { kind: 'final' }>, rules: Assessment, local: LocalModelResult | undefined,
    judged: Extract<CloudJudgeOutcome, { ok: true }> | undefined, trace: RouteStep[], duration_ms: number): Assessment {
    let status: Status = decision.status;
    // A clean result on truncated native text is not clean (the team).
    if (status === 'no_signal' && 'text' in frame && frame.truncated) status = 'inconclusive';
    let reasons: Reason[] = [];
    if (status === 'concern') {
      reasons = [...new Set([...rules.reasons, ...(local?.reasons ?? []), ...(judged?.reasons ?? [])])];
      if (!reasons.length && judged) reasons = [patternReason[judged.pattern]];
    }
    const analyzer: Analyzer = decision.route === 'local' ? { id: 'local-ocr-rules', kind: 'rules', version: '1' }
      : decision.route === 'local-model' ? { id: 'local-model', kind: 'model', model: this.options.local?.model ?? 'unknown' }
        : { id: 'cloud-judge', kind: 'model', provider: 'anthropic', model: this.options.cloud?.model ?? 'unknown' };
    const message = status === 'concern' ? (decision.message === 'caution' ? messages.caution : messages.concern)
      : status === 'inconclusive' && decision.message === 'caution' ? messages.caution : messages[status];
    return {
      frame_id: frame.frame_id, source: frame.source, status, reasons,
      evidence: status === 'no_signal' ? [] : rules.evidence, message, analyzer, media_origin: 'not_assessed',
      route: decision.route, duration_ms, trace: trace.slice(0, 3), policy_row: decision.row as Assessment['policy_row'],
      ...(judged ? { pattern: judged.pattern, verdict: judged.verdict } : {}),
    };
  }
}
