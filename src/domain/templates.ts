// Fixed local templates for what the person hears and what family receives
// (contract contract v2, child ztq). Keyed by (status, pattern, verdict kind).
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
  // Pattern other names no category, so the caution names the pressure instead (v2.1).
  suspicious_other: 'This page has signs of pressure to act quickly or share something private. Pause and check with someone you trust before doing anything.',
  scam: 'This looks like a {pattern}. Nobody honest asks for this. Pause and call {family_name}.',
  // Voice segments (hf8): describe what is said, never the screen or who is speaking.
  voice_suspicious: 'What is being said has signs of a {pattern}. Pause and check with someone you trust before doing anything.',
  voice_suspicious_other: 'What is being said has signs of pressure to act quickly or share something private. Pause and check with someone you trust before doing anything.',
  voice_scam: 'This sounds like a {pattern}. Nobody honest asks for this. Hang up and call {family_name}.',
  family: "Shepherd noticed a possible {pattern} on {person}'s screen at {time}. No action was taken. Call when you can.",
  // the team 15:42 (hf8): never names or implies who was speaking.
  voice_family: "Shepherd heard signs of a possible {pattern} near {person}'s computer at {time}. No action was taken. Call when you can.",
  familyTest: "This is a test from Shepherd. Alerts about {person}'s screen will come from this conversation.",
} as const;

// Local concerns have no cloud pattern; the strongest rules or model reason names it.
const reasonPattern: Record<Reason, Pattern> = {
  support_pressure: 'tech_support', remote_access: 'remote_access', credential_pressure: 'credential_phishing',
  investment_pressure: 'celebrity_investment', family_emergency: 'family_emergency', prize_claim: 'prize_or_lottery',
  payment_pressure: 'other', impersonation: 'other', ai_instruction: 'other', other_concern: 'other',
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

export type Medium = 'screen' | 'voice';
export const mediumOf = (assessment: Pick<Assessment, 'source'>): Medium => (assessment.source === 'voice' ? 'voice' : 'screen');

export function speechText(kind: SpeechKind, pattern: Pattern, persona: Persona, medium: Medium = 'screen'): string {
  const voice = medium === 'voice';
  const template = kind === 'suspicious' && pattern === 'other' ? (voice ? templateTable.voice_suspicious_other : templateTable.suspicious_other)
    : kind === 'suspicious' ? (voice ? templateTable.voice_suspicious : templateTable.suspicious)
      : voice ? templateTable.voice_scam : templateTable.scam;
  return render(template, { pattern: patternLabels[pattern], family_name: persona.family_name });
}

// Family may hear of a concern only with rules or cloud corroboration: a
// model-only open-category concern (row 12d) is spoken, never sent (v2.1).
// Voice concerns use the same guards with the voice family template (hf8).
export function familyAllowed(assessment: Assessment): boolean {
  return speechKind(assessment) !== undefined && assessment.policy_row !== '12d';
}

export function familyTestText(persona: Persona): string {
  return render(templateTable.familyTest, { person: persona.person });
}

export function familyText(pattern: Pattern, persona: Persona, at: Date, timeZone?: string, medium: Medium = 'screen'): string {
  const time = at.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', ...(timeZone ? { timeZone } : {}) });
  return render(medium === 'voice' ? templateTable.voice_family : templateTable.family, { pattern: patternLabels[pattern], person: persona.person, time });
}
