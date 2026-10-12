// On-device voice source (contract): schema for source 'voice' and the Node
// adapter over the Swift helper's JSON lines. A fake process stands in for the
// helper; nothing here starts a microphone or asks for permission.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FakeHelper, settle } from './support/fake-helper.ts';
import { VoiceSource, type VoiceUnavailable } from '../src/adapters/voice-source.ts';
import { RoutedAnalyzer } from '../src/application/routing.ts';
import { checkGrant, parseAssessment, parseGrant, parseTextFrame, type Grant, type TextFrame } from '../src/domain/assessment.ts';
import { decodeFrame } from '../src/server/frame.ts';

const voice = { frame_id: 'v-1', source: 'voice', text: 'This is the tax office. You must pay today.', captured_at: '2026-10-11T15:40:00.000Z' };
const grantFor = (source: Grant['source']): Grant => parseGrant({ id: `g-${source}`, session_id: 's-1', generation: 1, source, scope: 'redacted-text', max_bytes: 2048, version: 1, granted_at: '2026-10-11T15:00:00Z', expires_at: '2026-10-11T16:00:00Z' });

test('a voice TextFrame parses and decodes as text, never as pixels', () => {
  assert.equal(parseTextFrame(voice).source, 'voice');
  assert.equal(decodeFrame(voice).frame.source, 'voice');
  assert.equal(decodeFrame(voice).png, undefined);
});

test('a voice frame carries no screen metadata', () => {
  for (const extra of [{ app: 'Phone' }, { url: 'https://example.com' }, { window_title: 't' }, { bundle_id: 'b' }, { lines: [] }, { display_text: 'x' }, { scope: 'window' }, { url_status: 'absent', url: null }, { evidence_regions: [] }]) {
    assert.throws(() => parseTextFrame({ ...voice, ...extra }), `voice frame with ${Object.keys(extra)}`);
  }
});

test('voice consent is separate from screen consent', () => {
  const frame: TextFrame = { ...parseTextFrame(voice), session_id: 's-1', generation: 1 };
  const now = Date.parse('2026-10-11T15:30:00Z');
  for (const screen of ['window', 'tab', 'native'] as const) assert.equal(checkGrant({ ...frame, consent: grantFor(screen) }, now), 'no_consent');
  assert.equal(checkGrant({ ...frame, consent: grantFor('voice') }, now), 'ok');
});

const segment = (extra: Record<string, unknown> = {}) => ({ kind: 'segment', t_start: '2026-10-11T15:40:00.000Z', t_end: '2026-10-11T15:40:06.500Z', text: 'You must pay today with gift cards.', confidence: 0.82, reason: 'change', origin: 'system', ...extra });

function harness() {
  const children: FakeHelper[] = [];
  const launches: Array<{ executable: string; args: string[]; env?: NodeJS.ProcessEnv }> = [];
  const frames: TextFrame[] = [];
  const states: string[] = [];
  const unavailable: VoiceUnavailable[] = [];
  let ids = 0;
  const source = new VoiceSource({
    launcher: (executable, args, options) => { launches.push({ executable, args, env: options.env }); const child = new FakeHelper(); children.push(child); return child; },
    executable: '/fake/shepherd-voice', publish: (frame) => frames.push(frame), onState: (state) => states.push(state),
    onUnavailable: (state) => unavailable.push(state), id: () => `voice-${++ids}`, envelope: () => ({ session_id: 's-1', generation: 4 }),
  });
  return { source, children, launches, frames, states, unavailable };
}

test('voice is off until started; start launches the helper with a minimal environment', () => {
  const h = harness();
  assert.equal(h.launches.length, 0);
  assert.equal(h.source.listening, false);
  h.source.start();
  assert.equal(h.launches.length, 1);
  assert.deepEqual(h.launches[0].args, ['--locale', 'en-US', '--input', 'system']);
  assert.deepEqual(Object.keys(h.launches[0].env ?? {}).sort(), ['OMP_THREAD_LIMIT', 'PATH']);
});

test('segments become voice TextFrames with the session envelope; the listening state follows the helper', async () => {
  const h = harness();
  h.source.start();
  const child = h.children[0];
  child.line({ kind: 'listening', locale: 'en-US' });
  child.line(segment());
  child.line(segment({ reason: 'interval', t_end: '2026-10-11T15:40:30.000Z' }));
  await settle();
  assert.equal(h.source.listening, true);
  assert.deepEqual(h.frames.map((f) => [f.frame_id, f.source, f.captured_at, f.session_id, f.generation]), [
    ['voice-1', 'voice', '2026-10-11T15:40:06.500Z', 's-1', 4], ['voice-2', 'voice', '2026-10-11T15:40:30.000Z', 's-1', 4],
  ]);
  assert.equal(h.frames[0].text, 'You must pay today with gift cards.');
  for (const frame of h.frames) parseTextFrame(frame);
  child.line({ kind: 'stopped' });
  await settle();
  assert.equal(h.source.listening, false);
  assert.deepEqual(h.states, ['listening', 'stopped']);
});

test('the adapter re-checks the bounds and drops malformed segments', async () => {
  const h = harness();
  h.source.start();
  const child = h.children[0];
  const bad = [
    segment({ text: 'x'.repeat(401) }), segment({ text: '' }), segment({ text: '   ' }),
    segment({ t_end: '2026-10-11T15:40:36.000Z' }), segment({ t_end: '2026-10-11T15:39:59.000Z' }),
    segment({ confidence: 1.5 }), segment({ confidence: -0.1 }), segment({ reason: 'stop' }), segment({ speaker: 'Bank' }),
    segment({ t_start: 'yesterday' }), 'not json', { kind: 'audio', data: 'AAAA' }, segment({ origin: 'speakerphone' }), segment({ origin: undefined }),
  ];
  for (const line of bad) child.line(line);
  child.line(segment({ text: 'y'.repeat(400), t_end: '2026-10-11T15:40:35.000Z' }));
  await settle();
  assert.equal(h.frames.length, 1, 'only the in-bounds segment (400 chars, 35 s with finalisation grace) is kept');
  assert.equal(h.source.dropped, bad.length);
});

test('unavailable states are bounded codes, never helper text', async () => {
  const cases: Array<[unknown, VoiceUnavailable['code']]> = [
    [{ kind: 'unavailable', reason: 'no_on_device_model' }, 'no_on_device_model'],
    [{ kind: 'unavailable', reason: 'speech_denied' }, 'permission_denied'],
    [{ kind: 'unavailable', reason: 'microphone_unavailable' }, 'permission_denied'],
    [{ kind: 'unavailable', reason: 'recognizer_unavailable' }, 'helper_unavailable'],
    [{ kind: 'unavailable', reason: 'system_audio_denied' }, 'permission_denied'],
    [{ kind: 'unavailable', reason: 'system_audio_unavailable' }, 'helper_unavailable'],
    [{ kind: 'unavailable', reason: 'something new' }, 'helper_failed'],
  ];
  for (const [line, code] of cases) {
    const h = harness();
    h.source.start();
    h.children[0].line(line);
    await settle();
    assert.deepEqual(h.unavailable.map((u) => u.code), [code]);
    assert.ok(!JSON.stringify(h.unavailable).includes('something new'));
  }
  const exited = harness();
  exited.source.start();
  exited.children[0].emit('close', 1);
  assert.deepEqual(exited.unavailable.map((u) => u.code), ['helper_exited']);
  const missing = harness();
  missing.source.start();
  missing.children[0].emit('error', Error('ENOENT'));
  assert.deepEqual(missing.unavailable.map((u) => u.code), ['helper_unavailable']);
});

test('stop sends SIGTERM once and ignores anything the helper prints afterwards', async () => {
  const h = harness();
  h.source.start();
  const child = h.children[0];
  child.line({ kind: 'listening', locale: 'en-US' });
  await settle();
  h.source.stop();
  h.source.stop();
  child.line(segment());
  await settle();
  assert.deepEqual(child.signals, ['SIGTERM']);
  assert.equal(h.frames.length, 0);
  assert.equal(h.source.listening, false);
});

test('rules run on segment text: a spoken scam script is a local concern with zero egress', async () => {
  const h = harness();
  h.source.start();
  h.children[0].line(segment({ text: 'Your account will be suspended today. Please buy gift cards now and send the codes.' }));
  await settle();
  const analyzer = new RoutedAnalyzer({ extractor: { extract: async (f) => ('text' in f ? f.text : '') },
    local: { model: 'l', available: async () => true, assess: async () => ({ risk: 'high', reasons: ['payment_pressure'], cue: '' }) } });
  const result = parseAssessment(await analyzer.analyze(h.frames[0], new AbortController().signal));
  assert.deepEqual([result.source, result.status, result.policy_row], ['voice', 'concern', '7']);
  assert.equal(result.trace.reduce((n, s) => n + s.remote_calls + s.bytes_out, 0), 0);
});

test('spoken voice warnings describe what is said, never the screen or who is speaking', async () => {
  const { patterns } = await import('../src/domain/assessment.ts');
  const { speechText } = await import('../src/domain/templates.ts');
  for (const pattern of patterns) for (const kind of ['suspicious', 'scam'] as const) {
    const text = speechText(kind, pattern, { person: 'June', family_name: 'Danny' }, 'voice');
    assert.doesNotMatch(text, /\b(?:page|screen|caller|calling|is from|speaking|speaker|bank|agent)\b/i, text);
    assert.notEqual(text, speechText(kind, pattern, { person: 'June', family_name: 'Danny' }, 'screen'));
  }
});

test('a voice concern is spoken with the voice wording and alerts family with the voice medium', async () => {
  const { Session } = await import('../src/application/session.ts');
  const { analyzeText } = await import('../src/domain/assessment.ts');
  const { demoPersona } = await import('../src/domain/persona.ts');
  const spoken: string[] = [];
  const alerts: string[] = [];
  const assessment = { ...analyzeText('Your account will be suspended today. Please buy gift cards now and send the codes.', { frame_id: 'v-9', source: 'voice' }) };
  const frame = parseTextFrame({ ...voice, frame_id: 'v-9' });
  const session = new Session({
    analyze: async () => assessment, append: () => {}, speak: (text) => { spoken.push(text); }, cancelSpeech: () => {}, onChange: () => {},
    interval_ms: 0, persona: demoPersona, notifyFamily: async (pattern, medium) => { alerts.push(`${pattern}/${medium}`); return 'sent'; },
  });
  session.setPreferences({ history: false, speech: true, family: true });
  await session.start(async () => ({ source: 'voice', frame: async () => frame, stop: () => {}, onEnded: () => {} }));
  await settle();
  assert.equal(assessment.status, 'concern');
  assert.equal(spoken.length, 1);
  assert.match(spoken[0], /^What is being said has signs of/);
  assert.deepEqual(alerts, ['other/voice']);
});

// the team 15:42: a fixed voice family template under the same guards.
test('voice family text says heard near the computer, never who spoke, and only local placeholders', async () => {
  const { familyText, templateTable } = await import('../src/domain/templates.ts');
  const { patterns } = await import('../src/domain/assessment.ts');
  const at = new Date('2026-10-11T22:42:00Z');
  assert.equal(familyText('family_emergency', { person: 'June', family_name: 'Danny' }, at, 'America/Los_Angeles', 'voice'),
    "Shepherd heard signs of a possible family emergency scam near June's computer at 3:42 PM. No action was taken. Call when you can.");
  assert.match(familyText('tech_support', { person: 'June' }, at, 'UTC'), /on June's screen/);
  for (const pattern of patterns) {
    const text = familyText(pattern, { person: 'June' }, at, 'UTC', 'voice');
    assert.doesNotMatch(text, /\b(?:caller|calling|speaker|speaking|said by|from the bank|agent)\b/i, text);
  }
  assert.doesNotMatch(templateTable.voice_family, /\d|https?:/);
});

test('the family endpoint takes a closed medium; the Messages alert renders the voice template', async (t) => {
  const { MessagesFamilyAlert } = await import('../src/adapters/family.ts');
  const { HttpFamilyAlert } = await import('../src/adapters/http-family.ts');
  const { startServer } = await import('../src/server/server.ts');
  const sent: string[] = [];
  const family = new MessagesFamilyAlert({ handle: 'x@example.com', persona: { person: 'June', family_name: 'Danny' }, cooldown_ms: 0,
    execute: async (_executable: string, args: string[]) => { sent.push(args.at(-2) as string); return ''; } });
  const runtime = await startServer({ port: 0, family });
  t.after(() => runtime.close());
  assert.equal(await new HttpFamilyAlert(runtime.origin).notify('romance', 'voice'), 'sent');
  assert.equal(await new HttpFamilyAlert(runtime.origin).notify('romance'), 'sent');
  assert.match(sent[0], /^Shepherd heard signs of a possible romance scam near June's computer/);
  assert.match(sent[1], /on June's screen/);
  const { token } = await (await fetch(`${runtime.origin}/api/session`)).json() as { token: string };
  const forged = await fetch(`${runtime.origin}/api/family-alert`, { method: 'POST', headers: { origin: runtime.origin, 'content-type': 'application/json', 'x-shepherd-token': token }, body: JSON.stringify({ pattern: 'romance', medium: 'video call from your bank' }) });
  assert.equal(forged.status, 400);
  assert.equal(sent.length, 2);
});

test('system audio is the default; the microphone is an explicit option; segments keep their origin', async () => {
  const h = harness();
  h.source.start();
  h.children[0].line({ kind: 'listening', locale: 'en-US', origin: 'system' });
  h.children[0].line(segment());
  await settle();
  assert.equal(h.source.origin, 'system');
  assert.equal(h.frames[0].voice_origin, 'system');
  const mic = new VoiceSource({ launcher: (_e, args) => { assert.deepEqual(args, ['--locale', 'en-US', '--input', 'microphone']); return new FakeHelper(); }, input: 'microphone', publish: () => {} });
  mic.start();
  assert.throws(() => parseTextFrame({ frame_id: 'n', source: 'native', text: 't', captured_at: '2026-10-11T15:40:00.000Z', voice_origin: 'system' }), 'origin is voice-only');
  assert.throws(() => parseTextFrame({ ...voice, voice_origin: 'speakerphone' }));
});
