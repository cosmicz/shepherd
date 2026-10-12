import assert from 'node:assert/strict';
import { setImmediate as tick } from 'node:timers/promises';
import { test } from 'node:test';
import type { BannerAction, BannerPort } from '../src/adapters/banner.ts';
import { HttpFamilyAlert } from '../src/adapters/http-family.ts';
import { Session, type CaptureHandle } from '../src/application/session.ts';
import { analyzeText, type Assessment, type EventSummary, type Frame, type Pattern } from '../src/domain/assessment.ts';
import { startServer } from '../src/server/server.ts';

// contract runtime side: the native banner receives the fixed template and the
// pattern label only; the person's choice comes back to the session.
const fakeBanner = (action: BannerAction) => {
  const shown: Array<{ text: string; pattern: string }> = [];
  let closed = 0;
  const port: BannerPort = { show: async (text, pattern) => { shown.push({ text, pattern }); return action; }, close: () => { closed++; } };
  return { port, shown, closed: () => closed };
};

test('banner endpoint: closed codes in, fixed template and label to the banner, choice out', async (t) => {
  const banner = fakeBanner('call');
  const runtime = await startServer({ port: 0, banner: banner.port, persona: { person: 'June', family_name: 'Danny' } });
  let open = true;
  t.after(() => (open ? runtime.close() : undefined));
  const { token } = await (await fetch(`${runtime.origin}/api/session`)).json() as { token: string };
  const post = (body: unknown, extra: Record<string, string> = {}) => fetch(`${runtime.origin}/api/banner`, {
    method: 'POST', headers: { origin: runtime.origin, 'content-type': 'application/json', 'x-shepherd-token': token, ...extra }, body: JSON.stringify(body),
  });
  assert.equal((await post({ kind: 'scam', pattern: 'romance' }, { 'x-shepherd-token': 'wrong' })).status, 403);
  assert.equal((await post({ kind: 'Call 555 now', pattern: 'romance' })).status, 400);
  assert.equal((await post({ kind: 'scam', pattern: 'call 555 now' })).status, 400);
  assert.equal(banner.shown.length, 0);
  const response = await post({ kind: 'scam', pattern: 'celebrity_investment', text: 'INJECTED model text' });
  assert.deepEqual(await response.json(), { action: 'call' });
  assert.deepEqual(banner.shown, [{ text: 'This looks like a fake investment offer. Nobody honest asks for this. Pause and call Danny.', pattern: 'fake investment offer' }]);
  assert.equal(await new HttpFamilyAlert(runtime.origin).banner('suspicious', 'other'), 'call');
  assert.ok(!banner.shown.some((s) => s.text.includes('INJECTED')));
  open = false;
  await runtime.close();
  assert.equal(banner.closed(), 1, 'runtime shutdown closes an open banner');
});

test('banner endpoint: without SHEPHERD_BANNER (no banner port) the answer is unavailable', async (t) => {
  const runtime = await startServer({ port: 0 });
  t.after(() => runtime.close());
  assert.equal(await new HttpFamilyAlert(runtime.origin).banner('scam', 'romance'), 'unavailable');
});

const ctx = { frame_id: 'frame-1', source: 'window' as const };
const concern: Assessment = { ...analyzeText('Garden news.', ctx), status: 'concern', reasons: ['support_pressure'], route: 'local', policy_row: '3' };
function harness(assessment: Assessment, action: string, preferences = { history: true, speech: false, family: false }) {
  const frame: Frame = { frame_id: 'frame-1', source: 'window', image: 'pixels' };
  const capture: CaptureHandle = { source: 'window', frame: async () => frame, stop: () => {}, onEnded: () => {} };
  const banners: Array<[string, Pattern, string]> = [];
  const alerts: Pattern[] = [];
  const events: EventSummary[] = [];
  const results: string[] = [];
  const session = new Session({
    analyze: async () => ({ ...assessment, frame_id: frame.frame_id, source: 'window' }), append: (event) => events.push(event), speak: () => {},
    cancelSpeech: () => {}, onChange: () => {}, interval_ms: 0, persona: { person: 'June', family_name: 'Danny' },
    notifyFamily: async (pattern) => { alerts.push(pattern); return 'sent'; }, onFamilyResult: (status) => results.push(status),
    showBanner: async (kind, pattern, medium) => { banners.push([kind, pattern, medium]); return action; },
  });
  session.setPreferences(preferences);
  return { session, capture, banners, alerts, events, results };
}

test('session: a concern shows the banner; Call alerts the family even with automatic alerts off', async () => {
  const h = harness(concern, 'call');
  await h.session.start(async () => h.capture);
  await tick();
  assert.deepEqual(h.banners, [['scam', 'tech_support', 'screen']]);
  assert.deepEqual(h.alerts, ['tech_support']);
  assert.deepEqual(h.results, ['sent']);
  assert.deepEqual(h.events.map((e) => e.action), ['shown']);
});

test("session: I'm fine records a dismissed history event; timeout records nothing more", async () => {
  const fine = harness(concern, 'fine');
  await fine.session.start(async () => fine.capture);
  await tick();
  assert.deepEqual(fine.events.map((e) => e.action), ['shown', 'dismissed']);
  assert.deepEqual(fine.alerts, []);
  const timeout = harness(concern, 'timeout');
  await timeout.session.start(async () => timeout.capture);
  await tick();
  assert.deepEqual(timeout.events.map((e) => e.action), ['shown']);
  assert.deepEqual(timeout.alerts, []);
});

test('session: no banner for a page without a concern', async () => {
  const h = harness(analyzeText('Garden news and tomato tips.', ctx), 'call');
  await h.session.start(async () => h.capture);
  await tick();
  assert.deepEqual(h.banners, []);
  assert.deepEqual(h.alerts, []);
});
