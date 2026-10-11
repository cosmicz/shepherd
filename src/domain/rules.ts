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

// Weak investment_pressure: an investment offer, an urgency cue
// and a too-good cue in one window. Multi-word cues tolerate OCR line breaks.
const offer = /\b(?:shares?|pre-?ipo|crypto\w*|returns?|investments?|allocations?|stake|stocks?)\b/i;
const investmentUrgency = new RegExp([
  urgency.source,
  String.raw`\b\d+\s+hours?\b`,
  String.raw`\bbefore\s+(?:it|the\s+(?:ipo|launch|listing))\s+(?:lists?|launch(?:es)?|goes\s+public)\b`,
  String.raw`\blast\s+chance\b`,
  String.raw`\bexpires?\b`,
].join('|'), 'i');
const tooGood = /\b(?:guaranteed|double\s+your|\d+\s?x\b|\d+\s+times|(?:ten|twenty|thirty|fifty|hundred)\s+times|limited\s+(?:allocations?|spots?|seats?)|only\s+\d+\s+(?:\w+\s+){0,2}(?:allocations?|spots?|seats?|shares?))/i;

function investmentPressure(text: string): RuleFinding | undefined {
  const urgent = matches(investmentUrgency, text);
  const good = matches(tooGood, text);
  for (const found of matches(offer, text)) {
    const hurry = near(urgent, found);
    const promise = hurry && near(good, found);
    if (hurry && promise && Math.max(found.end, hurry.end, promise.end) - Math.min(found.index, hurry.index, promise.index) <= WINDOW) {
      return { reason: 'investment_pressure', evidence: span(text, [found, hurry, promise]) };
    }
  }
  return undefined;
}

// Weak remote_access: a named remote-access tool together with an
// instruction to install, open, allow or hand over its code. Legitimate support
// installs exist, so it stays weak and needs the local model to corroborate.
const remoteTool = /\b(?:any\s?desk|team\s?viewer(?:\s+quick\s?support)?|log\s?me\s?in(?:123)?|ultra\s?viewer|splashtop|connect\s?wise|screen\s?connect|quick\s?assist|rust\s?desk|supremo|screen\s+shar(?:e|ing))\b/i;
const remoteInstruction = /\b(?:download|install|open|run|allow|give|enable|start|accept|go\s+to|enter|read\s+(?:me\s+)?the)\b/i;

function remoteAccess(text: string): RuleFinding | undefined {
  const instructions = matches(remoteInstruction, text);
  for (const tool of matches(remoteTool, text)) {
    const instruction = near(instructions, tool);
    if (instruction) return { reason: 'remote_access', evidence: span(text, [instruction, tool]) };
  }
  return undefined;
}

// Weak ai_instruction: on-screen text addressed to an assistant or
// model, so a page cannot steer the local model to a clean result unseen.
const aiInstruction = new RegExp([
  String.raw`\b(?:ignore|disregard|forget)\s+(?:all\s+|any\s+)?(?:the\s+|your\s+)?(?:previous|prior|above|earlier|preceding)\s+(?:instructions?|prompts?|rules|messages?)\b`,
  String.raw`\byou\s+are\s+(?:now\s+)?(?:an?\s+)?(?:ai|assistant|ai\s+assistant|language\s+model|llm|chatbot)\b`,
  String.raw`\bclassify\s+this\s+(?:\w+\s+){0,2}as\b`,
  String.raw`\brespond\s+(?:only\s+)?with\s+(?:no_signal|benign|safe|low|"|')`,
  String.raw`\bsystem\s+prompt\b`,
  String.raw`\b(?:note|message)\s+to\s+(?:the\s+)?(?:ai|assistant|model|llm)\b`,
].join('|'), 'i');

function aiInstructionFinding(text: string): RuleFinding | undefined {
  const found = matches(aiInstruction, text)[0];
  return found && { reason: 'ai_instruction', evidence: span(text, [found]) };
}

// Lookalike domains. An OCR-derived indicator that
// yields the weak reason impersonation only; it infers nothing about ownership
// or authenticity, and a non-match says nothing about safety. Four bounded rules:
// confusable/transposition/dropped-or-doubled-letter edits of a brand label; a
// brand token beside a suspicious token on a non-hosting domain; a brand label
// on a TLD outside its official set; and address-bar input only.
const brands = new Set(['microsoft', 'apple', 'google', 'paypal', 'amazon', 'netflix', 'facebook', 'chase',
  'wellsfargo', 'bankofamerica', 'coinbase', 'medicare', 'irs', 'ssa', 'usps']);
// Official TLDs for the ten demo brands; other brands accept their label on any TLD.
const officialTlds: Record<string, readonly string[]> = {
  apple: ['com'], microsoft: ['com'], paypal: ['com'], chase: ['com'], wellsfargo: ['com'],
  amazon: ['com', 'de', 'co.uk', 'ca', 'fr', 'it', 'es', 'co.jp', 'in', 'com.au', 'com.br', 'com.mx', 'nl', 'se'],
  google: ['com', 'de', 'co.uk', 'ca', 'fr', 'it', 'es', 'co.jp', 'co.in', 'com.au', 'com.br', 'com.mx', 'nl', 'se'],
  medicare: ['gov'], irs: ['gov'], ssa: ['gov'],
};
const suspiciousTokens = new Set(['support', 'verify', 'secure', 'login', 'billing', 'account', 'help', 'gift', 'update', 'security', 'id', 'alert', 'recovery']);
const hostingDomains = new Set(['github.io', 'github.com', 'wordpress.com', 'medium.com', 'reddit.com', 'youtube.com', 'linkedin.com']);
const unicodeConfusables: Record<string, string> = {
  'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'у': 'y', 'х': 'x', 'і': 'i', 'ј': 'j', 'ѕ': 's', 'ԁ': 'd', 'ɡ': 'g',
  'ο': 'o', 'α': 'a', 'ν': 'v', 'ρ': 'p', 'ι': 'i', 'κ': 'k',
};

export function normalizeConfusables(value: string): string {
  return [...value.normalize('NFKC').toLowerCase()].map((char) => unicodeConfusables[char] ?? char).join('')
    .replace(/0/g, 'o').replace(/1/g, 'l').replace(/5/g, 's').replace(/rn/g, 'm').replace(/vv/g, 'w').replace(/cl/g, 'd');
}

// Two-level public suffixes, so google.co.uk and amazon.com.au resolve to their brand label.
const secondLevel = new Set(['co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'net.au', 'org.au', 'co.nz', 'co.jp', 'co.in', 'com.br', 'com.mx', 'co.za', 'com.sg', 'com.hk']);
function registrable(host: string): { domain: string; label: string; suffix: string } {
  const labels = host.split('.');
  const size = labels.length > 2 && secondLevel.has(labels.slice(-2).join('.')) ? 3 : 2;
  const parts = labels.slice(-size);
  return { domain: parts.join('.'), label: parts[0], suffix: parts.slice(1).join('.') };
}

// A typo-squat edit of a brand: adjacent transposition, one dropped letter, or one
// doubled letter. Arbitrary substitutions (phase/chase, goggle/google) do not count.
function typoOf(label: string, brand: string): boolean {
  if (label === brand) return false;
  if (label.length === brand.length) {
    const diff = [...label].map((char, index) => char !== brand[index] ? index : -1).filter((index) => index >= 0);
    return diff.length === 2 && diff[1] === diff[0] + 1 && label[diff[0]] === brand[diff[1]] && label[diff[1]] === brand[diff[0]];
  }
  if (label.length === brand.length - 1) return [...brand].some((_char, index) => brand.slice(0, index) + brand.slice(index + 1) === label);
  if (label.length === brand.length + 1) return [...label].some((char, index) => index > 0 && char === label[index - 1] && label.slice(0, index) + label.slice(index + 1) === brand);
  return false;
}

function lookalike(host: string): boolean {
  const lower = host.toLowerCase();
  const { domain, label, suffix } = registrable(lower);
  if (hostingDomains.has(domain)) return false;
  // Official-TLD rule: the brand's own label on a TLD outside its official set.
  if (brands.has(label)) return !!officialTlds[label] && !officialTlds[label].includes(suffix);
  const normalized = normalizeConfusables(label);
  for (const brand of brands) {
    // Edit rule: confusable spelling of the label itself, or a typo-squat edit.
    if (normalized === brand || (brand.length >= 5 && typoOf(normalized, brand))) return true;
  }
  // Token rule: a brand token together with a suspicious token anywhere in the host.
  const tokens = lower.split(/[.-]/).map(normalizeConfusables);
  return tokens.some((token) => brands.has(token)) && tokens.some((token) => suspiciousTokens.has(token));
}

// Address-bar input only: the url field, or for pixel frames the first OCR line
// when that line is an address (a host, optionally with scheme and path).
const addressLine = /^(?:https?:\/\/)?((?:[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?\.)+\p{L}{2,24})(?::\d+)?(?:[/?#]\S*)?$/u;
function addressHosts(text: string, url: string | null | undefined): string[] {
  if (url) {
    try { return [new URL(url).hostname]; } catch { return []; }
  }
  const first = text.split('\n').map((line) => line.trim()).find(Boolean) ?? '';
  const match = addressLine.exec(first.replace(/\s+/g, ''));
  return match ? [match[1]] : [];
}

export function lookalikeHosts(text: string, options: RuleOptions = {}): string[] {
  const allowed = new Set((options.allowlist ?? []).map((host) => host.toLowerCase()));
  return addressHosts(text, options.url).filter((host) => {
    const lower = host.toLowerCase();
    if (allowed.has(lower) || allowed.has(registrable(lower).domain)) return false;
    return lookalike(lower);
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
  const investment = investmentPressure(clauses);
  if (investment) findings.push(investment);
  const remote = remoteAccess(clauses);
  if (remote) findings.push(remote);
  const instruction = aiInstructionFinding(text);
  if (instruction) findings.push(instruction);
  const lookalikes = lookalikeHosts(text, options);
  if (lookalikes.length) findings.push({ reason: 'impersonation', evidence: lookalikes.slice(0, 3).join(' ').slice(0, WINDOW) });
  return findings;
}
