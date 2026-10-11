import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Session, type CaptureHandle } from '../src/application/session.ts';
import { analyzeText, type Assessment, type Frame } from '../src/domain/assessment.ts';
import { toEvent } from '../src/domain/assessment.ts';
import { LocalHistory } from '../src/adapters/history.ts';
import { AnalysisCancelled } from '../src/application/analyzer.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const frame: Frame = { frame_id: 'frame-1', source: 'window', image: 'pixel-fixture' };
const concern = () => analyzeText('Your computer is infected. Call support immediately. Do not close this window.', frame);

function harness(analyze: (frame: Frame, signal: AbortSignal) => Promise<Assessment> = async () => concern()) {
  let stopped = 0;
  const events: unknown[] = [];
  const speech: string[] = [];
  let cancellations = 0;
  const capture: CaptureHandle = { source: 'window', frame: async () => frame, stop: () => { stopped++; }, onEnded: () => {} };
  const session = new Session({ analyze, append: (event) => { events.push(event); }, speak: (message) => { speech.push(message); }, cancelSpeech: () => { cancellations++; }, onChange: () => {}, interval_ms: 0 });
  session.setPreferences({ history: true, speech: true });
  return { session, capture, events, speech, stopped: () => stopped, cancellations: () => cancellations };
}

test('denied capture never invokes analysis', async () => {
  let calls = 0;
  const h = harness(async () => { calls++; return concern(); });
  await h.session.start(async () => { throw Error('Permission denied'); });
  assert.equal(calls, 0);
  assert.equal(h.session.state.phase, 'idle');
  assert.match(h.session.state.error ?? '', /permission/i);
});

test('pause while picker is pending stops a late stream without analyzing it', async () => {
  const selected = deferred<CaptureHandle>();
  let calls = 0;
  const h = harness(async () => { calls++; return concern(); });
  const start = h.session.start(() => selected.promise);
  h.session.pause();
  selected.resolve(h.capture);
  await start;
  assert.equal(h.stopped(), 1);
  assert.equal(calls, 0);
  assert.equal(h.session.state.phase, 'paused');
});

test('pause aborts analysis and drops late assessment, speech and history', async () => {
  const pending = deferred<Assessment>();
  let signal: AbortSignal | undefined;
  const entered = deferred<void>();
  const h = harness(async (_frame, abort) => { signal = abort; entered.resolve(); return pending.promise; });
  const start = h.session.start(async () => h.capture);
  await entered.promise;
  h.session.pause();
  pending.resolve(concern());
  await start;
  assert.equal(signal?.aborted, true);
  assert.equal(h.session.state.assessment, null);
  assert.equal(h.events.length, 0);
  assert.equal(h.speech.length, 0);
  assert.equal(h.stopped(), 1);
  assert.ok(h.cancellations() > 0);
});

test('turning history off while analysis is pending prevents persistence', async () => {
  const pending = deferred<Assessment>();
  const entered = deferred<void>();
  const h = harness(async () => { entered.resolve(); return pending.promise; });
  const start = h.session.start(async () => h.capture);
  await entered.promise;
  h.session.setPreferences({ history: false, speech: false });
  pending.resolve(concern());
  await start;
  assert.equal(h.events.length, 0);
  assert.equal(h.speech.length, 0);
  assert.equal(h.session.state.assessment?.status, 'concern');
  h.session.pause();
});

test('missing analyzer remains unavailable and never fabricates an example verdict', async () => {
  const h = harness(async () => { throw Error('offline'); });
  await h.session.start(async () => h.capture);
  assert.equal(h.session.state.assessment?.status, 'unavailable');
  assert.equal(h.speech.length, 0);
  h.session.pause();
});

test('same concern is announced once within the cooldown', async () => {
  const h = harness();
  await h.session.start(async () => h.capture);
  await h.session.analyzeNow();
  assert.equal(h.speech.length, 1);
  assert.equal(h.events.length, 1);
  h.session.pause();
});

test('source replacement invalidates the previous pending result', async () => {
  const pending = deferred<Assessment>();
  const entered = deferred<void>();
  let calls = 0;
  const h = harness(async () => {
    if (++calls === 1) { entered.resolve(); return pending.promise; }
    return analyzeText('Garden newsletter.', frame);
  });
  const first = h.session.start(async () => h.capture);
  await entered.promise;
  const second = h.session.start(async () => h.capture);
  pending.resolve(concern());
  await Promise.all([first, second]);
  assert.equal(h.session.state.assessment?.status, 'no_signal');
  assert.equal(h.speech.length, 0);
  assert.equal(h.events.length, 1);
  h.session.pause();
});

test('repeated analysis requests do not overlap', async () => {
  const pending = deferred<Assessment>();
  const entered = deferred<void>();
  let calls = 0;
  const h = harness(async () => { calls++; entered.resolve(); return pending.promise; });
  const start = h.session.start(async () => h.capture);
  await entered.promise;
  await h.session.analyzeNow();
  assert.equal(calls, 1);
  pending.resolve(concern());
  await start;
  h.session.pause();
});

test('mismatched or malformed analyzer output cannot publish a concern', async () => {
  for (const output of [{ ...concern(), frame_id: 'other-frame' }, { ...concern(), status: 'safe' }]) {
    const h = harness(async () => output as Assessment);
    await h.session.start(async () => h.capture);
    assert.equal(h.session.state.assessment?.status, 'unavailable');
    assert.equal(h.speech.length, 0);
    h.session.pause();
  }
});

test('capture-ended invalidates work and stops all capture through its port', async () => {
  const h = harness();
  let ended = () => {};
  h.capture.onEnded = (callback) => { ended = callback; };
  await h.session.start(async () => h.capture);
  ended();
  assert.equal(h.session.state.phase, 'paused');
  assert.equal(h.session.state.assessment, null);
  assert.equal(h.stopped(), 1);
});

test('history is off by default and a repository failure preserves the assessment', async () => {
  let attempts = 0;
  const session = new Session({
    analyze: async () => concern(), append: () => { attempts++; throw Error('storage denied'); },
    speak: () => {}, cancelSpeech: () => {}, onChange: () => {}, interval_ms: 0,
  });
  const capture: CaptureHandle = { source: 'window', frame: async () => frame, stop: () => {}, onEnded: () => {} };
  await session.start(async () => capture);
  assert.equal(attempts, 0);
  session.setPreferences({ history: true, speech: false });
  await session.start(async () => capture);
  assert.equal(attempts, 1);
  assert.equal(session.state.assessment?.status, 'concern');
  assert.match(session.state.error ?? '', /history/i);
  session.pause();
});

test('history revocation preserves preexisting summaries and prevents the pending append', async () => {
  const values = new Map<string, string>();
  const history = new LocalHistory({ getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); }, removeItem: (key) => { values.delete(key); } });
  history.append(toEvent(concern(), 'shown', 'previous', '2026-10-11T12:00:00Z'));
  const before = [...values.entries()];
  const pending = deferred<Assessment>();
  const entered = deferred<void>();
  const session = new Session({ analyze: async () => { entered.resolve(); return pending.promise; }, append: (event) => history.append(event), speak: () => {}, cancelSpeech: () => {}, onChange: () => {} });
  session.setPreferences({ history: true, speech: false });
  const start = session.start(async () => ({ source: 'window', frame: async () => frame, stop: () => {}, onEnded: () => {} }));
  await entered.promise;
  session.setPreferences({ history: false, speech: false });
  pending.resolve(concern());
  await start;
  assert.deepEqual([...values.entries()], before);
  assert.equal(history.list().length, 1);
  session.pause();
});

test('pause while pixels are pending prevents analyzer dispatch', async () => {
  const pixels = deferred<Frame>();
  const entered = deferred<void>();
  let calls = 0;
  const h = harness(async () => { calls++; return concern(); });
  h.capture.frame = async () => { entered.resolve(); return pixels.promise; };
  const start = h.session.start(async () => h.capture);
  await entered.promise;
  h.session.pause();
  pixels.resolve(frame);
  await start;
  assert.equal(calls, 0);
  assert.equal(h.events.length, 0);
});

test('synchronous pause from the view prevents history and speech publication', async () => {
  const events: unknown[] = [];
  const speech: string[] = [];
  const session = new Session({
    analyze: async () => concern(), append: (event) => { events.push(event); }, speak: (message) => { speech.push(message); }, cancelSpeech: () => {},
    onChange: (state) => { if (state.assessment) session.pause(); },
  });
  session.setPreferences({ history: true, speech: true });
  await session.start(async () => ({ source: 'window', frame: async () => frame, stop: () => {}, onEnded: () => {} }));
  assert.equal(session.state.phase, 'paused');
  assert.equal(events.length, 0);
  assert.equal(speech.length, 0);
});

test('no-signal outcomes never speak a concern', async () => {
  const h = harness(async () => analyzeText('Garden newsletter.', frame));
  await h.session.start(async () => h.capture);
  assert.equal(h.session.state.assessment?.status, 'no_signal');
  assert.equal(h.speech.length, 0);
  h.session.pause();
});

test('a cancelled analysis is discarded: no assessment, history or speech', async () => {
  const h = harness(async () => { throw new AnalysisCancelled(); });
  await h.session.start(async () => h.capture);
  assert.equal(h.session.state.assessment, null);
  assert.deepEqual([h.events.length, h.speech.length], [0, 0]);
});
