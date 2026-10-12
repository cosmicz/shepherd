import assert from 'node:assert/strict';
import { test } from 'node:test';

import { makeUnavailable, type Assessment, type Frame } from '../src/domain/assessment.ts';
import { TraceHub } from '../src/server/trace.ts';

// The trace row is fully introspectible for the local operator (16:00 direction):
// page identity and the window text travel with the event, not only counts.
function client(): { chunks: string[]; response: unknown } {
  const chunks: string[] = [];
  const response = { destroyed: false, writeHead: () => {}, on: () => {}, write: (chunk: string) => { chunks.push(chunk); return true; } };
  return { chunks, response };
}
const events = (chunks: string[]) => chunks.filter((c) => c.startsWith('event: event\n')).map((c) => JSON.parse(c.slice(c.indexOf('data: ') + 6)));

test('a trace row carries the page title, URL, app, evidence, message and window text', () => {
  const hub = new TraceHub();
  const { chunks, response } = client();
  hub.subscribe(response as never);
  const frame = { frame_id: 'f1', source: 'native', text: 'Call now to keep your account open', window_title: 'Security alert - Google Chrome', url: 'http://security-alert.localhost:8099/', app: 'Google Chrome' } as unknown as Frame;
  const assessment: Assessment = { ...makeUnavailable({ frame_id: 'f1', source: 'native' }), status: 'concern', reasons: ['support_pressure'], evidence: ['Call now'], message: 'fixed template', policy_row: '3' };
  hub.recordAssessment(assessment, frame);
  const [row] = events(chunks);
  assert.deepEqual([row.page.window_title, row.page.url, row.page.app, row.page.text, row.page.text_chars], ['Security alert - Google Chrome', 'http://security-alert.localhost:8099/', 'Google Chrome', 'Call now to keep your account open', 34]);
  assert.deepEqual([row.evidence, row.message, row.policy_row, row.status], [['Call now'], 'fixed template', '3', 'concern']);
});

test('a pixel frame row carries the OCR text recorded for it, and the first line names the page', () => {
  const hub = new TraceHub();
  const { chunks, response } = client();
  hub.subscribe(response as never);
  const ocr = 'mail.localhost:8099/mars\nMars Colony pre-IPO shares, guaranteed 40x';
  hub.recordExtract('f3', ocr);
  hub.recordAssessment(makeUnavailable({ frame_id: 'f3', source: 'window' }), { frame_id: 'f3', source: 'window', image: 'iVBORw0KGgo=' } as unknown as Frame);
  const [row] = events(chunks);
  assert.deepEqual([row.page.kind, row.page.text_chars, row.page.text.split('\n')[0]], ['png', ocr.length, 'mail.localhost:8099/mars']);
});

test('an accessibility row keeps frontmost AX provenance beside the exact text', () => {
  const hub = new TraceHub();
  const { chunks, response } = client();
  hub.subscribe(response as never);
  const frame = { frame_id: 'ax-1', source: 'accessibility', text: 'Verify account', window_title: 'Example', app: 'Safari', url: 'https://example.test/login', captured_at: '2026-10-11T16:25:00Z' } as unknown as Frame;
  hub.recordAssessment(makeUnavailable({ frame_id: 'ax-1', source: 'accessibility' }), frame);
  const [row] = events(chunks);
  assert.deepEqual(row.page.ax, { url: 'https://example.test/login', title: 'Example', app: 'Safari' });
});

test('without a frame the row still carries the assessment and page is null', () => {
  const hub = new TraceHub();
  const { chunks, response } = client();
  hub.subscribe(response as never);
  hub.recordAssessment(makeUnavailable({ frame_id: 'f2', source: 'native' }));
  const [row] = events(chunks);
  assert.equal(row.page, null);
  assert.equal(row.status, 'unavailable');
});
