import assert from 'node:assert/strict';
import { request } from 'node:http';
import { test } from 'node:test';
import { HttpAnalyzer } from '../src/adapters/http-analyzer.ts';
import { AnalysisCancelled } from '../src/application/analyzer.ts';
import { RoutedAnalyzer, type CloudJudgePort, type LocalModelPort } from '../src/application/routing.ts';
import type { Grant, TextFrame } from '../src/domain/assessment.ts';
import { GrantRegistry } from '../src/server/consent.ts';
import { startServer } from '../src/server/server.ts';
import { TraceHub } from '../src/server/trace.ts';

const now = Date.now();
const session = { session_id: 'session-9', generation: 2 };
const grant = (id: string): Grant => ({
  id, ...session, source: 'native', scope: 'redacted-text', max_bytes: 2048, version: 1,
  granted_at: new Date(now - 60_000).toISOString(), expires_at: new Date(now + 3600_000).toISOString(),
});
const frame = (consent?: Grant): TextFrame => ({
  frame_id: `f-${Math.random()}`, source: 'native', ...session, text: 'Weekly garden club newsletter with tomato tips. Call the club office to reserve a seat.',
  captured_at: new Date(now).toISOString(), ...(consent ? { consent } : {}),
});

async function rig(cloudMode: 'ok' | 'hang' = 'ok', localDelay = 0) {
  const calls = { cloud: 0 };
  const local: LocalModelPort = { model: 'stub-local', available: async () => true,
    assess: (_t, signal) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve({ risk: 'medium', reasons: ['impersonation'], cue: 'Call the club office to reserve a seat' }), localDelay);
      signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); });
    }) };
  const cloud: CloudJudgePort = { model: 'stub-cloud', available: () => true, redact: (x) => x,
    measure: () => ({ bytes_out: 500, payload_sha256: 'd'.repeat(64) }),
    judge: (_r, signal) => { calls.cloud++; return cloudMode === 'hang'
      ? new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason)))
      : Promise.resolve({ ok: true, verdict: 'scam', reasons: ['impersonation'], pattern: 'other', rationale: 'r', bytes_out: 640, payload_sha256: 'e'.repeat(64), cost: { known: true, usd: 0.005 } }); } };
  const consent = new GrantRegistry();
  const trace = new TraceHub();
  const analyzer = new RoutedAnalyzer({ extractor: { extract: async (f) => ('text' in f ? f.text : '') }, local, cloud, consent, quoteExcerpts: true, onAttempt: (s) => trace.recordAttempt(s) });
  const runtime = await startServer({ port: 0, analyzer, consent, trace });
  const { token } = await (await fetch(`${runtime.origin}/api/session`)).json() as { token: string };
  const headers = { origin: runtime.origin, 'content-type': 'application/json', 'x-shepherd-token': token };
  const register = (value: unknown, extra: Record<string, string> = {}) => fetch(`${runtime.origin}/api/consent`, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(value) });
  const revoke = (id: string) => fetch(`${runtime.origin}/api/consent/${id}`, { method: 'DELETE', headers });
  const analyze = (value: unknown) => fetch(`${runtime.origin}/api/analyze`, { method: 'POST', headers, body: JSON.stringify(value) });
  return { runtime, token, calls, trace, register, revoke, analyze };
}

test('grant registration requires the token and same origin; replayed or altered ids are refused', async (t) => {
  const r = await rig();
  t.after(() => r.runtime.close());
  assert.equal((await r.register(grant('g1'), { 'x-shepherd-token': 'wrong' })).status, 403);
  assert.equal((await r.register(grant('g1'), { origin: 'https://evil.example' })).status, 403);
  assert.equal((await r.register({ ...grant('g1'), scope: 'pixels' })).status, 400);
  assert.equal((await r.register(grant('g1'))).status, 201);
  assert.equal((await r.register({ ...grant('g1'), generation: 9 })).status, 409, 'same id, different binding');
  assert.equal((await r.revoke('g1')).status, 204);
  assert.equal((await r.register(grant('g1'))).status, 409, 'a revoked id is never live again');
  assert.equal((await r.revoke('unknown')).status, 404);
});

test('only a registered, unrevoked grant reaches the cloud', async (t) => {
  const r = await rig();
  t.after(() => r.runtime.close());
  const unregistered = await (await r.analyze(frame(grant('g2')))).json() as { status: string; trace: Array<{ failure_kind?: string }> };
  assert.equal(r.calls.cloud, 0);
  assert.equal(unregistered.trace.at(-1)?.failure_kind, 'no_consent');
  await r.register(grant('g3'));
  const routed = await (await r.analyze(frame(grant('g3')))).json() as { status: string; route: string };
  assert.deepEqual([routed.status, routed.route, r.calls.cloud], ['concern', 'cloud', 1]);
  await r.revoke('g3');
  await r.analyze(frame(grant('g3')));
  assert.equal(r.calls.cloud, 1, 'replayed revoked grant makes no call');
});

test('revocation after submit, before dispatch: no body, zero cloud calls', async (t) => {
  const r = await rig('ok', 150);
  t.after(() => r.runtime.close());
  await r.register(grant('g4'));
  const pending = r.analyze(frame(grant('g4')));
  await new Promise((resolve) => setTimeout(resolve, 30));
  await r.revoke('g4');
  const response = await pending;
  assert.equal(response.status, 204);
  assert.equal(await response.text(), '');
  assert.equal(r.calls.cloud, 0);
});

test('revocation during the cloud call aborts it; the attempt is still counted', async (t) => {
  const r = await rig('hang');
  t.after(() => r.runtime.close());
  await r.register(grant('g5'));
  const pending = r.analyze(frame(grant('g5')));
  while (r.calls.cloud === 0) await new Promise((resolve) => setTimeout(resolve, 5));
  await r.revoke('g5');
  assert.equal((await pending).status, 204);
  assert.deepEqual([r.trace.counters.remote_calls, r.trace.counters.bytes_out, r.trace.counters.cost_unknown_attempts], [1, 500, 1]);
});

test('HttpAnalyzer surfaces a cancelled analysis as AnalysisCancelled', async (t) => {
  const r = await rig('hang');
  t.after(() => r.runtime.close());
  await r.register(grant('g6'));
  const pending = new HttpAnalyzer(r.runtime.origin).analyze(frame(grant('g6')), new AbortController().signal);
  while (r.calls.cloud === 0) await new Promise((resolve) => setTimeout(resolve, 5));
  await r.revoke('g6');
  await assert.rejects(pending, AnalysisCancelled);
});

test('/trace page and SSE feed: token required, full local rows, cloud payloads only as counts, cumulative counters', async (t) => {
  const r = await rig();
  t.after(() => r.runtime.close());
  const page = await fetch(`${r.runtime.origin}/trace`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /\/trace\.js/);
  assert.equal((await fetch(`${r.runtime.origin}/trace/events?token=wrong`)).status, 403);
  const received: string[] = [];
  const stream = await new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
    const req = request(`${r.runtime.origin}/trace/events?token=${r.token}`, resolve);
    req.on('error', reject);
    req.end();
  });
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => received.push(chunk));
  await r.register(grant('g7'));
  const text = 'Secret note 4417 about the garden party and private plans';
  await r.analyze({ ...frame(grant('g7')), text });
  assert.equal(r.calls.cloud, 0, 'an unanchored screen is never sent (contract)');
  // A frame whose rules evidence is screen text: evidence must not reach the feed either.
  await r.analyze({ ...frame(grant('g7')), text: 'Your account will be suspended today. Please buy gift cards now and send the codes.' });
  await new Promise((resolve) => setTimeout(resolve, 50));
  stream.destroy();
  const all = received.join('');
  assert.match(all, /event: event/);
  assert.match(all, /event: attempt/);
  // The local feed is fully introspectible (operator direction, 16:00, 563b05e): the
  // window text, evidence and message travel with each row. Cloud attempts still
  // carry only byte counts and hashes, never the excerpt that left.
  const chunks = all.split('\n\n');
  const rows = chunks.filter((chunk) => chunk.startsWith('event: event'));
  const attempts = chunks.filter((chunk) => chunk.startsWith('event: attempt'));
  assert.ok(rows.length >= 2 && attempts.length >= 1);
  for (const fragment of ['gift cards', 'suspended today']) assert.ok(rows.some((row) => row.includes(fragment)), `window text in a row: ${fragment}`);
  for (const field of ['"evidence"', '"text"', '"message"', '"page"', '"window_title"']) assert.ok(rows.every((row) => row.includes(field)), `${field} on every row`);
  for (const fragment of ['Secret note', 'garden party', 'private plans', 'gift cards', 'suspended today']) assert.ok(!attempts.some((a) => a.includes(fragment)), `no screen text in a cloud attempt: ${fragment}`);
  for (const field of ['"excerpt"', '"payload"', '"text"']) assert.ok(!attempts.some((a) => a.includes(field)), `no ${field} field in a cloud attempt`);
  assert.deepEqual([r.trace.counters.remote_calls, r.trace.counters.bytes_out, r.trace.counters.cost_known_usd], [1, 640, 0.005]);
});
