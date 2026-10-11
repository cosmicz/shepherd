import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MessagesFamilyAlert } from '../src/adapters/family.ts';
import { HttpFamilyAlert } from '../src/adapters/http-family.ts';
import { Session, type CaptureHandle } from '../src/application/session.ts';
import { analyzeText, type Assessment, type Frame, type Pattern } from '../src/domain/assessment.ts';
import { demoPersona } from '../src/domain/persona.ts';
import { startServer } from '../src/server/server.ts';

// A fake process runner: osascript is never executed by the test suite.
function runner() {
  const calls: Array<{ executable: string; args: string[] }> = [];
  return { calls, execute: async (executable: string, args: string[]) => { calls.push({ executable, args }); return ''; } };
}
const persona = { person: 'June', family_name: 'Danny' };

test('family alert sends only the rendered template, with message and handle as argv', async () => {
  const r = runner();
  const alert = new MessagesFamilyAlert({ handle: '+15555550100', persona, execute: r.execute, now: () => Date.parse('2026-10-11T20:42:00Z'), timeZone: 'America/Los_Angeles' });
  assert.equal(await alert.notify('family_emergency'), 'sent');
  assert.equal(r.calls.length, 1);
  const { executable, args } = r.calls[0];
  assert.equal(executable, '/usr/bin/osascript');
  assert.deepEqual(args.slice(-2), ["Shepherd noticed a possible family emergency scam on June's screen at 1:42 PM. No action was taken. Call when you can.", '+15555550100']);
  assert.ok(args.slice(0, -2).every((arg) => !arg.includes('June') && !arg.includes('+1555')), 'nothing interpolated into the script');
});

test('no handle, missing person or a failing Messages call is unavailable; cooldown suppresses repeats', async () => {
  const r = runner();
  assert.equal(await new MessagesFamilyAlert({ persona, execute: r.execute }).notify('other'), 'unavailable');
  assert.equal(await new MessagesFamilyAlert({ handle: 'x@example.com', persona: { family_name: 'Danny' }, execute: r.execute }).notify('other'), 'unavailable');
  assert.equal(r.calls.length, 0);
  const failing = new MessagesFamilyAlert({ handle: 'x@example.com', persona, execute: async () => { throw Error('Not authorized to send Apple events'); } });
  assert.equal(await failing.notify('other'), 'unavailable');
  let clock = 0;
  const limited = new MessagesFamilyAlert({ handle: 'x@example.com', persona, execute: r.execute, now: () => clock, cooldown_ms: 60_000 });
  assert.equal(await limited.notify('romance'), 'sent');
  clock = 30_000;
  assert.equal(await limited.notify('romance'), 'cooldown');
  clock = 61_000;
  assert.equal(await limited.notify('romance'), 'sent');
  assert.equal(r.calls.length, 2);
});

test('the family endpoint takes a closed pattern code only, with token and origin', async (t) => {
  const r = runner();
  const runtime = await startServer({ port: 0, family: new MessagesFamilyAlert({ handle: 'x@example.com', persona, execute: r.execute }) });
  t.after(() => runtime.close());
  const { token } = await (await fetch(`${runtime.origin}/api/session`)).json() as { token: string };
  const post = (body: unknown, extra: Record<string, string> = {}) => fetch(`${runtime.origin}/api/family-alert`, {
    method: 'POST', headers: { origin: runtime.origin, 'content-type': 'application/json', 'x-shepherd-token': token, ...extra }, body: JSON.stringify(body),
  });
  assert.equal((await post({ pattern: 'romance' }, { 'x-shepherd-token': 'wrong' })).status, 403);
  assert.equal((await post({ pattern: 'call 555 now' })).status, 400);
  const sent = await post({ pattern: 'tech_support', text: 'INJECTED model text' });
  assert.deepEqual(await sent.json(), { status: 'sent' });
  assert.ok(!r.calls[0].args.join(' ').includes('INJECTED'));
  assert.equal(await new HttpFamilyAlert(runtime.origin).notify('romance'), 'cooldown');
});

test('without a family adapter the endpoint reports unavailable, never an error', async (t) => {
  const runtime = await startServer({ port: 0 });
  t.after(() => runtime.close());
  assert.equal(await new HttpFamilyAlert(runtime.origin).notify('other'), 'unavailable');
});

function sessionHarness(assessment: Assessment, preferences = demoPersona.preferences, configured = demoPersona) {
  const frame: Frame = { frame_id: 'frame-1', source: 'window', image: 'pixels' };
  const spoken: string[] = [];
  const alerts: Pattern[] = [];
  const capture: CaptureHandle = { source: 'window', frame: async () => frame, stop: () => {}, onEnded: () => {} };
  const session = new Session({
    analyze: async () => ({ ...assessment, frame_id: frame.frame_id, source: 'window' }), append: () => {}, speak: (text) => spoken.push(text),
    cancelSpeech: () => {}, onChange: () => {}, interval_ms: 0, persona: configured, notifyFamily: async (pattern) => { alerts.push(pattern); },
  });
  session.setPreferences(preferences);
  return { session, capture, spoken, alerts };
}
const ctx = { frame_id: 'frame-1', source: 'window' as const };

test('demo persona: a cloud scam verdict speaks the scam template and alerts family with the pattern', async () => {
  const assessment: Assessment = { ...analyzeText('Garden news.', ctx), status: 'concern', reasons: ['investment_pressure'], route: 'cloud',
    analyzer: { id: 'cloud-judge', kind: 'model', provider: 'anthropic', model: 'm' }, verdict: 'scam', pattern: 'celebrity_investment', policy_row: '13',
    message: 'MODEL-WRITTEN TEXT', trace: [{ tier: 'cloud', analyzer_id: 'cloud-judge', outcome: 'concern', duration_ms: 900, remote_calls: 1, bytes_out: 700,
      payload_sha256: 'a'.repeat(64), cost: { known: true, usd: 0.005 }, cached: false, versions: { policy: 2, prompt: 1, schema: 2 } }] };
  const h = sessionHarness(assessment);
  await h.session.start(async () => h.capture);
  assert.deepEqual(h.spoken, ['This looks like a fake investment offer. Nobody honest asks for this. Pause and call Danny.']);
  assert.deepEqual(h.alerts, ['celebrity_investment']);
});

test('strong local rules speak the scam template; non-concerns speak and alert nothing', async () => {
  const strong = sessionHarness(analyzeText('Your computer is infected. Call support now.', ctx));
  await strong.session.start(async () => strong.capture);
  assert.deepEqual(strong.spoken, ['This looks like a tech support scam. Nobody honest asks for this. Pause and call Danny.']);
  assert.deepEqual(strong.alerts, ['tech_support']);
  const quiet = sessionHarness({ ...analyzeText('Garden news.', ctx), status: 'inconclusive' });
  await quiet.session.start(async () => quiet.capture);
  assert.deepEqual([quiet.spoken.length, quiet.alerts.length], [0, 0]);
});

test('family preference off sends nothing; no family name falls back to the cautionary template', async () => {
  const off = sessionHarness(analyzeText('Your computer is infected. Call support now.', ctx), { speech: true, history: false, family: false });
  await off.session.start(async () => off.capture);
  assert.equal(off.alerts.length, 0);
  const unnamed = sessionHarness(analyzeText('Your computer is infected. Call support now.', ctx), demoPersona.preferences, { ...demoPersona, family_name: undefined });
  await unnamed.session.start(async () => unnamed.capture);
  assert.deepEqual(unnamed.spoken, ['This page has signs of a tech support scam. Pause and check with someone you trust before doing anything.']);
});

// a test message on configuration, and failures surfaced to the companion.
test('family test message: sent or unavailable, fixed text only, via the runtime endpoint', async (t) => {
  const r = runner();
  const ok = new MessagesFamilyAlert({ handle: 'x@example.com', persona, execute: r.execute });
  assert.equal(await ok.test(), 'sent');
  assert.match(r.calls[0].args.at(-2) as string, /^This is a test from Shepherd/);
  assert.doesNotMatch(r.calls[0].args.at(-2) as string, /\d/);
  const failing = new MessagesFamilyAlert({ handle: 'x@example.com', persona, execute: async () => { throw Error('denied'); } });
  assert.equal(await failing.test(), 'unavailable');
  assert.equal(await new MessagesFamilyAlert({ persona, execute: r.execute }).test(), 'unavailable');
  const runtime = await startServer({ port: 0, family: ok });
  t.after(() => runtime.close());
  assert.equal(await new HttpFamilyAlert(runtime.origin).test(), 'sent');
});

test('a family alert that cannot be sent is surfaced to the session, never silently dropped', async () => {
  const frame: Frame = { frame_id: 'frame-1', source: 'window', image: 'pixels' };
  const capture: CaptureHandle = { source: 'window', frame: async () => frame, stop: () => {}, onEnded: () => {} };
  const failures: string[] = [];
  const session = new Session({
    analyze: async () => analyzeText('Your computer is infected. Call support now.', { frame_id: 'frame-1', source: 'window' }),
    append: () => {}, speak: () => {}, cancelSpeech: () => {}, onChange: () => {}, interval_ms: 0, persona: demoPersona,
    notifyFamily: async () => 'unavailable', onFamilyResult: (status) => failures.push(status),
  });
  session.setPreferences(demoPersona.preferences);
  await session.start(async () => capture);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(failures, ['unavailable']);
});
