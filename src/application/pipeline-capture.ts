// Builds the u6w pipeline record while the routed analyzer runs. One capture per
// analysis, created only when the runtime asked for a record; routing calls it
// once per tier with what that tier actually received and returned.
import type { Assessment, FailureKind, Frame } from '../domain/assessment.ts';
import type { CloudTier, PipelineRecord, PipelineTier, PipelineVersions } from '../domain/pipeline.ts';
import type { Decision, Gate, Risk } from '../domain/policy.ts';
import type { Reason } from '../domain/assessment.ts';

export class PipelineCapture {
  private readonly tiers: PipelineTier[] = [];
  private lastGate?: Gate;

  // wallStart and perfStart are the same instant on the two clocks, so tier
  // start times can be stamped from performance.now() readings.
  constructor(private readonly frame: Frame, private readonly versions: PipelineVersions,
    private readonly wallStart: number, private readonly perfStart: number) {}

  private at(perf: number): string { return new Date(this.wallStart + (perf - this.perfStart)).toISOString(); }

  rules(perfStarted: number, duration_ms: number, text_characters: number, capped: boolean, rules: Assessment): void {
    this.tiers.push({ tier: 'rules', analyzer_id: 'local-ocr-rules', started_at: this.at(perfStarted), duration_ms,
      input: { text_characters, capped }, output: { status: rules.status, reasons: [...rules.reasons], evidence: [...rules.evidence] } });
  }

  local(perfStarted: number, duration_ms: number, model: string, text: string, raw: unknown,
    parsed: { risk: Risk; reasons: Reason[]; cue: string } | undefined, failure_kind?: FailureKind): void {
    this.tiers.push({ tier: 'local-model', analyzer_id: 'local-model', model, started_at: this.at(perfStarted), duration_ms,
      input: { text },
      output: { ...(raw === undefined ? {} : { raw }), ...(parsed ? { parsed: { risk: parsed.risk, reasons: [...parsed.reasons], cue: parsed.cue } } : {}), ...(failure_kind ? { failure_kind } : {}) } });
  }

  cloud(perfStarted: number, duration_ms: number, model: string, cached: boolean, input: CloudTier['input'], output: CloudTier['output']): void {
    this.tiers.push({ tier: 'cloud', analyzer_id: 'cloud-judge', model, started_at: this.at(perfStarted), duration_ms, cached, input, output });
  }

  gate(gate: Gate): void { this.lastGate = { ...gate }; }

  finish(decision: Extract<Decision, { kind: 'final' }>, assessment: Assessment): PipelineRecord {
    return {
      version: 1, frame_id: this.frame.frame_id, source: this.frame.source, started_at: this.at(this.perfStart), versions: this.versions,
      tiers: this.tiers, ...(this.lastGate ? { gate: this.lastGate } : {}),
      // Status and route are the Assessment's, after the truncation adjustment.
      decision: { row: decision.row, status: assessment.status, route: assessment.route, message: decision.message, ...(decision.skipped ? { skipped: decision.skipped } : {}) },
    };
  }
}
