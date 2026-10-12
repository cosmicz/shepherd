import { findRules, type RuleOptions } from './rules.ts';

// Contract v2 (contract 12:45), v2.1 open category (r81): other_concern reason,
// row 12d, model prompts; prompt 3 states the shared 8-160 cue bound (r81 review).
// All three versions travel in every trace step.
export const POLICY_VERSION = 3;
export const PROMPT_VERSION = 3;
export const SCHEMA_VERSION = 3;

export const statuses = ['concern', 'no_signal', 'inconclusive', 'unavailable'] as const;
// Voice is on-device speech; accessibility is exact local AX text.
export const sources = ['window', 'tab', 'example', 'native', 'voice', 'accessibility'] as const;
export const reasonCodes = [
  'support_pressure', 'payment_pressure', 'credential_pressure',
  'investment_pressure', 'impersonation', 'remote_access', 'family_emergency', 'prize_claim',
  // Text addressed to an assistant or model (contract); weak, never decisive.
  'ai_instruction',
  // Suspicious but outside the named categories (contract v2.1, contract).
  'other_concern',
] as const;
export const patterns = [
  'tech_support', 'celebrity_investment', 'family_emergency', 'government_impersonation',
  'prize_or_lottery', 'romance', 'credential_phishing', 'remote_access', 'other',
] as const;
export const routes = ['local', 'local-model', 'cloud'] as const;
export const tiers = ['rules', 'local-model', 'cloud'] as const;
export const failureKinds = ['timeout', 'unavailable', 'malformed', 'refusal', 'rate_limit', 'network', 'budget', 'no_consent', 'no_anchor'] as const;
export type Status = typeof statuses[number];
export type Source = typeof sources[number];
export type Reason = typeof reasonCodes[number];
export type Pattern = typeof patterns[number];
export type Route = typeof routes[number];
export type Tier = typeof tiers[number];
export type FailureKind = typeof failureKinds[number];

export interface FrameContext { frame_id: string; source: Source }
// Grant: user-created, scope-bound consent for one session generation and source.
export interface Grant {
  id: string; session_id: string; generation: number; source: Source;
  scope: 'redacted-text'; max_bytes: 2048; version: 1; granted_at: string; expires_at: string;
}
// Session envelope set by the companion from the live Session. Optional on the
// wire for older callers, but a grant only counts when both are present and match.
export interface Envelope { session_id?: string; generation?: number; consent?: Grant }
export interface PngFrame extends FrameContext, Envelope { image: string }
export interface TextLine { text: string; x: number; y: number; w: number; h: number }
export interface EvidenceRegion { x: number; y: number; w: number; h: number; source: 'rules' | 'local' }
// Native helper output (u09/nr4). App, bundle, title and URL are best-effort and
// absent when unknown. The primary text is the frontmost window; display text
// spans the whole screen, so metadata must not be attributed to it alone.
// Voice frames carry recognised speech only; accessibility frames carry the
// same frontmost-window provenance as native text frames.
export interface TextFrame extends Envelope {
  frame_id: string; source: 'native' | 'voice' | 'accessibility'; text: string; lines?: TextLine[];
  // Voice only: the audio the segment came from (hf8).
  voice_origin?: 'system' | 'microphone';
  // Display OCR is local-only context. It is never an implicit cloud excerpt.
  display_text?: string; display_lines?: TextLine[];
  evidence_regions?: EvidenceRegion[];
  app?: string | null; bundle_id?: string | null; window_title?: string | null; url?: string | null;
  captured_at: string; scope?: 'display' | 'window';
  // Set by the integration when text or url were cut to fit the wire limits; a
  // clean result on partial text is reported as inconclusive, not no_signal.
  truncated?: boolean;
  // Native source completeness marker. URL text is never shortened: a too-long
  // address becomes null, so lookalike rules cannot inspect a partial host.
  url_status?: 'ok' | 'too_long' | 'absent';
}
export type Frame = PngFrame | TextFrame;

export type Analyzer =
  | { id: 'local-ocr-rules'; kind: 'rules'; version: string }
  | { id: 'local-model'; kind: 'model'; model: string }
  | { id: 'cloud-judge'; kind: 'model'; provider: 'anthropic' | 'openrouter'; model: string };
export const analyzerIds = ['local-ocr-rules', 'local-model', 'cloud-judge'] as const;
const analyzerRoute: Record<Analyzer['id'], Route> = { 'local-ocr-rules': 'local', 'local-model': 'local-model', 'cloud-judge': 'cloud' };
export interface RouteStep {
  tier: Tier;
  analyzer_id: Analyzer['id'];
  outcome: Status | 'failed' | 'skipped';
  failure_kind?: FailureKind;
  duration_ms: number;
  remote_calls: 0 | 1;
  bytes_out: number;
  payload_sha256?: string;
  cost: { known: boolean; usd: number };
  cached: boolean;
  versions: { policy: number; prompt: number; schema: number };
  // What formed the cloud excerpt: rule-matched spans, or a verbatim model quote (d3l).
  excerpt_source?: 'rules' | 'quote';
  // Geometry is deliberately count-only in traces; no OCR text travels here.
  regions?: number;
  // Served from a rehearsal recording (demo safety net), never a live call.
  replayed?: boolean;
  // Decision-model judge (5qp): the provider's class distribution. Agreement, not
  // probability of correctness; never a routing input, never spoken or sent.
  judge_meta?: JudgeMeta;
}
export interface JudgeMeta {
  classes: Partial<Record<'benign' | 'suspicious' | 'unknown', number>>;
  concentration: number;
  provider_confidence: number | null;
  calibrated: false;
  basis: 'provider_distribution';
}
const probability = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) throw Error('Invalid probability');
  return value;
};
export function parseJudgeMeta(input: unknown): JudgeMeta {
  const value = record(input);
  const raw = record(value.classes);
  const classes: JudgeMeta['classes'] = {};
  for (const key of Object.keys(raw)) classes[oneOf(key, ['benign', 'suspicious', 'unknown'] as const)] = probability(raw[key]);
  if (value.calibrated !== false || value.basis !== 'provider_distribution') throw Error('Judge distribution must be marked uncalibrated');
  return { classes, concentration: probability(value.concentration), provider_confidence: value.provider_confidence === null ? null : probability(value.provider_confidence), calibrated: false, basis: 'provider_distribution' };
}
export interface Assessment extends FrameContext {
  status: Status;
  reasons: Reason[];
  evidence: string[];
  evidence_regions?: number;
  message: string;
  analyzer: Analyzer;
  media_origin: 'not_assessed';
  route: Route;
  duration_ms: number;
  trace: RouteStep[];
  // Routing outcome for fixed local templates (ztq): table row, cloud pattern and verdict.
  policy_row?: string;
  pattern?: Pattern;
  verdict?: 'scam' | 'suspicious' | 'benign' | 'unclear';
}
export interface EventSummary {
  id: string;
  created_at: string;
  status: Status;
  reasons: Reason[];
  // dismissed: the person chose "I'm fine" on the native banner (x3k).
  action: 'shown' | 'paused' | 'dismissed';
  source: Source;
  route: Route;
  duration_ms: number;
}
export const EVIDENCE_SPAN = 200;
export const policyRows = ['1', '2', '3', '5', '6', '7', '9', '11', '12b', '12c', '12d', '13', '14', '15', '16', '17'] as const;

const messages: Record<Status, string> = {
  concern: 'This screen uses a pressure pattern. Pause and check who is asking before taking action.',
  no_signal: 'No configured pressure pattern was found. This does not verify who is behind the screen.',
  inconclusive: 'There is not enough readable English text to assess this screen.',
  unavailable: 'The local analyzer could not assess this screen. Try again or check the local service.',
};

export function makeUnavailable(context: FrameContext): Assessment {
  return {
    frame_id: context.frame_id, source: context.source,
    status: 'unavailable', reasons: [], evidence: [], message: messages.unavailable,
    analyzer: { id: 'local-ocr-rules', kind: 'rules', version: '1' },
    media_origin: 'not_assessed', route: 'local', duration_ms: 0, trace: [],
  };
}

export function analyzeText(text: string, context: FrameContext, options: RuleOptions = {}): Assessment {
  if (typeof text !== 'string' || text.length > 32_768) return makeUnavailable(context);
  const normalized = text.replace(/\s+/g, ' ').trim();
  // Rules see line breaks: OCR and native text rarely carry sentence punctuation.
  const lined = text.replace(/[^\S\n]+/g, ' ').replace(/ ?\n[\s]*/g, '\n').trim();
  const findings = findRules(lined, options);
  const reasons: Reason[] = findings.map((finding) => finding.reason);
  // Evidence is a window around what each rule matched (F4, contract), at most three.
  const evidence = findings.slice(0, 3).map((finding) => finding.evidence);
  const status: Status = reasons.length ? 'concern' : (normalized.match(/[a-z]/gi)?.length ?? 0) < 4 ? 'inconclusive' : 'no_signal';
  return { ...makeUnavailable(context), status, reasons, evidence, message: messages[status] };
}

export function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw Error('Expected an object');
  return value as Record<string, unknown>;
}
export function boundedString(value: unknown, maximum = 128): string {
  if (typeof value !== 'string' || !value.length || value.length > maximum) throw Error('Invalid bounded string');
  return value;
}
export function oneOf<T extends string>(value: unknown, values: readonly T[]): T {
  if (typeof value !== 'string' || !values.includes(value as T)) throw Error('Unsupported value');
  return value as T;
}
function duration(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 120_000) throw Error('Invalid duration');
  return value;
}
function outcome(value: Record<string, unknown>): { status: Status; reasons: Reason[] } {
  const status = oneOf(value.status, statuses);
  if (!Array.isArray(value.reasons) || value.reasons.length > reasonCodes.length) throw Error('Invalid reasons');
  const reasons = value.reasons.map((reason) => oneOf(reason, reasonCodes));
  if (new Set(reasons).size !== reasons.length || (status === 'concern') !== (reasons.length > 0)) throw Error('Inconsistent outcome');
  return { status, reasons };
}

function count(value: unknown, maximum: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > maximum) throw Error('Invalid count');
  return value;
}
function timestamp(value: unknown): string {
  const text = boundedString(value, 32);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(text) || !Number.isFinite(Date.parse(text))) throw Error('Invalid timestamp');
  return text;
}

function parseAnalyzer(input: unknown): Analyzer {
  const value = record(input);
  if (value.id === 'local-ocr-rules' && value.kind === 'rules') return { id: 'local-ocr-rules', kind: 'rules', version: boundedString(value.version, 16) };
  if (value.id === 'local-model' && value.kind === 'model') return { id: 'local-model', kind: 'model', model: boundedString(value.model) };
  if (value.id === 'cloud-judge' && value.kind === 'model' && (value.provider === 'anthropic' || value.provider === 'openrouter')) return { id: 'cloud-judge', kind: 'model', provider: value.provider, model: boundedString(value.model) };
  throw Error('Unsupported analyzer');
}

export function parseRouteStep(input: unknown): RouteStep {
  const value = record(input);
  const tier = oneOf(value.tier, tiers);
  const outcome = oneOf(value.outcome, [...statuses, 'failed', 'skipped'] as const);
  const settled = outcome === 'failed' || outcome === 'skipped';
  if (settled !== (value.failure_kind !== undefined)) throw Error('failure_kind is required exactly when a step failed or was skipped');
  const cost = record(value.cost);
  if (typeof cost.known !== 'boolean' || typeof cost.usd !== 'number' || !Number.isFinite(cost.usd) || cost.usd < 0 || cost.usd > 100) throw Error('Invalid cost');
  // Unknown cost is reported as unknown, never as free or priced.
  if (!cost.known && cost.usd !== 0) throw Error('Unknown cost cannot carry an amount');
  const versions = record(value.versions);
  if (typeof value.cached !== 'boolean') throw Error('Invalid cached flag');
  const step: RouteStep = {
    tier, analyzer_id: oneOf(value.analyzer_id, analyzerIds),
    outcome, duration_ms: duration(value.duration_ms),
    remote_calls: count(value.remote_calls, 1) as 0 | 1, bytes_out: count(value.bytes_out, 1 << 20),
    cost: { known: cost.known, usd: cost.usd }, cached: value.cached,
    versions: { policy: count(versions.policy, 1000), prompt: count(versions.prompt, 1000), schema: count(versions.schema, 1000) },
  };
  if (settled) step.failure_kind = oneOf(value.failure_kind, failureKinds);
  if (value.replayed !== undefined) {
    if (value.replayed !== true || tier !== 'cloud' || step.remote_calls !== 0) throw Error('Invalid replay marker');
    step.replayed = true;
  }
  if (value.excerpt_source !== undefined) {
    if (tier !== 'cloud') throw Error('Only cloud steps carry an excerpt source');
    step.excerpt_source = oneOf(value.excerpt_source, ['rules', 'quote'] as const);
  }
  if (value.regions !== undefined) step.regions = count(value.regions, MAX_LINES);
  if (value.judge_meta !== undefined) {
    if (tier !== 'cloud') throw Error('Only cloud steps carry a judge distribution');
    step.judge_meta = parseJudgeMeta(value.judge_meta);
  }
  if (value.payload_sha256 !== undefined) {
    if (typeof value.payload_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(value.payload_sha256)) throw Error('Invalid payload hash');
    step.payload_sha256 = value.payload_sha256;
  }
  // A cloud attempt is at least one remote call; only a cache hit or a skip has none.
  if (tier === 'cloud' && step.outcome !== 'skipped' && !step.cached && step.remote_calls < 1) throw Error('Uncached cloud step without a remote call');
  // Local tiers never leave the machine and are free.
  if (tier !== 'cloud' && (step.remote_calls !== 0 || step.bytes_out !== 0 || step.payload_sha256 !== undefined || !step.cost.known || step.cost.usd !== 0)) throw Error('Local tier reported remote traffic or cost');
  if (analyzerRoute[step.analyzer_id] !== ({ rules: 'local', 'local-model': 'local-model', cloud: 'cloud' } as const)[tier]) throw Error('Step analyzer does not match tier');
  return step;
}

export function parseAssessment(input: unknown): Assessment {
  const value = record(input);
  const analyzer = parseAnalyzer(value.analyzer);
  const route = oneOf(value.route, routes);
  if (value.media_origin !== 'not_assessed' || analyzerRoute[analyzer.id] !== route) throw Error('Unsupported route/provenance');
  if (!Array.isArray(value.evidence) || value.evidence.length > 3) throw Error('Invalid evidence');
  // A missing trace is the pre-v2 rules-only payload; it parses as an empty trace.
  const trace = value.trace === undefined ? [] : value.trace;
  if (!Array.isArray(trace) || trace.length > 3) throw Error('Invalid trace');
  const steps = trace.map(parseRouteStep);
  // Fixed tier order rules -> local-model -> cloud, each at most once (the team hjm).
  const order = steps.map((step) => tiers.indexOf(step.tier));
  if (order.some((rank, index) => index > 0 && rank <= order[index - 1])) throw Error('Trace tiers out of order or duplicated');
  // A model or cloud route must carry the step that decided it, so remote calls,
  // bytes and cost cannot disappear from the record (the team F-TRACE).
  if (route === 'local-model' && !steps.some((step) => step.tier === 'local-model' && step.outcome !== 'skipped')) throw Error('Missing local-model step');
  if (route === 'cloud' && !steps.some((step) => step.tier === 'cloud' && step.outcome !== 'skipped')) throw Error('Missing cloud step');
  return {
    frame_id: boundedString(value.frame_id), source: oneOf(value.source, sources), ...outcome(value),
    evidence: value.evidence.map((item) => boundedString(item, EVIDENCE_SPAN)), message: boundedString(value.message, 512),
    analyzer, media_origin: 'not_assessed', route, duration_ms: duration(value.duration_ms),
    trace: steps,
    ...(value.evidence_regions === undefined ? {} : { evidence_regions: count(value.evidence_regions, MAX_LINES) }),
    ...(value.policy_row === undefined ? {} : { policy_row: oneOf(value.policy_row, policyRows) }),
    ...(value.pattern === undefined ? {} : { pattern: oneOf(value.pattern, patterns) }),
    ...(value.verdict === undefined ? {} : { verdict: oneOf(value.verdict, ['scam', 'suspicious', 'benign', 'unclear'] as const) }),
  };
}

export function parseGrant(input: unknown): Grant {
  const value = record(input);
  if (value.scope !== 'redacted-text' || value.max_bytes !== 2048 || value.version !== 1) throw Error('Unsupported grant scope');
  const granted_at = timestamp(value.granted_at);
  const expires_at = timestamp(value.expires_at);
  if (Date.parse(expires_at) <= Date.parse(granted_at)) throw Error('Grant expires before it starts');
  return {
    id: boundedString(value.id), session_id: boundedString(value.session_id), generation: count(value.generation, Number.MAX_SAFE_INTEGER),
    source: oneOf(value.source, sources), scope: 'redacted-text', max_bytes: 2048, version: 1, granted_at, expires_at,
  };
}

export function parseEnvelope(value: Record<string, unknown>): Envelope {
  const envelope: Envelope = {};
  if (value.session_id !== undefined) envelope.session_id = boundedString(value.session_id);
  if (value.generation !== undefined) envelope.generation = count(value.generation, Number.MAX_SAFE_INTEGER);
  if (value.consent !== undefined) envelope.consent = parseGrant(value.consent);
  return envelope;
}

const MAX_TEXT = 32 * 1024;
const MAX_LINES = 2000;
function coordinate(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100_000) throw Error('Invalid line geometry');
  return value;
}
export function parseTextFrame(input: unknown): TextFrame {
  const value = record(input);
  const fields = new Set(['frame_id', 'source', 'session_id', 'generation', 'consent', 'text', 'lines', 'display_text', 'display_lines', 'evidence_regions', 'app', 'bundle_id', 'window_title', 'url', 'captured_at', 'scope', 'truncated', 'url_status', 'voice_origin']);
  if (Object.keys(value).some((key) => !fields.has(key))) throw Error('Unknown TextFrame field');
  const source = oneOf(value.source, ['native', 'voice', 'accessibility'] as const);
  // Speech has no app, window, URL, lines or display: their presence is a bad frame.
  const screenOnly = ['lines', 'display_text', 'display_lines', 'evidence_regions', 'app', 'bundle_id', 'window_title', 'url', 'scope', 'url_status'];
  if (source === 'voice' && screenOnly.some((key) => value[key] !== undefined)) throw Error('Voice frames carry no screen metadata');
  if (source !== 'voice' && value.voice_origin !== undefined) throw Error('Only voice frames carry a voice origin');
  // Empty text is valid (blank screen) and analyzes as inconclusive.
  if (typeof value.text !== 'string' || new TextEncoder().encode(value.text).length > MAX_TEXT) throw Error('Invalid frame text');
  const frame: TextFrame = {
    frame_id: boundedString(value.frame_id), source, ...parseEnvelope(value), text: value.text,
    captured_at: timestamp(value.captured_at),
  };
  if (value.voice_origin !== undefined) frame.voice_origin = oneOf(value.voice_origin, ['system', 'microphone'] as const);
  const optional = (key: 'app' | 'bundle_id' | 'window_title' | 'url', maximum: number) => {
    const item = value[key];
    if (item === undefined) return;
    if (item !== null && (typeof item !== 'string' || item.length > maximum)) throw Error(`Invalid ${key}`);
    frame[key] = item;
  };
  optional('app', 256);
  optional('bundle_id', 256);
  optional('window_title', 512);
  optional('url', 2048);
  if (value.scope !== undefined) frame.scope = oneOf(value.scope, ['display', 'window'] as const);
  if (value.truncated !== undefined) {
    if (typeof value.truncated !== 'boolean') throw Error('Invalid truncated flag');
    frame.truncated = value.truncated;
  }
  if (value.url_status !== undefined) {
    const status = oneOf(value.url_status, ['ok', 'too_long', 'absent'] as const);
    if ((status === 'ok' && typeof frame.url !== 'string') || (status !== 'ok' && frame.url !== null)) throw Error('Inconsistent URL status');
    frame.url_status = status;
  }
  if (value.lines !== undefined) {
    frame.lines = parseLines(value.lines);
  }
  if (value.display_text !== undefined) {
    if (typeof value.display_text !== 'string' || new TextEncoder().encode(value.display_text).length > MAX_TEXT) throw Error('Invalid display text');
    frame.display_text = value.display_text;
  }
  if (value.display_lines !== undefined) frame.display_lines = parseLines(value.display_lines);
  if (value.evidence_regions !== undefined) {
    if (!Array.isArray(value.evidence_regions) || value.evidence_regions.length > 3) throw Error('Invalid evidence regions');
    frame.evidence_regions = value.evidence_regions.map((item) => {
      const region = record(item);
      const w = coordinate(region.w);
      const h = coordinate(region.h);
      if (w === 0 || h === 0) throw Error('Invalid evidence region size');
      return { x: coordinate(region.x), y: coordinate(region.y), w, h, source: oneOf(region.source, ['rules', 'local'] as const) };
    });
  }
  return frame;
}

function parseLines(input: unknown): TextLine[] {
  if (!Array.isArray(input) || input.length > MAX_LINES) throw Error('Invalid lines');
  return input.map((item) => {
      const line = record(item);
      if (typeof line.text !== 'string' || line.text.length > 1024) throw Error('Invalid line text');
      return { text: line.text, x: coordinate(line.x), y: coordinate(line.y), w: coordinate(line.w), h: coordinate(line.h) };
  });
}

// Called immediately before any cloud dispatch: shape was checked at decode;
// here the grant must bind to this frame's session, generation and source and be live.
export function checkGrant(frame: Frame, now: number): 'ok' | 'no_consent' {
  const grant = frame.consent;
  if (!grant || frame.session_id === undefined || frame.generation === undefined) return 'no_consent';
  if (grant.session_id !== frame.session_id || grant.generation !== frame.generation || grant.source !== frame.source) return 'no_consent';
  if (!(now >= Date.parse(grant.granted_at) && now < Date.parse(grant.expires_at))) return 'no_consent';
  return 'ok';
}

export function parseEvent(input: unknown): EventSummary {
  const value = record(input);
  const created_at = timestamp(value.created_at);
  return {
    id: boundedString(value.id), created_at, ...outcome(value),
    action: oneOf(value.action, ['shown', 'paused', 'dismissed']), source: oneOf(value.source, sources),
    route: oneOf(value.route, routes), duration_ms: duration(value.duration_ms),
  };
}

export function toEvent(assessment: Assessment, action: EventSummary['action'], id: string, created_at: string): EventSummary {
  const value = parseAssessment(assessment);
  return parseEvent({ id, created_at, status: value.status, reasons: value.reasons, action, source: value.source, route: value.route, duration_ms: value.duration_ms });
}
