// Bridge from the OpenRouter cloud judge (tools/cloud-judge) to CloudJudgePort.
// The adapter redacts, builds the exact body, re-checks the frame's grant and
// accounts bytes and cost; this bridge only maps shapes.
import { createHash } from 'node:crypto';

import { buildCloudRequest, dispatchCloudJudge, redactExcerpt, type Transport } from '../../tools/cloud-judge/cloud-judge.mjs';
import type { CloudJudgeOutcome, CloudJudgePort, CloudJudgeRequest } from '../application/routing.ts';
import { patterns, reasonCodes, type Frame, type Pattern, type Reason } from '../domain/assessment.ts';

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
// no_consent: the adapter's own grant re-check refused before dispatch.
const failures = new Set(['timeout', 'unavailable', 'malformed', 'refusal', 'rate_limit', 'network', 'no_consent']);
// The cloud tool's closed reason codes; newer runtime codes (ai_instruction) are
// dropped from the request rather than failing its closed-code check.
const toolReasons = new Set(['support_pressure', 'payment_pressure', 'credential_pressure', 'investment_pressure', 'impersonation', 'remote_access', 'family_emergency', 'prize_claim', 'other_concern']);
const known = (request: CloudJudgeRequest): CloudJudgeRequest => ({
  ...request, rulesReasons: request.rulesReasons.filter((reason) => toolReasons.has(reason)), localReasons: request.localReasons.filter((reason) => toolReasons.has(reason)),
});

export class OpenRouterJudge implements CloudJudgePort {
  constructor(private readonly options: { model: string; transport?: Transport; timeoutMs?: number }) {}

  get model(): string { return this.options.model; }
  available(): boolean { return !!this.options.transport; }
  redact(excerpt: string): string { return redactExcerpt(excerpt); }

  measure(request: CloudJudgeRequest) {
    const built = buildCloudRequest({ ...known(request), model: this.model });
    return { bytes_out: built.bytesOut, payload_sha256: sha256(built.text) };
  }

  async judge(request: CloudJudgeRequest, signal: AbortSignal, frame: Frame): Promise<CloudJudgeOutcome> {
    if (!this.options.transport) throw Error('Cloud judge unavailable');
    const result = await dispatchCloudJudge({
      context: { signal, frame, now: new Date(), providerReachable: true, inFlight: 0, budgetAvailable: true },
      request: { ...known(request), model: this.model }, transport: this.options.transport, timeoutMs: this.options.timeoutMs,
    });
    const payload_sha256 = sha256(result.body);
    if (result.outcome === 'success') {
      return {
        ok: true, verdict: result.verdict.verdict,
        reasons: result.verdict.reasons.filter((reason): reason is Reason => (reasonCodes as readonly string[]).includes(reason)),
        pattern: (patterns as readonly string[]).includes(result.verdict.pattern) ? result.verdict.pattern as Pattern : 'other',
        rationale: result.verdict.rationale, bytes_out: result.bytesOut, payload_sha256, cost: result.cost,
      };
    }
    const failure_kind = failures.has(result.failureKind) ? result.failureKind as Exclude<CloudJudgeOutcome, { ok: true }>['failure_kind'] : 'network';
    // The adapter reports whether the body was handed to the transport.
    return { ok: false, failure_kind, bytes_out: result.bytesOut, payload_sha256, cost: result.cost, remote_calls: result.remoteCalls === 0 ? 0 : 1 };
  }
}
