// Routing policy, contract contract v2.1 total routing table (rows 1-18, 12d).
// Pure: the composite analyzer feeds it what each tier returned and does what it
// says. Row 19 (abort at any boundary) is the composite's AnalysisCancelled path.
import type { FailureKind, Pattern, Reason, Route, Status } from './assessment.ts';

export const verdicts = ['scam', 'suspicious', 'benign', 'unclear'] as const;
export type Verdict = typeof verdicts[number];
export type Risk = 'low' | 'medium' | 'high';

// Strong reasons settle a concern locally; every other reason is weak, and two
// weak reasons are still weak.
export const strongReasons: readonly Reason[] = ['support_pressure'];

export interface RulesView { status: Status; reasons: readonly Reason[] }
export type LocalView =
  | { kind: 'result'; risk: Risk; reasons: readonly Reason[] }
  | { kind: 'failed'; failure_kind: 'unavailable' | 'malformed' | 'timeout' };
// G and P and B, evaluated by the caller immediately before dispatch.
// A missing gate means no consent.
// anchor: the excerpt is anchored to matched text (contract); false means nothing
// may be sent, so the cloud step is skipped with failure_kind no_anchor.
export interface Gate { grant: boolean; provider: boolean; budget: boolean; anchor?: boolean }
export type CloudView =
  | { kind: 'verdict'; verdict: Verdict; reasons: readonly Reason[]; pattern: Pattern }
  | { kind: 'failed'; failure_kind: Exclude<FailureKind, 'no_consent' | 'budget' | 'no_anchor'> };
// Row 12d (a lone local-model other_concern) is shown but not spoken unless
// open_concern is 'spoken' (v2.1 behaviour): in the 16:00 live run a lone local
// model rated innocuous pages high and the companion spoke every minute (the team).
export type OpenConcern = 'spoken' | 'quiet';
// Operator 16:58: deterministic rules only annotate, never decide. Row 3 (a strong
// rule settling a concern without any model) exists only with rules_decide true;
// otherwise a strong reason is weak and the models decide.
export interface PolicyInput { rules: RulesView; local?: LocalView; gate?: Gate; cloud?: CloudView; open_concern?: OpenConcern; rules_decide?: boolean }

// Which fixed local template (ztq) the outcome uses: 'evidence' shows the rules
// evidence, 'caution' the cautionary text, 'scam' the scam text.
export type MessageKind = 'default' | 'evidence' | 'caution' | 'scam';
export type Decision =
  | { kind: 'call-local' }
  | { kind: 'call-cloud'; row: '4' | '8' | '10' | '12' }
  | { kind: 'final'; row: string; status: Status; route: Route; message: MessageKind; skipped?: 'no_consent' | 'unavailable' | 'budget' | 'no_anchor' };

const final = (row: string, status: Status, route: Route, message: MessageKind = 'default'): Decision => ({ kind: 'final', row, status, route, message });

// Row 18: which gate failed, in contract order G, P, B.
function closed(gate: Gate | undefined): 'no_consent' | 'unavailable' | 'budget' | 'no_anchor' | undefined {
  if (!gate?.grant) return 'no_consent';
  if (!gate.provider) return 'unavailable';
  if (!gate.budget) return 'budget';
  if (gate.anchor === false) return 'no_anchor';
  return undefined;
}

export function decide(input: PolicyInput): Decision {
  const { rules, local, gate, cloud } = input;
  if (rules.status === 'unavailable') return final('1', 'unavailable', 'local');
  if (rules.status === 'inconclusive') return final('2', 'inconclusive', 'local');
  const concern = rules.status === 'concern';
  if (input.rules_decide === true && concern && rules.reasons.some((reason) => strongReasons.includes(reason))) return final('3', 'concern', 'local');
  if (!local) return { kind: 'call-local' };

  // Which tier-2 row applies, and the row that replaces it when the gate is closed.
  let cloudRow: '4' | '8' | '10' | '12';
  let fallback: Decision;
  if (local.kind === 'failed') {
    if (!concern) return final('6', 'inconclusive', 'local');
    cloudRow = '4';
    fallback = final('5', 'inconclusive', 'local', 'evidence');
  } else if (concern) {
    if (local.risk === 'high') return final('7', 'concern', 'local-model');
    cloudRow = local.risk === 'medium' ? '8' : '10';
    fallback = local.risk === 'medium' ? final('9', 'inconclusive', 'local-model', 'caution') : final('11', 'inconclusive', 'local-model', 'evidence');
  } else {
    if (local.risk === 'low') return final('12c', 'no_signal', 'local-model');
    cloudRow = '12';
    // Row 12d (v2.1, r81): when nothing may be sent, a local high concern outside
    // the named categories (other_concern, cue already verified) is a caution:
    // inconclusive and shown by default (quiet), concern and spoken only with
    // open_concern 'spoken'. Family is never alerted without corroboration.
    fallback = local.risk === 'high' && local.reasons.includes('other_concern')
      ? final('12d', input.open_concern === 'spoken' ? 'concern' : 'inconclusive', 'local-model', 'caution') : final('12b', 'inconclusive', 'local-model');
  }

  const skipped = closed(gate);
  if (skipped) return { ...fallback, skipped } as Decision;
  if (!cloud) return { kind: 'call-cloud', row: cloudRow };
  if (cloud.kind === 'failed') return final('17', 'inconclusive', 'cloud');
  switch (cloud.verdict) {
    case 'scam': return final('13', 'concern', 'cloud', 'scam');
    case 'suspicious': return final('14', 'concern', 'cloud', 'caution');
    // A benign verdict never clears a rules concern: no_signal only if R was no_signal.
    case 'benign': return final('15', concern ? 'inconclusive' : 'no_signal', 'cloud');
    case 'unclear': return final('16', 'inconclusive', 'cloud');
  }
}
