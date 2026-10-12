import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OpenRouterJudge } from '../src/adapters/openrouter-judge.ts';
import { RoutedAnalyzer, type LocalModelPort } from '../src/application/routing.ts';
import type { Grant, TextFrame } from '../src/domain/assessment.ts';
import { GrantRegistry } from '../src/server/consent.ts';

// contract: the cloud excerpt is always anchored (rules spans, else the local
// cue located in the text); with no anchor nothing is dispatched.
const now = Date.now();
const session = { session_id: 's-by2', generation: 1 };
const grant: Grant = { id: 'g-by2', ...session, source: 'native', scope: 'redacted-text', max_bytes: 2048, version: 1, granted_at: new Date(now - 60_000).toISOString(), expires_at: new Date(now + 3600_000).toISOString() };
const witness = 'Inbox (3) - jdoe - Mail  mail.example.com/u/0/inbox?session=Ab9xQz7  Dr. Alice Nguyen re: biopsy results  Grandma we need to talk privately';
const frame = (text: string): TextFrame => ({ frame_id: `f-${Math.random()}`, source: 'native', ...session, consent: grant, captured_at: new Date(now).toISOString(), text });

function rig(cue: string, quoteExcerpts = false) {
  const bodies: string[] = [];
  const consent = new GrantRegistry();
  consent.register(grant);
  const local: LocalModelPort = { model: 'stub', available: async () => true, assess: async () => ({ risk: 'medium', reasons: ['family_emergency'], cue }) };
  const cloud = new OpenRouterJudge({ model: 'anthropic/claude-opus-5', transport: async ({ body }) => {
    bodies.push(body);
    return { choices: [{ message: { content: JSON.stringify({ verdict: 'benign', reasons: [], pattern: 'other', rationale: 'r' }) } }], usage: { cost: 0.004 } };
  } });
  return { bodies, analyzer: new RoutedAnalyzer({ extractor: { extract: async (f) => ('text' in f ? f.text : '') }, local, cloud, consent, quoteExcerpts }) };
}

test('witness: no rules evidence and an unlocatable cue -> no dispatch, no_anchor, zero remote calls', async () => {
  const r = rig('a secretive family request');
  const result = await r.analyzer.analyze(frame(witness), new AbortController().signal);
  assert.equal(r.bodies.length, 0);
  assert.equal(result.status, 'inconclusive');
  const last = result.trace.at(-1);
  assert.deepEqual([last?.tier, last?.outcome, last?.failure_kind, last?.remote_calls], ['cloud', 'skipped', 'no_anchor', 0]);
});

test('a located cue sends only its own line: adjacent lines never leave (no blank-line padding)', async () => {
  const text = ['Inbox - jdoe - Mail', 'Dr. Alice Nguyen re: biopsy results', 'Grandma please send the money now', 'Weekend plans'].join('\n');
  const r = rig('please send the money now', true);
  await r.analyzer.analyze(frame(text), new AbortController().signal);
  assert.equal(r.bodies.length, 1);
  for (const secret of ['jdoe', 'Nguyen', 'biopsy', 'Weekend']) assert.ok(!r.bodies[0].includes(secret), secret);
  assert.match(r.bodies[0], /send the money now/);
});

test('flat text: the window stops at sentence ends and tab-strip separators', async () => {
  // Separate rigs: identical anchored excerpts would otherwise be a cache hit.
  const bodies: string[] = [];
  for (const text of ['Dr. Alice Nguyen re: biopsy results. Grandma please send the money now. Weekend plans attached.',
    'mail.example.com/u/0/inbox?session=Ab9 | Bank - Statements | Grandma please send the money now | Settings']) {
    const r = rig('please send the money now', true);
    await r.analyzer.analyze(frame(text), new AbortController().signal);
    bodies.push(...r.bodies);
  }
  assert.equal(bodies.length, 2);
  for (const body of bodies) for (const secret of ['Nguyen', 'biopsy', 'Weekend', 'session', 'Statements', 'Settings']) assert.ok(!body.includes(secret), `${secret} in ${body}`);
});

test('a lookalike host contributes no excerpt text', async () => {
  const r = rig('');
  await r.analyzer.analyze(frame('Account center\nSign in at paypa1-billing.com\nNothing else here'), new AbortController().signal);
  for (const body of r.bodies) assert.ok(!body.includes('paypa1'), body);
});

// Contract v3: no fuzzy or lexicon fallback; a non-verbatim cue sends nothing.
test('a paraphrased or near-verbatim cue without a rules span does not dispatch', async () => {
  const text = ['Dear Friend,', 'Elias Vance has personally selected a small group of long-time supporters.', 'Your reservation is held for you.'].join('\n');
  for (const cue of ['an exclusive pre-launch share offer from a famous founder', 'personally selected a small group of supporters']) {
    const r = rig(cue);
    const result = await r.analyzer.analyze(frame(text), new AbortController().signal);
    assert.equal(r.bodies.length, 0, cue);
    assert.equal(result.trace.at(-1)?.failure_kind, 'no_anchor');
  }
});

// d3l: the quote path is off by default; when on, it needs a pressure term.
test('quote path off (default): no rules span means no dispatch, whatever the model quotes', async () => {
  for (const [text, cue] of [[witness, 'Dr. Alice Nguyen re: biopsy results'], ['Grandma please send the gift card codes now, love Danny', 'please send the gift card codes now']]) {
    // The second quote carries a pressure term: only the default-off switch stops it.
    const r = rig(cue);
    const result = await r.analyzer.analyze(frame(text), new AbortController().signal);
    assert.equal(r.bodies.length, 0, cue);
    assert.equal(result.trace.at(-1)?.failure_kind, 'no_anchor');
  }
});

test('quote path on: a quote without a pressure term is not sent', async () => {
  const r = rig('we need to talk privately', true);
  await r.analyzer.analyze(frame('Grandma we need to talk privately about the weekend'), new AbortController().signal);
  assert.equal(r.bodies.length, 0);
});

test('quote path on: a verbatim pressure quote is sent exactly and marked as a quote', async () => {
  const r = rig('please send the gift card codes now', true);
  const result = await r.analyzer.analyze(frame('Grandma please send the gift card codes now, love Danny'), new AbortController().signal);
  assert.equal(r.bodies.length, 1);
  assert.match(r.bodies[0], /please send the gift card codes now/);
  assert.ok(!r.bodies[0].includes('Grandma') && !r.bodies[0].includes('Danny'));
  assert.equal(result.trace.at(-1)?.excerpt_source, 'quote');
});

test('the Mars fixture still dispatches through its investment_pressure span (excerpt_source rules)', async () => {
  const mars = 'join the private pre-IPO\nround for Mars Colony One before it lists\npublicly. Only 200 founding allocations exist';
  const r = rig('');
  const result = await r.analyzer.analyze(frame(mars), new AbortController().signal);
  assert.equal(r.bodies.length, 1);
  assert.equal(result.trace.at(-1)?.excerpt_source, 'rules');
});

test('the screen head is never an excerpt, even for a long unanchored screen', async () => {
  const r = rig('');
  await r.analyzer.analyze(frame(`${witness}\n${'Quarterly statement line item\n'.repeat(40)}`), new AbortController().signal);
  assert.equal(r.bodies.length, 0);
});

test('a span found only in display_text never anchors a cloud excerpt', async () => {
  const r = rig('garden club invitation', true);
  const result = await r.analyzer.analyze({
    ...frame('Garden club invitation for Saturday.'),
    display_text: 'Your computer is infected. Call support immediately.',
    display_lines: [{ text: 'Your computer is infected. Call support immediately.', x: 10, y: 10, w: 300, h: 20 }],
  }, new AbortController().signal);
  assert.equal(r.bodies.length, 0);
  assert.deepEqual([result.route, result.trace.at(-1)?.failure_kind, result.trace.at(-1)?.remote_calls], ['local-model', 'no_anchor', 0]);
});

test('the companion scope statement names model quotes only when the quote path is on', async () => {
  const { startServer } = await import('../src/server/server.ts');
  for (const quoteExcerpts of [false, true]) {
    const runtime = await startServer({ port: 0, quoteExcerpts });
    const script = await (await fetch(`${runtime.origin}/companion.js`)).text();
    await runtime.close();
    assert.equal(script.includes('a short phrase the local model quotes from the screen'), quoteExcerpts);
  }
});
