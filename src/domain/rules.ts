// Tier-0 rules. Deliberately narrow observations over
// OCR or native text, never authenticity verdicts. Only support_pressure is a
// strong reason; everything here else is weak and needs the local model.
import type { Reason } from './assessment.ts';

export interface RuleOptions {
  // Address-bar URL from a native TextFrame, when the helper could read it.
  url?: string | null;
  // The person's own trusted hosts; never flagged as lookalikes.
  allowlist?: readonly string[];
}
export interface RuleFinding { reason: Reason; evidence: string }

const WINDOW = 200;
type Match = { index: number; end: number; text: string };

function matches(pattern: RegExp, text: string): Match[] {
  const global = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
  return [...text.matchAll(global)].map((m) => ({ index: m.index, end: m.index + m[0].length, text: m[0] }));
}

// Negated when the match itself says "not"/"never", or when its clause (back to
// the nearest punctuation or line break) does before it: "do not call support".
function negated(text: string, match: Match): boolean {
  if (/\b(?:not|never|no longer)\b/i.test(match.text)) return true;
  const before = text.slice(Math.max(0, match.index - 80), match.index);
  const clause = before.slice(Math.max(...[...'.!?;,:\n'].map((mark) => before.lastIndexOf(mark))) + 1);
  return /\b(?:not|never|don['’]?t|avoid|no need to)\b/i.test(clause);
}

// The text spanned by matches, or the matches joined when they are far apart.
function span(text: string, parts: Match[]): string {
  const start = Math.min(...parts.map((part) => part.index));
  const end = Math.max(...parts.map((part) => part.end));
  const value = end - start <= WINDOW ? text.slice(start, end) : parts.sort((a, b) => a.index - b.index).map((part) => part.text).join(' … ');
  return value.replace(/\s+/g, ' ').trim().slice(0, WINDOW);
}

// The candidate closest to the anchor, if any lies within one window of it.
function near(candidates: Match[], anchor: Match): Match | undefined {
  const width = (item: Match) => Math.max(item.end, anchor.end) - Math.min(item.index, anchor.index);
  return candidates.filter((item) => width(item) <= WINDOW).sort((a, b) => width(a) - width(b))[0];
}

// Strong: an infection/block claim and a call-now instruction within one
// 200-character window, span at least 20 characters, neither negated.
const claim = /\byour (?:computer|device|pc|mac)\b[\s\S]{0,35}?\b(?:infected|virus(?:es)?|blocked|locked|compromised)\b/i;
const callNow = /\bcall\b[\s\S]{0,35}?\b(?:support|immediately|now|technician|helpline|(?:the|this) (?:number|toll[- ]free number))\b(?: (?:on the screen|now|immediately|today)\b)?/i;

function supportPressure(text: string): RuleFinding | undefined {
  const instructions = matches(callNow, text).filter((item) => !negated(text, item));
  for (const found of matches(claim, text)) {
    if (negated(text, found)) continue;
    const paired = instructions.find((item) => {
      const width = Math.max(item.end, found.end) - Math.min(item.index, found.index);
      return width <= WINDOW && width >= 20;
    });
    if (paired) return { reason: 'support_pressure', evidence: span(text, [found, paired]) };
  }
  return undefined;
}

// Weak payment/credential pressure: an instruction,
// an urgency cue and a threat or consequence cue in one window. Commerce and
// newsletter text ("Buy now", "Subscribe now", "Send gift cards to friends")
// has no threat cue; navigation ("Bill pay Gift cards") is not an instruction.
const instructionStart = String.raw`(?:^|[.!?:\n]\s*|\bplease\s+|\byou (?:must|need to|have to)\s+|\bgo\s+(?:and\s+)?)`;
const asset = String.raw`\b(?:gift ?cards?|bitcoin|crypto(?:currency)?|wire transfer)\b`;
const paymentInstruction = new RegExp([
  String.raw`\bpay\b[\s\S]{0,20}?\b(?:with|in|using|by)\b[\s\S]{0,30}?${asset}`,
  String.raw`${instructionStart}(?:buy|purchase|get|send)\b[\s\S]{0,60}?${asset}`,
  String.raw`\bread (?:me )?the (?:codes?|numbers)\b`,
].join('|'), 'i');
const credentialInstruction = new RegExp(String.raw`${instructionStart}(?:enter|share|send|give|read|confirm|verify)\b[\s\S]{0,30}?\b(?:password|passcode|verification code|one-time code|pin)\b`, 'i');
const urgency = /\b(?:immediately|urgent(?:ly)?|now|today|right away|within \d+ (?:minutes|hours)|before it'?s too late)\b/i;
const threat = /\b(?:account|close[ds]?|closing|suspend\w*|lock\w*|arrest\w*|warrant|fines?|penalt\w*|lose|lost|prevent|police|irs|medicare|court|bail|jail|legal action|access)\b/i;

function pressure(text: string, reason: Reason, instruction: RegExp): RuleFinding | undefined {
  const urgencies = matches(urgency, text);
  const threats = matches(threat, text);
  for (const found of matches(instruction, text)) {
    if (negated(text, found)) continue;
    const hurry = near(urgencies, found);
    const consequence = hurry && threats.find((item) => {
      const parts = [found, hurry, item];
      return Math.max(...parts.map((p) => p.end)) - Math.min(...parts.map((p) => p.index)) <= WINDOW;
    });
    if (hurry && consequence) return { reason, evidence: span(text, [found, hurry]) };
  }
  return undefined;
}

// Lookalike domains: confusable normalization, compared with well-known brands
// and their official domains. An OCR-derived indicator, never authentication.
const brands: Record<string, readonly string[]> = {
  microsoft: ['microsoft.com', 'live.com', 'office.com', 'outlook.com'],
  apple: ['apple.com', 'icloud.com'],
  google: ['google.com', 'gmail.com', 'youtube.com'],
  paypal: ['paypal.com'],
  amazon: ['amazon.com'],
  netflix: ['netflix.com'],
  facebook: ['facebook.com'],
  chase: ['chase.com'],
  wellsfargo: ['wellsfargo.com'],
  bankofamerica: ['bankofamerica.com'],
  coinbase: ['coinbase.com'],
  medicare: ['medicare.gov'],
  irs: ['irs.gov'],
  usps: ['usps.com'],
};
const unicodeConfusables: Record<string, string> = {
  'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'у': 'y', 'х': 'x', 'і': 'i', 'ј': 'j', 'ѕ': 's', 'ԁ': 'd', 'ɡ': 'g',
  'ο': 'o', 'α': 'a', 'ν': 'v', 'ρ': 'p', 'ι': 'i', 'κ': 'k',
};

export function normalizeConfusables(value: string): string {
  return [...value.normalize('NFKC').toLowerCase()].map((char) => unicodeConfusables[char] ?? char).join('')
    .replace(/0/g, 'o').replace(/1/g, 'l').replace(/5/g, 's').replace(/rn/g, 'm').replace(/vv/g, 'w');
}

const hostPattern = /(?<![\p{L}\p{N}@.-])(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?\.)+\p{L}{2,24}(?![\p{L}\p{N}-])/gu;
const registrable = (host: string) => host.split('.').slice(-2).join('.');

export function lookalikeHosts(text: string, options: RuleOptions = {}): string[] {
  const allowed = new Set((options.allowlist ?? []).map((host) => host.toLowerCase()));
  let fromUrl: string | undefined;
  try { fromUrl = options.url ? new URL(options.url).hostname : undefined; } catch { fromUrl = undefined; }
  const hosts = [...new Set([...(fromUrl ? [fromUrl] : []), ...(text.match(hostPattern) ?? [])])];
  return hosts.filter((host) => {
    const lower = host.toLowerCase();
    if (allowed.has(lower) || allowed.has(registrable(lower))) return false;
    const normalized = normalizeConfusables(lower);
    return Object.entries(brands).some(([brand, official]) =>
      normalized.includes(brand) && !official.includes(registrable(lower)));
  });
}

export function findRules(text: string, options: RuleOptions = {}): RuleFinding[] {
  const findings: RuleFinding[] = [];
  const support = supportPressure(text);
  if (support) findings.push(support);
  // Weak reasons respect sentence negation ("Never pay with gift cards").
  const clauses = text.split(/(?<=[.!?;])\s+/).filter((clause) => !/\b(?:never|do not|don['’]t|avoid)\b/i.test(clause)).join('\n');
  const payment = pressure(clauses, 'payment_pressure', paymentInstruction);
  if (payment) findings.push(payment);
  const credential = pressure(clauses, 'credential_pressure', credentialInstruction);
  if (credential) findings.push(credential);
  const lookalikes = lookalikeHosts(text, options);
  if (lookalikes.length) findings.push({ reason: 'impersonation', evidence: lookalikes.slice(0, 3).join(' ').slice(0, WINDOW) });
  return findings;
}
