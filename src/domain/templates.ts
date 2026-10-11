// Fixed local templates for what the person hears and what family receives
//. Keyed by (status, pattern, verdict kind).
// No provider-authored text ever reaches speech or Messages: models contribute
// closed codes only, and every placeholder is filled from local configuration.
import type { Assessment, Pattern, Reason } from './assessment.ts';

export interface Persona { person?: string; family_name?: string }
export type SpeechKind = 'scam' | 'suspicious';

export class TemplateError extends Error {
  constructor(placeholder: string) { super(`Template placeholder {${placeholder}} has no local configuration`); this.name = 'TemplateError'; }
}

export const patternLabels: Record<Pattern, string> = {
  tech_support: 'tech support scam',
  celebrity_investment: 'fake investment offer',
  family_emergency: 'family emergency scam',
  government_impersonation: 'government impostor scam',
  prize_or_lottery: 'prize or lottery scam',
  romance: 'romance scam',
  credential_phishing: 'password phishing attempt',
  remote_access: 'remote access scam',
  other: 'scam',
};

// Templates preserve uncertainty: "suspicious" says signs, "scam" says it is one.
export const templateTable = {
  suspicious: 'This page has signs of a {pattern}. Pause and check with someone you trust before doing anything.',
  scam: 'This looks like a {pattern}. Nobody honest asks for this. Pause and call {family_name}.',
  family: "Shepherd noticed a possible {pattern} on {person}'s screen at {time}. No action was taken. Call when you can.",
} as const;

// Local concerns have no cloud pattern; the strongest rules or model reason names it.
const reasonPattern: Record<Reason, Pattern> = {
  support_pressure: 'tech_support', remote_access: 'remote_access', credential_pressure: 'credential_phishing',
  investment_pressure: 'celebrity_investment', family_emergency: 'family_emergency', prize_claim: 'prize_or_lottery',
  payment_pressure: 'other', impersonation: 'other',
};

function render(template: string, values: Record<string, string | undefined>): string {
  return template.replace(/\{(\w+)\}/g, (_match, key: string) => {
    const value = values[key];
    if (!value) throw new TemplateError(key);
    return value;
  });
}

export function patternOf(assessment: Assessment): Pattern {
  if (assessment.pattern) return assessment.pattern;
  for (const reason of assessment.reasons) if (reasonPattern[reason] !== 'other') return reasonPattern[reason];
  return 'other';
}

// Which template a concern uses: the judge's verdict when it decided; strong rules
// (row 3) are a scam; a local-model concern (row 7) is reported as signs only.
export function speechKind(assessment: Assessment): SpeechKind | undefined {
  if (assessment.status !== 'concern') return undefined;
  if (assessment.verdict === 'scam' || assessment.verdict === 'suspicious') return assessment.verdict;
  if (assessment.route === 'local' && assessment.reasons.includes('support_pressure')) return 'scam';
  return 'suspicious';
}

export function speechText(kind: SpeechKind, pattern: Pattern, persona: Persona): string {
  return render(templateTable[kind], { pattern: patternLabels[pattern], family_name: persona.family_name });
}

export function familyText(pattern: Pattern, persona: Persona, at: Date, timeZone?: string): string {
  const time = at.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', ...(timeZone ? { timeZone } : {}) });
  return render(templateTable.family, { pattern: patternLabels[pattern], person: persona.person, time });
}
