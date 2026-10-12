// Composite analyzer, contract contract v2 (child btb): rules -> local model ->
// cloud judge, driven by the pure policy in domain/policy.ts. Every tier runs
// under AbortSignal.any([caller, deadline]); the caller's abort is checked first
// and surfaces as AnalysisCancelled, which yields no Assessment at all.
import { createHash } from 'node:crypto';

import {
  analyzeText, checkGrant, makeUnavailable, reasonCodes,
  POLICY_VERSION, PROMPT_VERSION, SCHEMA_VERSION,
  type Analyzer, type Assessment, type EvidenceRegion, type FailureKind, type Frame, type JudgeMeta, type Pattern, type Reason, type RouteStep, type Status, type TextFrame,
} from '../domain/assessment.ts';
import { verbatimCue } from '../domain/cue.ts';
import { decide, type CloudView, type Decision, type Gate, type LocalView, type OpenConcern, type Risk, type Verdict } from '../domain/policy.ts';
import { AnalysisCancelled, type AnalyzerPort, type Capability } from './analyzer.ts';
import { PipelineCapture } from './pipeline-capture.ts';
import type { PipelineRecord } from '../domain/pipeline.ts';

export { AnalysisCancelled };

export const DEADLINES = { extract_ms: 8000, local_ms: 4000, cloud_ms: 10_000, total_ms: 16_000 } as const;
export const MAX_RULES_INPUT = 32 * 1024;

// Live-demo knob (contract): SHEPHERD_LOCAL_DEADLINE_MS gives the local model more
// time on a loaded machine. Unset keeps DEADLINES.local_ms; out-of-range refuses to start.
export const LOCAL_DEADLINE_BOUNDS = { min_ms: 1000, max_ms: 10_000 } as const;
export function localDeadline(raw: string | undefined): number {
  if (raw === undefined || raw === '') return DEADLINES.local_ms;
  const value = Number(raw);
  const { min_ms, max_ms } = LOCAL_DEADLINE_BOUNDS;
  if (!Number.isInteger(value) || value < min_ms || value > max_ms) throw Error(`Invalid SHEPHERD_LOCAL_DEADLINE_MS: an integer from ${min_ms} to ${max_ms} ms`);
  return value;
}

// Tier 0 input: OCR for pixel frames, the helper's text for native frames.
export interface TextExtractor { extract(frame: Frame, signal: AbortSignal): Promise<string> }

// partial: the adapter judged a truncated text (tea); a clean result then is not clean.
export interface LocalModelResult { risk: Risk; reasons: Reason[]; cue: string; partial?: boolean }
export class LocalModelError extends Error {
  constructor(readonly failure_kind: 'unavailable' | 'malformed' | 'timeout') { super(failure_kind); this.name = 'LocalModelError'; }
}
// Implemented by tea (llama-server). Throws LocalModelError; honours the signal.
export interface LocalModelPort {
  readonly model: string;
  assess(text: string, signal: AbortSignal): Promise<unknown>;
  available(): Promise<boolean>;
  // Optional state text (managed llama-server: starting, warming, ready, unavailable).
  describe?(): string | undefined;
}

export interface CloudJudgeRequest {
  excerpt: string; rulesReasons: Reason[]; localRisk: Risk; localReasons: Reason[]; source: Frame['source']; patternHints: Pattern[];
}
export type CloudJudgeOutcome =
  | { ok: true; verdict: Verdict; reasons: Reason[]; pattern: Pattern; rationale: string; bytes_out: number; payload_sha256: string; cost: { known: boolean; usd: number }; replayed?: boolean; judge_meta?: JudgeMeta }
  // remote_calls 0: refused before dispatch (the adapter's own re-check), so nothing
  // left; absent means the body may have left and the attempt counts (1fx R2).
  | { ok: false; failure_kind: Exclude<FailureKind, 'no_anchor'>; bytes_out: number; payload_sha256?: string; cost: { known: boolean; usd: number }; replayed?: boolean; remote_calls?: 0 | 1 };
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
// Exported for the contract test: pattern other names no familiar category (r81).
export const patternReason: Record<Pattern, Reason> = {
  tech_support: 'support_pressure', celebrity_investment: 'investment_pressure', family_emergency: 'family_emergency',
  government_impersonation: 'impersonation', prize_or_lottery: 'prize_claim', romance: 'payment_pressure',
  credential_phishing: 'credential_pressure', remote_access: 'remote_access', other: 'other_concern',
};
const messages = {
  concern: 'This screen uses a pressure pattern. Pause and check who is asking before taking action.',
  caution: 'This page has signs of a scam. Pause and check with someone you trust before doing anything.',
  // Row 12d: a model-only concern outside the named categories (r81).
  open: 'This page has signs of pressure to act quickly or share something private. Pause and check with someone you trust before doing anything.',
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
const REGION_PADDING = 24;

// Excerpt contract v3 (contract, the team 13:49): only matched evidence spans
// leave, never windows, neighbours, lines or fuzzy matches. A model quote counts
// only through verbatimCue (8-160 normalised characters within the model's window).
// With the quote path on, a quote must still carry a pressure term to be sent.
const PRESSURE_TERM = /\b(?:pay|send|gift ?cards?|bitcoin|crypto\w*|wire|urgent\w*|immediately|now|account|suspend\w*|arrest\w*|bail|police|invest\w*|shares?|pre-?ipo|guaranteed|verify|password|codes?|call)\b/i;

// Contract v2.1 (r81): unknown reason strings are dropped one by one, never
// rejected alone. other_concern needs a verbatim cue from the frame text; a
// medium or high result with no known reason left becomes other_concern when
// the cue is verbatim, else malformed, so "not enough evidence" stays distinct
// from "suspicious but unclassified".
function parseLocal(value: unknown, text: string): LocalModelResult {
  const result = value as Partial<LocalModelResult> | null;
  if (!result || !['low', 'medium', 'high'].includes(result.risk as string) || !Array.isArray(result.reasons)
    || !result.reasons.every((reason) => typeof reason === 'string') || typeof result.cue !== 'string') {
    throw new LocalModelError('malformed');
  }
  let reasons = [...new Set(result.reasons.filter((reason): reason is Reason => (reasonCodes as readonly string[]).includes(reason)))];
  const cued = verbatimCue(text, result.cue) !== undefined;
  if (result.risk !== 'low' && reasons.length === 0 && cued) reasons = ['other_concern'];
  if ((result.risk !== 'low' && reasons.length === 0) || (reasons.includes('other_concern') && !cued)) throw new LocalModelError('malformed');
  return { risk: result.risk as Risk, reasons, cue: result.cue, partial: result.partial === true };
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
  // Model-quote excerpts (SHEPHERD_QUOTE_EXCERPTS=1); off by default: in v0 only
  // rule-matched spans can form a cloud excerpt (d3l).
  quoteExcerpts?: boolean;
  // Row 12d: 'quiet' (default) shows the open caution without speaking; 'spoken' is v2.1.
  openConcern?: OpenConcern;
  // Rules only annotate unless true (row 3 off by default; operator 16:58).
  rulesDecide?: boolean;
  // u6w: a local-only record of what every tier received and returned, built only
  // when set (the runtime sets it while the journal is on). Never in the Assessment.
  onPipeline?: (record: PipelineRecord) => void;
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
    if (this.options.local) {
      const limitation = this.options.local.describe?.();
      list.push({ id: 'local-model', kind: 'model', route: 'local-model', model: this.options.local.model, available: await this.options.local.available().catch(() => false), ...(limitation ? { limitation } : {}) });
    }
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
    const pipe = this.options.onPipeline ? new PipelineCapture(frame, versions, this.now(), started) : undefined;
    const settle = (decided: Extract<Decision, { kind: 'final' }>, assessment: Assessment): Assessment => {
      // A failing sink (e.g. the journal) never changes the analysis.
      if (pipe) try { this.options.onPipeline?.(pipe.finish(decided, assessment)); } catch { /* recorded nowhere */ }
      return assessment;
    };

    // Tier 0: text, then rules.
    let text: string;
    const extraction = deadline(caller, this.limits.extract_ms);
    try { text = await within(this.options.extractor.extract(frame, extraction.signal), extraction.signal); }
    catch { extraction.clear(); cancelled(); return settle({ kind: 'final', row: '1', status: 'unavailable', route: 'local', message: 'default' }, { ...makeUnavailable(context), duration_ms: Math.round(elapsed()), policy_row: '1', trace: [{ tier: 'rules', analyzer_id: 'local-ocr-rules', outcome: 'unavailable', duration_ms: Math.round(elapsed()), remote_calls: 0, bytes_out: 0, cost: free, cached: false, versions }] }); }
    extraction.clear();
    cancelled();
    // Rules are synchronous and not preempted; their bound is structural: input
    // capped at 32 KiB here, backtracking-safe patterns, duration recorded.
    let capped = false;
    if (text.length > MAX_RULES_INPUT) { text = text.slice(0, MAX_RULES_INPUT); capped = true; }
    const rulesStarted = performance.now();
    const rules = analyzeText(text, context, 'text' in frame ? { url: frame.url } : {});
    trace.push({ tier: 'rules', analyzer_id: 'local-ocr-rules', outcome: rules.status, duration_ms: Math.round(performance.now() - rulesStarted), remote_calls: 0, bytes_out: 0, cost: free, cached: false, versions });
    pipe?.rules(rulesStarted, (trace.at(-1) as RouteStep).duration_ms, text.length, capped, rules);
    let decision = decide({ open_concern: this.options.openConcern, rules_decide: this.options.rulesDecide, rules });
    let local: LocalView | undefined;
    let localResult: LocalModelResult | undefined;
    let localRaw: unknown;

    // Tier 1: local model.
    if (decision.kind === 'call-local') {
      cancelled();
      const localStarted = performance.now();
      const { signal, clear } = deadline(caller, Math.min(this.limits.local_ms, this.limits.total_ms - elapsed()));
      try {
        if (!this.options.local) throw new LocalModelError('unavailable');
        localRaw = await within(this.options.local.assess(text, signal), signal);
        localResult = parseLocal(localRaw, text);
        local = { kind: 'result', risk: localResult.risk, reasons: localResult.reasons };
      } catch (error) {
        cancelled();
        local = { kind: 'failed', failure_kind: error instanceof LocalModelError ? error.failure_kind : signal.aborted ? 'timeout' : 'unavailable' };
      } finally { clear(); }
      const outcome: RouteStep['outcome'] = local.kind === 'failed' ? 'failed' : local.risk === 'low' ? 'no_signal' : local.risk === 'high' ? 'concern' : 'inconclusive';
      trace.push({ tier: 'local-model', analyzer_id: 'local-model', outcome, ...(local.kind === 'failed' ? { failure_kind: local.failure_kind } : {}), duration_ms: Math.round(performance.now() - localStarted), remote_calls: 0, bytes_out: 0, cost: free, cached: false, versions });
      pipe?.local(localStarted, (trace.at(-1) as RouteStep).duration_ms, this.options.local?.model ?? 'unknown', text, localRaw, localResult, local.kind === 'failed' ? local.failure_kind : undefined);
      const gate = this.gate(frame);
      pipe?.gate(gate);
      decision = decide({ open_concern: this.options.openConcern, rules_decide: this.options.rulesDecide, rules, local, gate });
    }

    // Tier 2: cloud judge, behind the gate re-checked immediately before dispatch.
    let cloud: CloudView | undefined;
    let judged: Extract<CloudJudgeOutcome, { ok: true }> | undefined;
    let excerpt: { text: string; source: 'rules' | 'quote' } | undefined;
    if (decision.kind === 'call-cloud') {
      cancelled();
      excerpt = this.excerpt(text, rules, localResult?.cue, this.options.cloud as CloudJudgePort);
      const gate = { ...this.gate(frame), anchor: excerpt !== undefined };
      pipe?.gate(gate);
      decision = decide({ open_concern: this.options.openConcern, rules_decide: this.options.rulesDecide, rules, local, gate });
    }
    if (decision.kind === 'call-cloud') {
      const port = this.options.cloud as CloudJudgePort;
      const cloudStarted = performance.now();
      const request: CloudJudgeRequest = {
        excerpt: (excerpt as { text: string }).text, rulesReasons: rules.reasons, localRisk: localResult?.risk ?? 'medium',
        localReasons: localResult?.reasons ?? [], source: frame.source, patternHints: [],
      };
      const key = [sha256(port.redact(request.excerpt)), port.model, versions.prompt, versions.schema, versions.policy, frame.source, frame.session_id ?? ''].join('|');
      const hit = this.governor.cached(key, this.now());
      if (hit) {
        judged = hit;
        trace.push({ tier: 'cloud', analyzer_id: 'cloud-judge', outcome: 'concern', duration_ms: 0, remote_calls: 0, bytes_out: 0, payload_sha256: hit.payload_sha256, cost: free, cached: true, versions, excerpt_source: excerpt?.source });
        pipe?.cloud(cloudStarted, 0, port.model, true, { excerpt: port.redact(request.excerpt), excerpt_source: (excerpt as { source: 'rules' | 'quote' }).source, payload_sha256: hit.payload_sha256, bytes_out: 0 },
          { verdict: hit.verdict, reasons: [...hit.reasons], pattern: hit.pattern, rationale: { model_text: hit.rationale }, dispatched: false, cost: free });
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
        if (!outcome.ok && outcome.remote_calls === 0) {
          // Refused before dispatch (1fx R2): the gate closed under us. Nothing was sent,
          // budgeted or traced; settle as the closed-gate row with a skipped step. Any
          // other pre-dispatch refusal (e.g. a request that could not be built) reads as
          // provider unavailable.
          cancelled();
          pipe?.cloud(cloudStarted, Math.round(performance.now() - cloudStarted), port.model, false, { excerpt: port.redact(request.excerpt), excerpt_source: (excerpt as { source: 'rules' | 'quote' }).source, bytes_out: 0 },
            { failure_kind: outcome.failure_kind, dispatched: false, cost: outcome.cost });
          const closedBy = outcome.failure_kind === 'no_consent' ? { grant: false } : outcome.failure_kind === 'budget' ? { budget: false } : { provider: false };
          decision = decide({ open_concern: this.options.openConcern, rules_decide: this.options.rulesDecide, rules, local, gate: { grant: true, provider: true, budget: true, ...closedBy } });
          if (decision.kind !== 'final') throw Error('Routing did not settle');
          if (decision.skipped) trace.push({ tier: 'cloud', analyzer_id: 'cloud-judge', outcome: 'skipped', failure_kind: decision.skipped, duration_ms: 0, remote_calls: 0, bytes_out: 0, cost: free, cached: false, versions });
          return settle(decision, this.assessment(frame, decision, rules, localResult, undefined, trace, Math.round(elapsed()), capped));
        }
        // A replayed verdict (demo safety net) is local: no dispatch, nothing to budget.
        if (!outcome.replayed) this.governor.record(this.now(), outcome.cost);
        if (caller.aborted) {
          // Content-free attempt record for /trace; the analysis itself yields nothing.
          this.options.onAttempt?.({ tier: 'cloud', analyzer_id: 'cloud-judge', outcome: 'failed', failure_kind: 'network', duration_ms: Math.round(performance.now() - cloudStarted), remote_calls: 1, bytes_out: outcome.bytes_out, ...(outcome.payload_sha256 ? { payload_sha256: outcome.payload_sha256 } : {}), cost: outcome.cost, cached: false, versions, excerpt_source: excerpt?.source });
          throw new AnalysisCancelled();
        }
        if (outcome.ok) { judged = outcome; this.governor.remember(key, this.now(), outcome); }
        trace.push({
          tier: 'cloud', analyzer_id: 'cloud-judge', outcome: outcome.ok ? 'concern' : 'failed', ...(outcome.ok ? {} : { failure_kind: outcome.failure_kind }),
          duration_ms: Math.round(performance.now() - cloudStarted), remote_calls: outcome.replayed ? 0 : 1, bytes_out: outcome.replayed ? 0 : outcome.bytes_out,
          ...(outcome.payload_sha256 ? { payload_sha256: outcome.payload_sha256 } : {}), cost: outcome.cost, cached: !!outcome.replayed, versions, excerpt_source: excerpt?.source,
          ...(outcome.replayed ? { replayed: true } : {}), ...(outcome.ok && outcome.judge_meta ? { judge_meta: outcome.judge_meta } : {}),
        });
        if (!outcome.replayed) this.options.onAttempt?.(trace.at(-1) as RouteStep);
        pipe?.cloud(cloudStarted, (trace.at(-1) as RouteStep).duration_ms, port.model, !!outcome.replayed,
          { excerpt: port.redact(request.excerpt), excerpt_source: (excerpt as { source: 'rules' | 'quote' }).source, ...(outcome.payload_sha256 ? { payload_sha256: outcome.payload_sha256 } : {}), bytes_out: outcome.replayed ? 0 : outcome.bytes_out },
          outcome.ok ? { verdict: outcome.verdict, reasons: [...outcome.reasons], pattern: outcome.pattern, rationale: { model_text: outcome.rationale }, dispatched: !outcome.replayed, cost: outcome.cost }
            : { failure_kind: outcome.failure_kind, dispatched: true, cost: outcome.cost });
      }
      // A dispatched attempt never fails for consent or budget (both are checked before
      // dispatch), so its failure kind is a transport one.
      cloud = judged ? { kind: 'verdict', verdict: judged.verdict, reasons: judged.reasons, pattern: judged.pattern } : { kind: 'failed', failure_kind: (trace.at(-1) as RouteStep).failure_kind as Exclude<FailureKind, 'no_consent' | 'budget' | 'no_anchor'> };
      decision = decide({ open_concern: this.options.openConcern, rules_decide: this.options.rulesDecide, rules, local, gate: { grant: true, provider: true, budget: true }, cloud });
      // The cloud step's outcome is the status it produced.
      const last = trace.at(-1) as RouteStep;
      if (judged && decision.kind === 'final') last.outcome = decision.status;
    }

    cancelled();
    if (decision.kind !== 'final') throw Error('Routing did not settle');
    if (decision.skipped) trace.push({ tier: 'cloud', analyzer_id: 'cloud-judge', outcome: 'skipped', failure_kind: decision.skipped, duration_ms: 0, remote_calls: 0, bytes_out: 0, cost: free, cached: false, versions });
    return settle(decision, this.assessment(frame, decision, rules, localResult, judged, trace, Math.round(elapsed()), capped));
  }

  private gate(frame: Frame): Gate {
    const now = this.now();
    const grant = checkGrant(frame, now) === 'ok' && (this.options.consent?.live(frame, now) ?? false);
    return { grant, provider: !!this.options.cloud?.available(), budget: this.governor.allows(now) };
  }

  // Excerpt contract v3: the rules' matched spans (bounded at 200 chars, at most
  // three; lookalike hosts contribute no text), else the verbatim model quote,
  // else undefined and nothing is sent. Redacted and capped at 2048 bytes.
  private excerpt(text: string, rules: Assessment, quote: string | undefined, port: CloudJudgePort): { text: string; source: 'rules' | 'quote' } | undefined {
    const spans = rules.evidence.filter((_item, index) => rules.reasons[index] !== 'impersonation');
    let parts = spans;
    let source: 'rules' | 'quote' = 'rules';
    if (!parts.length && this.options.quoteExcerpts) {
      const quoted = verbatimCue(text, quote);
      if (quoted && PRESSURE_TERM.test(quoted)) { parts = [quoted]; source = 'quote'; }
    }
    if (!parts.length) return undefined;
    let excerpt = port.redact(parts.join(' … '));
    while (Buffer.byteLength(excerpt) > 2048) excerpt = excerpt.slice(0, Math.floor(excerpt.length * 0.9));
    return { text: excerpt, source };
  }

  private assessment(frame: Frame, decision: Extract<Decision, { kind: 'final' }>, rules: Assessment, local: LocalModelResult | undefined,
    judged: Extract<CloudJudgeOutcome, { ok: true }> | undefined, trace: RouteStep[], duration_ms: number, capped = false): Assessment {
    let status: Status = decision.status;
    // A clean result on truncated, capped or partially read text is not clean (the team 13:16, tea partial).
    if (status === 'no_signal' && (capped || local?.partial || ('text' in frame && frame.truncated))) status = 'inconclusive';
    let reasons: Reason[] = [];
    if (status === 'concern') {
      reasons = [...new Set([...rules.reasons, ...(local?.reasons ?? []), ...(judged?.reasons ?? [])])];
      if (!reasons.length && judged) reasons = [patternReason[judged.pattern]];
    }
    const analyzer: Analyzer = decision.route === 'local' ? { id: 'local-ocr-rules', kind: 'rules', version: '1' }
      : decision.route === 'local-model' ? { id: 'local-model', kind: 'model', model: this.options.local?.model ?? 'unknown' }
        : { id: 'cloud-judge', kind: 'model', provider: 'openrouter', model: this.options.cloud?.model ?? 'unknown' };
    const message = decision.row === '12d' ? messages.open
      : status === 'concern' ? (decision.message === 'caution' ? messages.caution : messages.concern)
      : status === 'inconclusive' && decision.message === 'caution' ? messages.caution : messages[status];
    const regions = status === 'concern' ? evidenceRegions(frame, rules.evidence, local?.cue) : [];
    const countedTrace = trace.slice(0, 3).map((step) => regions.length ? { ...step, regions: regions.length } : step);
    return {
      frame_id: frame.frame_id, source: frame.source, status, reasons,
      evidence: status === 'no_signal' ? [] : rules.evidence, message, analyzer, media_origin: 'not_assessed',
      route: decision.route, duration_ms, trace: countedTrace, policy_row: decision.row as Assessment['policy_row'],
      ...(regions.length ? { evidence_regions: regions.length } : {}),
      ...(judged ? { pattern: judged.pattern, verdict: judged.verdict } : {}),
    };
  }

}

// Rule and local-model text is window-only. Display OCR is consulted only to
// locate the same matched span for an on-device journal crop; it never forms
// an excerpt or alters routing.
export function evidenceRegions(frame: Frame, ruleEvidence: string[], localCue: string | undefined): EvidenceRegion[] {
  if (!('text' in frame) || !frame.display_lines?.length) return [];
  const spans: Array<{ text: string; source: EvidenceRegion['source'] }> = [
    ...ruleEvidence.map((text) => ({ text, source: 'rules' as const })),
    ...(localCue ? [{ text: localCue, source: 'local' as const }] : []),
  ];
  const regions: EvidenceRegion[] = [];
  for (const span of spans) {
    const region = regionForSpan(frame, span.text, span.source);
    if (region && !regions.some((item) => item.x === region.x && item.y === region.y && item.w === region.w && item.h === region.h && item.source === region.source)) {
      regions.push(region);
    }
    if (regions.length === 3) break;
  }
  return regions;
}

function regionForSpan(frame: TextFrame, span: string, source: EvidenceRegion['source']): EvidenceRegion | undefined {
  const target = span.replace(/\s+/g, ' ').trim().toLowerCase();
  if (target.length < 4) return undefined;
  const lines = (frame.display_lines ?? []).filter((line) => {
    const text = line.text.replace(/\s+/g, ' ').trim().toLowerCase();
    return text.length >= 4 && (target.includes(text) || text.includes(target));
  });
  if (!lines.length) return undefined;
  const left = Math.max(0, Math.min(...lines.map((line) => line.x)) - REGION_PADDING);
  const top = Math.max(0, Math.min(...lines.map((line) => line.y)) - REGION_PADDING);
  const right = Math.max(...lines.map((line) => line.x + line.w)) + REGION_PADDING;
  const bottom = Math.max(...lines.map((line) => line.y + line.h)) + REGION_PADDING;
  return { x: left, y: top, w: right - left, h: bottom - top, source };
}
