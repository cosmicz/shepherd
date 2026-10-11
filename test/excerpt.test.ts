import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OpenRouterJudge } from '../src/adapters/openrouter-judge.ts';
import { RoutedAnalyzer, type LocalModelPort } from '../src/application/routing.ts';
import type { Grant, TextFrame } from '../src/domain/assessment.ts';
import { GrantRegistry } from '../src/server/consent.ts';

// the design: the cloud excerpt is always anchored (rules spans, else the local
// cue located in the text); with no anchor nothing is dispatched.
const now = Date.now();
const session = { session_id: 's-by2', generation: 1 };
const grant: Grant = { id: 'g-by2', ...session, source: 'native', scope: 'redacted-text', max_bytes: 2048, version: 1, granted_at: new Date(now - 60_000).toISOString(), expires_at: new Date(now + 3600_000).toISOString() };
const witness = 'Inbox (3) - jdoe - Mail  mail.example.com/u/0/inbox?session=Ab9xQz7  Dr. Alice Nguyen re: biopsy results  Grandma we need to talk privately';
const frame = (text: string): TextFrame => ({ frame_id: `f-${Math.random()}`, source: 'native', ...session, consent: grant, captured_at: new Date(now).toISOString(), text });

function rig(cue: string) {
  const bodies: string[] = [];
  const consent = new GrantRegistry();
  consent.register(grant);
  const local: LocalModelPort = { model: 'stub', available: async () => true, assess: async () => ({ risk: 'medium', reasons: ['family_emergency'], cue }) };
  const cloud = new OpenRouterJudge({ model: 'anthropic/claude-opus-5', transport: async ({ body }) => {
    bodies.push(body);
    return { choices: [{ message: { content: JSON.stringify({ verdict: 'benign', reasons: [], pattern: 'other', rationale: 'r' }) } }], usage: { cost: 0.004 } };
  } });
  return { bodies, analyzer: new RoutedAnalyzer({ extractor: { extract: async (f) => ('text' in f ? f.text : '') }, local, cloud, consent }) };
}

test('witness: no rules evidence and an unlocatable cue -> no dispatch, no_anchor, zero remote calls', async () => {
  const r = rig('a secretive family request');
  const result = await r.analyzer.analyze(frame(witness), new AbortController().signal);
  assert.equal(r.bodies.length, 0);
  assert.equal(result.status, 'inconclusive');
  const last = result.trace.at(-1);
  assert.deepEqual([last?.tier, last?.outcome, last?.failure_kind, last?.remote_calls], ['cloud', 'skipped', 'no_anchor', 0]);
});

test('a located cue anchors the excerpt to its own line; other lines never leave', async () => {
  const text = ['Inbox (3) - jdoe - Mail', 'mail.example.com/u/0/inbox?session=Ab9xQz7', 'Dr. Alice Nguyen re: biopsy results', '', 'Weekend plans', 'Grandma we need to talk privately'].join('\n');
  const r = rig('we need to talk privately');
  await r.analyzer.analyze(frame(text), new AbortController().signal);
  assert.equal(r.bodies.length, 1);
  for (const secret of ['jdoe', 'session=', 'Nguyen', 'biopsy']) assert.ok(!r.bodies[0].includes(secret), secret);
  assert.match(r.bodies[0], /talk privately/);
});

test('the screen head is never an excerpt, even for a long unanchored screen', async () => {
  const r = rig('');
  await r.analyzer.analyze(frame(`${witness}\n${'Quarterly statement line item\n'.repeat(40)}`), new AbortController().signal);
  assert.equal(r.bodies.length, 0);
});
