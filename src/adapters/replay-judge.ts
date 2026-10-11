// Demo safety net when OpenRouter is unreachable (demo/runbook.org). During a
// rehearsal RecordingJudge stores each closed verdict keyed by the sha256 of the
// redacted excerpt; ReplayJudge serves those verdicts locally. Only codes are
// stored (verdict, reasons, pattern), never screen or model text. A replayed
// verdict is reported as cached with zero remote calls, zero bytes and zero cost,
// and the analyzer's model reads "replay:<model>"; a miss is unavailable, never
// an invented verdict.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

import { redactExcerpt } from '../../tools/cloud-judge/cloud-judge.mjs';
import type { CloudJudgeOutcome, CloudJudgePort, CloudJudgeRequest } from '../application/routing.ts';
import type { Frame, Pattern, Reason } from '../domain/assessment.ts';
import type { Verdict } from '../domain/policy.ts';

type Entry = { verdict: Verdict; reasons: Reason[]; pattern: Pattern };
type Recording = { version: 1; model: string; entries: Record<string, Entry> };
const keyOf = (excerpt: string) => createHash('sha256').update(redactExcerpt(excerpt)).digest('hex');

function load(file: string, model: string): Recording {
  try { return JSON.parse(readFileSync(file, 'utf8')) as Recording; } catch { return { version: 1, model, entries: {} }; }
}

export class RecordingJudge implements CloudJudgePort {
  constructor(private readonly inner: CloudJudgePort, private readonly file: string) {}
  get model(): string { return this.inner.model; }
  available(): boolean { return this.inner.available(); }
  redact(excerpt: string): string { return this.inner.redact(excerpt); }
  measure(request: CloudJudgeRequest) { return this.inner.measure(request); }
  async judge(request: CloudJudgeRequest, signal: AbortSignal, frame: Frame): Promise<CloudJudgeOutcome> {
    const outcome = await this.inner.judge(request, signal, frame);
    if (outcome.ok) {
      const recording = load(this.file, this.model);
      recording.entries[keyOf(request.excerpt)] = { verdict: outcome.verdict, reasons: outcome.reasons, pattern: outcome.pattern };
      writeFileSync(this.file, `${JSON.stringify(recording, null, 2)}\n`);
    }
    return outcome;
  }
}

export class ReplayJudge implements CloudJudgePort {
  private readonly recording: Recording;
  readonly model: string;
  constructor(options: { file: string; model: string }) {
    this.recording = load(options.file, options.model);
    this.model = `replay:${options.model}`;
  }
  available(): boolean { return true; }
  redact(excerpt: string): string { return redactExcerpt(excerpt); }
  measure(request: CloudJudgeRequest) { return { bytes_out: 0, payload_sha256: keyOf(request.excerpt) }; }
  async judge(request: CloudJudgeRequest): Promise<CloudJudgeOutcome> {
    const key = keyOf(request.excerpt);
    const entry = this.recording.entries[key];
    const free = { known: true, usd: 0 };
    if (!entry) return { ok: false, failure_kind: 'unavailable', bytes_out: 0, payload_sha256: key, cost: free, replayed: true };
    return { ok: true, ...entry, rationale: '', bytes_out: 0, payload_sha256: key, cost: free, replayed: true };
  }
}
