// Pipeline record (contract): what each tier of the routed analyzer actually
// received and returned for one frame, for the local-only trace inspector. It is
// content-bearing, so it travels only to the private journal (su6), never to the
// SSE feed, history, family or cloud. The composite analyzer builds one only when
// the runtime asks for it (journal on).
import type { FailureKind, Pattern, Reason, Route, Source, Status } from './assessment.ts';
import type { Gate, MessageKind, Risk, Verdict } from './policy.ts';

export interface PipelineVersions { policy: number; prompt: number; schema: number }

export interface RulesTier {
  tier: 'rules'; analyzer_id: 'local-ocr-rules'; started_at: string; duration_ms: number;
  input: { text_characters: number; capped: boolean };
  output: { status: Status; reasons: Reason[]; evidence: string[] };
}
export interface LocalTier {
  tier: 'local-model'; analyzer_id: 'local-model'; model: string; started_at: string; duration_ms: number;
  // The text handed to the local model port (the adapter reads at most its window).
  input: { text: string };
  // raw: the value the port returned, before Shepherd validated it.
  output: { raw?: unknown; parsed?: { risk: Risk; reasons: Reason[]; cue: string }; failure_kind?: FailureKind };
}
export interface CloudTier {
  tier: 'cloud'; analyzer_id: 'cloud-judge'; model: string; started_at: string; duration_ms: number; cached: boolean;
  // Exactly what was sent: the redacted excerpt, with the body's hash and size.
  input: { excerpt: string; excerpt_source: 'rules' | 'quote'; payload_sha256?: string; bytes_out: number };
  output: {
    verdict?: Verdict; reasons?: Reason[]; pattern?: Pattern;
    // Provider-authored text; shown labelled as model text, never spoken or sent.
    rationale?: { model_text: string };
    failure_kind?: FailureKind; dispatched: boolean; cost: { known: boolean; usd: number };
  };
}
export type PipelineTier = RulesTier | LocalTier | CloudTier;

export interface PipelineRecord {
  version: 1;
  frame_id: string; source: Source; started_at: string; versions: PipelineVersions;
  tiers: PipelineTier[];
  // The last gate the policy saw before settling (grant, provider, budget, anchor).
  gate?: Gate;
  decision: { row: string; status: Status; route: Route; message: MessageKind; skipped?: string };
}
