// Local trace feed (contract, widened 16:00 on the operator's direction): every
// assessment as a full row (page title, URL, app, status, reasons, evidence,
// message and the window text the tiers read), every cloud attempt (including
// aborted or failed ones) and cumulative counters. Loopback only, behind the
// session token; nothing here leaves the machine. Cloud payloads stay as
// byte counts and hashes in the route steps.
import type { ServerResponse } from 'node:http';

import type { Assessment, Frame, RouteStep } from '../domain/assessment.ts';
import type { PipelineRecord } from '../domain/pipeline.ts';
import type { ThreatTag } from '../adapters/threat-trace.ts';

// Window text per row is capped so one frame cannot stall the event stream.
const TEXT_LIMIT = 16_384;
const capped = (text: string) => (text.length > TEXT_LIMIT ? `${text.slice(0, TEXT_LIMIT)} …[cut at ${TEXT_LIMIT}]` : text);
export function pageRecord(frame: Frame | undefined, extracted?: string): Record<string, unknown> | null {
  if (!frame) return null;
  // Pixel frames: the OCR text the rules and the local model read, when recorded.
  if (!('text' in frame)) return { kind: 'png', image_bytes: frame.image.length, text: extracted === undefined ? null : capped(extracted), text_chars: extracted?.length ?? 0 };
  return {
    kind: 'text', app: frame.app ?? null, bundle_id: frame.bundle_id ?? null, window_title: frame.window_title ?? null,
    url: frame.url ?? null, url_status: frame.url_status ?? null, captured_at: frame.captured_at ?? null, scope: frame.scope ?? null,
    truncated: frame.truncated === true, text_chars: frame.text.length, display_chars: frame.display_text?.length ?? 0,
    text: capped(frame.text),
    // Exact local Accessibility metadata stays beside the AX text for the
    // operator's trace; it is never added to a cloud request or assessment.
    ...(frame.source === 'accessibility' ? { ax: { url: frame.url ?? null, title: frame.window_title ?? null, app: frame.app ?? null } } : {}),
  };
}

export interface TraceCounters { cost_known_usd: number; cost_unknown_attempts: number; bytes_out: number; remote_calls: number; cached_hits: number; replayed: number }

export class TraceHub {
  private readonly clients = new Set<ServerResponse>();
  // OCR text per pixel frame, held until its assessment is recorded (bounded).
  private readonly extracted = new Map<string, string>();
  private readonly explanations = new Map<string, unknown[]>();
  constructor(private readonly options: { tagger?: (frame: Frame | undefined) => ThreatTag[] } = {}) {}
  readonly counters: TraceCounters = { cost_known_usd: 0, cost_unknown_attempts: 0, bytes_out: 0, remote_calls: 0, cached_hits: 0, replayed: 0 };

  subscribe(response: ServerResponse): void {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive',
      'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin',
    });
    this.clients.add(response);
    response.on('close', () => this.clients.delete(response));
    this.send(response, 'counters', this.counters);
  }

  recordExtract(frame_id: string, text: string): void {
    this.extracted.set(frame_id, text);
    while (this.extracted.size > 64) this.extracted.delete(this.extracted.keys().next().value as string);
  }

  // Bounded explanations returned by the models, not private chain-of-thought.
  // Raw pipeline inputs remain in the opt-in inspector, never copied here.
  recordPipelineSummary(record: PipelineRecord): void {
    this.explanations.set(record.frame_id, record.tiers.flatMap((tier): unknown[] => {
      if (tier.tier === 'local-model') return [{ tier: tier.tier, model: tier.model, risk: tier.output.parsed?.risk,
        reasons: tier.output.parsed?.reasons, quoted_cue: tier.output.parsed?.cue.slice(0, 160), failure: tier.output.failure_kind }];
      if (tier.tier === 'cloud') return [{ tier: tier.tier, model: tier.model, verdict: tier.output.verdict,
        reasons: tier.output.reasons, model_authored_rationale: tier.output.rationale?.model_text.slice(0, 512), failure: tier.output.failure_kind }];
      return [];
    }));
    while (this.explanations.size > 8) this.explanations.delete(this.explanations.keys().next().value!);
  }

  // Every cloud dispatch reaches here exactly once, whether or not it returned.
  recordAttempt(step: RouteStep): void {
    if (step.tier !== 'cloud' || step.remote_calls === 0) return;
    this.counters.remote_calls += step.remote_calls;
    this.counters.bytes_out += step.bytes_out;
    if (step.cost.known) this.counters.cost_known_usd = Math.round((this.counters.cost_known_usd + step.cost.usd) * 1e6) / 1e6;
    else this.counters.cost_unknown_attempts++;
    this.broadcast('attempt', { at: new Date().toISOString(), step });
  }

  recordAssessment(assessment: Assessment, frame?: Frame): void {
    let tags: ThreatTag[] = [];
    try { tags = this.options.tagger?.(frame) ?? []; } catch { /* optional offline annotation */ }
    const model_explanations = this.explanations.get(assessment.frame_id) ?? [];
    this.explanations.delete(assessment.frame_id);
    // Replays (demo safety net) are counted apart and never as cache hits.
    this.counters.cached_hits += assessment.trace.filter((step) => step.cached && !step.replayed).length;
    this.counters.replayed += assessment.trace.filter((step) => step.replayed).length;
    this.broadcast('event', {
      at: new Date().toISOString(), frame_id: assessment.frame_id, source: assessment.source, status: assessment.status,
      reasons: assessment.reasons, route: assessment.route, policy_row: assessment.policy_row ?? null,
      pattern: assessment.pattern ?? null, verdict: assessment.verdict ?? null, duration_ms: assessment.duration_ms, trace: assessment.trace,
      evidence: assessment.evidence, message: assessment.message, analyzer: assessment.analyzer, evidence_regions: assessment.evidence_regions ?? 0,
      page: pageRecord(frame, this.extracted.get(assessment.frame_id)), tags, model_explanations,
    });
    this.extracted.delete(assessment.frame_id);
  }

  private broadcast(kind: string, data: unknown): void {
    for (const client of this.clients) { this.send(client, kind, data); this.send(client, 'counters', this.counters); }
  }

  private send(client: ServerResponse, kind: string, data: unknown): void {
    if (!client.destroyed) client.write(`event: ${kind}\ndata: ${JSON.stringify(data)}\n\n`);
  }
}

export const tracePage = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Shepherd trace</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
:root{color-scheme:light dark;--bg:#f4f6fa;--card:#ffffff;--ink:#14233d;--soft:#5b677d;--line:#dde3ec;
--rules:#2f6f4f;--local:#2b5fa8;--cloud:#8a4fbf;--skip:#8a93a3;--fail:#b42318;--concern:#b42318;--warn:#8a6d00;--capture:#c9a227;--mono:ui-monospace,"SF Mono",Menlo,monospace}
@media (prefers-color-scheme:dark){:root{--bg:#0f1520;--card:#182131;--ink:#e6ecf5;--soft:#9aa7bb;--line:#2a3547;
--rules:#5fc08f;--local:#6fa3ef;--cloud:#c194ee;--skip:#7d8899;--fail:#ff7b72;--concern:#ff7b72;--warn:#e5c45a;--capture:#e5c45a}}
*{box-sizing:border-box}
body{font:15px/1.5 -apple-system,"Helvetica Neue",Arial,sans-serif;margin:0;padding:28px 28px 48px;color:var(--ink);background:var(--bg)}
h1{font-size:24px;margin:0 0 4px;letter-spacing:-0.01em}
.muted{color:var(--soft)}
.counters{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px;margin:18px 0 10px}
.counters div{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px 18px;color:var(--soft)}
.counters b{display:block;font:600 36px/1.15 var(--mono);color:var(--ink);margin-bottom:4px;font-variant-numeric:tabular-nums}
.secondary{display:flex;flex-wrap:wrap;gap:10px 24px;margin:0 0 22px;color:var(--soft);font-size:14px}
.secondary b{font:600 15px var(--mono);color:var(--ink);margin-right:6px}
table{border-collapse:separate;border-spacing:0;width:100%;background:var(--card);border:1px solid var(--line);border-radius:14px;overflow:hidden}
td,th{border-bottom:1px solid var(--line);padding:9px 12px;text-align:left;vertical-align:top}
th{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--soft);font-weight:600}
tr:last-child td{border-bottom:0}
td:first-child,td:nth-child(5){font-family:var(--mono);font-variant-numeric:tabular-nums;white-space:nowrap}
td:nth-child(2){max-width:34ch;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
tr.row{cursor:pointer}tr.row:hover td{background:color-mix(in srgb,var(--line) 40%,transparent)}
tr.detail td{background:color-mix(in srgb,var(--line) 25%,transparent);font-family:var(--mono);font-size:12px}
tr.detail pre{margin:0;white-space:pre-wrap;word-break:break-word;max-height:60vh;overflow:auto}
td:last-child{font-family:var(--mono);font-size:13px}
.concern{color:var(--concern);font-weight:700}
.step{display:inline-block;padding:1px 8px;margin:1px 0;border-radius:6px;border-left:4px solid var(--skip);background:color-mix(in srgb,var(--skip) 12%,transparent)}
.step.rules{border-color:var(--rules);background:color-mix(in srgb,var(--rules) 12%,transparent)}
.step.local-model{border-color:var(--local);background:color-mix(in srgb,var(--local) 12%,transparent)}
.step.cloud{border-color:var(--cloud);background:color-mix(in srgb,var(--cloud) 14%,transparent)}
.step.skipped{opacity:.7}.step.failed{border-color:var(--fail)}
.listed{display:block;color:var(--concern);font-size:12px;font-weight:600;white-space:normal}
.arrow{color:var(--soft);padding:0 4px}
.inspector{display:flex;align-items:center;gap:12px;margin:0 0 14px;font-size:14px;color:var(--soft)}
.inspector button{font:inherit;font-weight:600;min-height:36px;padding:6px 14px;border-radius:10px;border:2px solid var(--local);background:transparent;color:var(--ink);cursor:pointer}
.inspector[data-on="true"] button{background:var(--local);color:#fff}
.journal{font-family:-apple-system,"Helvetica Neue",Arial,sans-serif;font-size:14px;margin-top:10px;border-top:1px solid var(--line);padding-top:6px}
.journal h3{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--soft);margin:12px 0 4px}
.journal img{max-width:100%;max-height:420px;border:1px solid var(--line);border-radius:8px}
.journal .model-text{border-left:3px solid var(--cloud);padding-left:8px}
@media (max-width:760px){.counters{grid-template-columns:repeat(2,minmax(0,1fr))}body{padding:18px 16px 40px}}
.legend{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:10px;margin:0 0 18px}
.legend div{background:var(--card);border:1px solid var(--line);border-top:4px solid var(--skip);border-radius:12px;padding:10px 12px;font-size:13px;color:var(--soft);line-height:1.4}
.legend b{display:block;color:var(--ink);font-size:14px;margin-bottom:2px}
.legend .capture,.stage.capture{border-top-color:var(--capture)}.legend .rules,.stage.rules{border-top-color:var(--rules)}.legend .local-model,.stage.local-model{border-top-color:var(--local)}.legend .cloud,.stage.cloud{border-top-color:var(--cloud)}.legend .outcome,.stage.outcome{border-top-color:var(--concern)}
.pipe{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:10px;padding:8px 0 4px}
.stage{background:var(--card);border:1px solid var(--line);border-top:4px solid var(--skip);border-radius:12px;padding:10px 12px;font:13px/1.45 -apple-system,"Helvetica Neue",Arial,sans-serif;color:var(--soft);min-width:0;overflow-wrap:anywhere}
.stage h4{margin:0 0 6px;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--soft)}
.stage .big{font-size:16px;font-weight:700;color:var(--ink);margin-bottom:4px}
.stage.off{opacity:.5}
.stage q{display:block;font-family:var(--mono);font-size:12px;color:var(--ink);margin:4px 0;padding:2px 8px;border-left:3px solid var(--line);quotes:none;white-space:pre-wrap}
.bar{height:8px;border-radius:4px;background:color-mix(in srgb,var(--cloud) 20%,transparent);margin:2px 0 6px;overflow:hidden}.bar i{display:block;height:100%;background:var(--cloud)}
.badge{display:inline-block;padding:2px 10px;border-radius:999px;font-weight:700;font-size:13px;white-space:nowrap}
.badge.concern{background:color-mix(in srgb,var(--concern) 15%,transparent);color:var(--concern)}
.badge.inconclusive{background:color-mix(in srgb,var(--warn) 18%,transparent);color:var(--warn)}
.badge.no_signal{background:color-mix(in srgb,var(--rules) 15%,transparent);color:var(--rules)}
.badge.unavailable{background:color-mix(in srgb,var(--skip) 18%,transparent);color:var(--skip)}
.raw{margin-top:6px}.raw summary{cursor:pointer;color:var(--soft);font-size:12px}
@media (max-width:1100px){.pipe,.legend{grid-template-columns:repeat(2,minmax(0,1fr))}}
</style></head>
<body><h1>Shepherd routing trace</h1><p class="muted">Local only (loopback, session token). Click a row to see the frame move through the pipeline: what each stage saw, what it returned, and what it cost.</p>
<div class="legend"><div class="capture"><b>1 · Capture</b>A window, tab or the whole display on this Mac. OCR or accessibility text; an offline list tags URLs it recognises.</div><div class="rules"><b>2 · Rules</b>Deterministic patterns mark evidence spans. They annotate and never decide.</div><div class="local-model"><b>3 · Local model</b>Qwen3 8B on the device reads every changed frame. On its own it can only caution.</div><div class="cloud"><b>4 · Cloud judge</b>Jev/Clef or Claude, only when the local model is unsure and a grant allows a redacted excerpt.</div><div class="outcome"><b>5 · Outcome</b>A concern is spoken and texted from fixed templates. Inconclusive is shown. No signal stays silent.</div></div>
<div class="counters"><div><b id="remote_calls">0</b>cloud calls</div><div><b id="bytes_out">0</b>bytes to cloud</div>
<div><b id="cost_known_usd">$0.000000</b>known cost</div><div><b id="cached_hits">0</b>cache hits</div></div>
<div class="secondary"><span><b id="cost_unknown_attempts">0</b>calls with unknown cost</span><span><b id="replayed">0</b>replayed (rehearsal, not live)</span></div>
<div class="inspector" id="inspector" data-on="false"><button id="inspect" type="button">Inspector (this Mac only)</button><span id="inspect-note">Off: expanded rows show the live record only.</span></div>
<table><thead><tr><th>Time</th><th>Page</th><th>Status</th><th>Route</th><th>Row</th><th>Steps</th></tr></thead><tbody id="events"></tbody></table>
<script src="/trace.js"></script></body></html>`;

export const traceScript = `(async () => {
  const { token } = await (await fetch('/api/session')).json();
  const source = new EventSource('/trace/events?token=' + encodeURIComponent(token));
  const text = (id, value) => { document.getElementById(id).textContent = value; };
  source.addEventListener('counters', (e) => {
    const c = JSON.parse(e.data);
    text('remote_calls', c.remote_calls); text('bytes_out', c.bytes_out); text('cost_known_usd', '$' + c.cost_known_usd.toFixed(6));
    text('cost_unknown_attempts', c.cost_unknown_attempts); text('cached_hits', c.cached_hits); text('replayed', c.replayed);
  });
  const statusLabel = (v) => v.status === 'concern' ? 'Concern' : v.status === 'inconclusive' ? (v.policy_row === '12d' ? 'Caution (local model alone)' : 'Not sure') : v.status === 'no_signal' ? 'No concern found' : 'Unavailable';
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
  const line = (box, text) => box.append(el('div', '', text));
  const stage = (cls, title, off) => { const box = el('div', 'stage ' + cls + (off ? ' off' : '')); box.append(el('h4', '', title)); return box; };
  const money = (c) => c && c.known ? '$' + c.usd.toFixed(5) : 'cost unknown';
  function pipeline(v) {
    const strip = el('div', 'pipe');
    const page = v.page || {}; const ax = page.ax || {};
    const steps = {}; for (const s of v.trace || []) steps[s.tier] = s;
    const notes = {}; for (const x of v.explanations || []) notes[x.tier] = x;
    // 1 capture
    const cap = stage('capture', '1 · Capture');
    cap.append(el('div', 'big', ax.title || page.window_title || (page.text ? page.text.split('\\n').map((l) => l.trim()).find(Boolean) : '') || v.source));
    line(cap, 'Source: ' + v.source + (page.kind === 'png' ? ' (image, ' + Math.round((page.image_bytes || 0) / 1024) + ' KB)' : page.kind === 'text' ? ' (text)' : ''));
    if (ax.url || page.url) line(cap, 'URL: ' + (ax.url || page.url)); if (ax.app || page.app) line(cap, 'App: ' + (ax.app || page.app));
    line(cap, (page.text_chars || 0) + ' characters read' + (page.truncated ? ' (truncated)' : ''));
    for (const tag of v.tags || []) line(cap, 'Listed: ' + tag.lists.join(', ') + ' · ' + (tag.source === 'ocr-mention' ? 'OCR mention, unverified' : 'URL metadata'));
    strip.append(cap);
    // 2 rules
    const r = steps.rules; const ru = stage('rules', '2 · Rules', !r);
    ru.append(el('div', 'big', !r ? 'not run' : (v.evidence || []).length ? (v.evidence.length + ' evidence span' + (v.evidence.length > 1 ? 's' : '')) : r.outcome === 'no_signal' ? 'no pattern matched' : r.outcome));
    for (const span of v.evidence || []) ru.append(el('q', '', span));
    if (r) line(ru, r.duration_ms + ' ms · annotates only');
    strip.append(ru);
    // 3 local model
    const l = steps['local-model']; const ln = notes['local-model'] || {}; const lo = stage('local-model', '3 · Local model', !l);
    lo.append(el('div', 'big', !l ? 'not consulted' : l.outcome === 'failed' ? 'failed: ' + (l.failure_kind || '') : ln.risk ? 'risk ' + ln.risk : l.outcome));
    if (l) line(lo, (ln.model || (v.analyzer && v.analyzer.kind === 'model' && v.route === 'local-model' ? v.analyzer.model : 'on-device model')) + ' · ' + l.duration_ms + ' ms' + (l.cached ? ' · cached' : ''));
    if (ln.reasons && ln.reasons.length) line(lo, 'Reasons: ' + ln.reasons.join(', '));
    if (ln.quoted_cue) lo.append(el('q', '', ln.quoted_cue));
    strip.append(lo);
    // 4 cloud judge
    const c = steps.cloud; const cn = notes.cloud || {}; const cl = stage('cloud', '4 · Cloud judge', !c || c.outcome === 'skipped');
    cl.append(el('div', 'big', !c ? 'not needed' : c.outcome === 'skipped' ? 'skipped: ' + ({ no_consent: 'no grant', no_anchor: 'nothing to send', budget: 'budget', unavailable: 'no provider' }[c.failure_kind] || c.failure_kind || '') : c.outcome === 'failed' ? 'failed: ' + (c.failure_kind || '') : (v.verdict ? 'verdict ' + v.verdict : c.outcome)));
    if (c && c.remote_calls) line(cl, (cn.model || (v.analyzer && v.route === 'cloud' ? v.analyzer.model : 'cloud model')) + ' · ' + c.bytes_out + ' B out · ' + money(c.cost) + ' · ' + c.duration_ms + ' ms' + (c.replayed ? ' · REPLAYED' : c.cached ? ' · cached' : ''));
    if (v.pattern) line(cl, 'Pattern: ' + v.pattern);
    if (c && c.judge_meta && c.judge_meta.classes) for (const k of ['benign', 'suspicious', 'unknown']) { const pr = c.judge_meta.classes[k]; if (pr === undefined) continue; line(cl, k + ' ' + Math.round(pr * 100) + '%'); const bar = el('div', 'bar'); const fill = el('i'); fill.style.width = Math.round(pr * 100) + '%'; bar.append(fill); cl.append(bar); }
    if (cn.model_authored_rationale) cl.append(el('q', '', cn.model_authored_rationale));
    strip.append(cl);
    // 5 outcome
    const out = stage('outcome', '5 · Outcome');
    const b = el('span', 'badge ' + v.status, statusLabel(v)); out.append(b);
    line(out, 'Row ' + (v.policy_row || '?') + ' · decided by ' + (v.route === 'cloud' ? 'the cloud judge' : v.route === 'local-model' ? 'the local model' : 'the rules tier') + ' · ' + v.duration_ms + ' ms');
    if (v.reasons && v.reasons.length) line(out, 'Reasons: ' + v.reasons.join(', '));
    if (v.message) out.append(el('q', '', v.message));
    line(out, v.status === 'concern' ? (v.policy_row === '12d' ? 'Shown and spoken; family not alerted' : 'Spoken and texted from fixed templates') : v.status === 'inconclusive' ? 'Shown, not spoken' : v.status === 'no_signal' ? 'Nothing said' : 'Local analyzer unavailable');
    strip.append(out);
    return strip;
  }
  source.addEventListener('event', (e) => {
    const v = JSON.parse(e.data);
    const row = document.createElement('tr');
    row.className = 'row';
    const firstLine = v.page && v.page.text ? (v.page.text.split('\\n').map((l) => l.trim()).find(Boolean) || '') : '';
    const page = v.page && v.page.kind === 'text' ? (v.page.window_title || v.page.url || v.page.app || v.source) : (firstLine.slice(0, 48) || v.source);
    const cells = [new Date(v.at).toLocaleTimeString(), page, '', v.route, v.policy_row || ''];
    for (const value of cells) { const cell = document.createElement('td'); cell.textContent = value; row.append(cell); }
    const badge = document.createElement('span'); badge.className = 'badge ' + v.status; badge.textContent = statusLabel(v); row.children[2].append(badge);
    for (const tag of (v.tags || [])) {
      const chip = document.createElement('span'); chip.className = 'listed';
      chip.textContent = 'Listed: ' + tag.lists.join(', ') + ' · ' + (tag.source === 'ocr-mention' ? 'OCR mention (unverified URL)' : 'URL metadata') + (tag.freshness === 'stale' ? ' · stale feed' : '');
      row.children[1].append(chip);
    }
    // Route strip: one chip per step, coloured by tier (same text as before).
    const steps = document.createElement('td');
    v.trace.forEach((s, index) => {
      if (index) { const arrow = document.createElement('span'); arrow.className = 'arrow'; arrow.textContent = '→'; steps.append(arrow); }
      const chip = document.createElement('span');
      chip.className = 'step ' + s.tier + (s.outcome === 'skipped' || s.outcome === 'failed' ? ' ' + s.outcome : '');
      chip.textContent = s.tier + ':' + s.outcome + (s.failure_kind ? '/' + s.failure_kind : '') + (s.remote_calls ? ' (' + s.bytes_out + ' B)' : '') + (s.replayed ? ' REPLAYED' : s.cached ? ' cached' : '');
      steps.append(chip);
    });
    row.append(steps);
    // Full record on click (textContent only): the whole event, route steps included.
    const detail = document.createElement('tr'); detail.className = 'detail'; detail.hidden = true;
    const cell = document.createElement('td'); cell.colSpan = 6;
    cell.append(pipeline(v));
    const raw = document.createElement('details'); raw.className = 'raw'; const sum = document.createElement('summary'); sum.textContent = 'Raw record'; raw.append(sum);
    const pre = document.createElement('pre'); pre.textContent = JSON.stringify(v, null, 2); raw.append(pre); cell.append(raw); detail.append(cell);
    row.addEventListener('click', () => { detail.hidden = !detail.hidden; });
    // Inspector: the first expansion while it is on also loads the journal record.
    row.dataset.frame = v.frame_id;
    row.addEventListener('click', () => { if (inspecting && !detail.hidden && !cell.querySelector('.journal')) loadJournal(v.frame_id, cell); });
    const events = document.getElementById('events');
    events.prepend(detail); events.prepend(row);
  });

  // Inspector (u6w): off on every load; local-only. It adds the heavy data the
  // live feed does not carry (images, recognised speech, each tier's inputs and
  // outputs) from this Mac's journal, by frame id. textContent only.
  let inspecting = false;
  document.getElementById('inspect').addEventListener('click', () => {
    if (!inspecting && !confirm("Show captured images, recognised speech and model inputs from this Mac's journal on this page? Nothing is sent anywhere.")) return;
    inspecting = !inspecting;
    document.getElementById('inspector').dataset.on = String(inspecting);
    text('inspect-note', inspecting ? 'On: expanding a row also loads its local journal record. Turn it off before sharing your screen.' : 'Off: expanded rows show the live record only.');
    if (!inspecting) for (const journal of document.querySelectorAll('#events .journal')) journal.remove();
  });
  const add = (parent, tag, content, className) => { const el = document.createElement(tag); if (content !== undefined) el.textContent = content; if (className) el.className = className; parent.append(el); return el; };
  async function loadJournal(frameId, cell) {
    const box = add(cell, 'div', undefined, 'journal');
    add(box, 'h3', 'Local journal');
    let entry;
    try {
      const response = await fetch('/api/journal/observation/' + encodeURIComponent(frameId), { headers: { 'X-Shepherd-Token': token } });
      if (response.status === 404) { add(box, 'p', 'Not recorded: the journal was off for this frame.', 'muted'); return; }
      if (!response.ok) throw Error('journal');
      entry = await response.json();
    } catch { add(box, 'p', 'The local journal could not be read.', 'muted'); return; }
    if (!inspecting) { box.remove(); return; }
    const record = entry.record || {};
    if (entry.png) { add(box, 'h3', 'Captured image'); const img = add(box, 'img'); img.src = entry.png; img.alt = 'Captured frame from the local journal'; }
    if (entry.ocr_text !== undefined) { add(box, 'h3', record.source === 'voice' ? 'Recognised speech' : 'Recognised text'); add(box, 'pre', entry.ocr_text); }
    for (const annotation of entry.annotations || []) {
      if (annotation.kind !== 'pipeline') { add(box, 'h3', 'Annotation: ' + annotation.kind); add(box, 'pre', JSON.stringify(annotation.value, null, 1)); continue; }
      const pipeline = annotation.value;
      for (const tier of pipeline.tiers || []) {
        add(box, 'h3', tier.tier + ' · ' + (tier.model || tier.analyzer_id) + ' · ' + tier.duration_ms + ' ms' + (tier.cached ? ' · cached' : ''));
        const output = Object.assign({}, tier.output);
        const rationale = output.rationale;
        delete output.rationale;
        add(box, 'pre', 'input ' + JSON.stringify(tier.input, null, 1) + '\\noutput ' + JSON.stringify(output, null, 1));
        if (rationale) add(box, 'pre', 'Model text (never spoken or sent): ' + rationale.model_text, 'model-text');
      }
      add(box, 'h3', 'Decision');
      add(box, 'pre', JSON.stringify({ gate: pipeline.gate, decision: pipeline.decision }, null, 1));
    }
  }
})();`;
