import assert from 'node:assert/strict';
import { test } from 'node:test';
import { patterns, type Assessment } from '../src/domain/assessment.ts';
import {
  familyText, patternLabels, speechKind, speechText, TemplateError, templateTable, type Persona,
} from '../src/domain/templates.ts';

const persona: Persona = { person: 'June', family_name: 'Danny' };
const sentences = (text: string) => text.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
const base = { frame_id: 'f', source: 'native', status: 'concern', reasons: ['impersonation'], evidence: [], message: 'm', media_origin: 'not_assessed', duration_ms: 1, trace: [] } as const;
const assessment = (extra: Partial<Assessment>): Assessment => ({ ...base, reasons: ['impersonation'], analyzer: { id: 'local-ocr-rules', kind: 'rules', version: '1' }, route: 'local', ...extra } as Assessment);

test('templates and pattern labels contain no URLs or numbers', () => {
  for (const text of [...Object.values(templateTable), ...Object.values(patternLabels)]) {
    assert.doesNotMatch(text, /\d|https?:|www\.|\.(?:com|org|net)\b/i, text);
  }
});

test('every reachable (pattern, verdict kind) renders distinct wording', () => {
  const seen = new Set<string>();
  for (const pattern of patterns) for (const kind of ['scam', 'suspicious'] as const) {
    const text = speechText(kind, pattern, persona);
    assert.ok(!seen.has(text), text);
    seen.add(text);
    assert.doesNotMatch(text, /[{}]/, 'no unfilled placeholder');
  }
});

test('scam and suspicious wording never share a sentence', () => {
  for (const pattern of patterns) {
    const scam = new Set(sentences(speechText('scam', pattern, persona)));
    for (const sentence of sentences(speechText('suspicious', pattern, persona))) assert.ok(!scam.has(sentence), sentence);
  }
});

test('a placeholder without local configuration rejects the template', () => {
  assert.throws(() => speechText('scam', 'tech_support', { person: 'June' }), TemplateError);
  assert.throws(() => familyText('tech_support', { family_name: 'Danny' }, new Date()), TemplateError);
  // The suspicious template needs no family name.
  assert.match(speechText('suspicious', 'tech_support', { person: 'June' }), /tech support scam/);
});

test('family text names the pattern, person and time only', () => {
  const at = new Date('2026-10-11T20:42:00Z');
  const text = familyText('celebrity_investment', persona, at, 'America/Los_Angeles');
  assert.equal(text, "Shepherd noticed a possible fake investment offer on June's screen at 1:42 PM. No action was taken. Call when you can.");
});

test('verdict kind follows the route: cloud verdict, strong rules, local model', () => {
  assert.equal(speechKind(assessment({ verdict: 'scam', pattern: 'romance', route: 'cloud', analyzer: { id: 'cloud-judge', kind: 'model', provider: 'anthropic', model: 'm' } })), 'scam');
  assert.equal(speechKind(assessment({ verdict: 'suspicious', pattern: 'romance', route: 'cloud', analyzer: { id: 'cloud-judge', kind: 'model', provider: 'anthropic', model: 'm' } })), 'suspicious');
  assert.equal(speechKind(assessment({ reasons: ['support_pressure'], policy_row: '3' })), 'scam');
  assert.equal(speechKind(assessment({ reasons: ['family_emergency'], policy_row: '7', route: 'local-model', analyzer: { id: 'local-model', kind: 'model', model: 'q' } })), 'suspicious');
  assert.equal(speechKind(assessment({ status: 'inconclusive', reasons: [] })), undefined, 'only concerns are spoken');
});
