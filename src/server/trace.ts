// Judge-facing trace feed: content-free event summaries with their
// route steps, every cloud attempt (including aborted or failed ones), and
// cumulative counters. Never carries screen text, evidence, URLs or payloads.
import type { ServerResponse } from 'node:http';

import type { Assessment, RouteStep } from '../domain/assessment.ts';

export interface TraceCounters { cost_known_usd: number; cost_unknown_attempts: number; bytes_out: number; remote_calls: number; cached_hits: number }

export class TraceHub {
  private readonly clients = new Set<ServerResponse>();
  readonly counters: TraceCounters = { cost_known_usd: 0, cost_unknown_attempts: 0, bytes_out: 0, remote_calls: 0, cached_hits: 0 };

  subscribe(response: ServerResponse): void {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive',
      'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin',
    });
    this.clients.add(response);
    response.on('close', () => this.clients.delete(response));
    this.send(response, 'counters', this.counters);
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

  recordAssessment(assessment: Assessment): void {
    this.counters.cached_hits += assessment.trace.filter((step) => step.cached).length;
    this.broadcast('event', {
      at: new Date().toISOString(), frame_id: assessment.frame_id, source: assessment.source, status: assessment.status,
      reasons: assessment.reasons, route: assessment.route, policy_row: assessment.policy_row ?? null,
      pattern: assessment.pattern ?? null, verdict: assessment.verdict ?? null, duration_ms: assessment.duration_ms, trace: assessment.trace,
    });
  }

  private broadcast(kind: string, data: unknown): void {
    for (const client of this.clients) { this.send(client, kind, data); this.send(client, 'counters', this.counters); }
  }

  private send(client: ServerResponse, kind: string, data: unknown): void {
    if (!client.destroyed) client.write(`event: ${kind}\ndata: ${JSON.stringify(data)}\n\n`);
  }
}

export const tracePage = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Shepherd trace</title>
<style>body{font:15px -apple-system,Helvetica,Arial,sans-serif;margin:24px;color:#111}h1{font-size:22px}
.counters{display:flex;gap:24px;margin:12px 0 20px}.counters div{background:#f2f4f7;padding:10px 14px;border-radius:8px}
.counters b{display:block;font-size:24px}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #ddd;padding:6px 8px;text-align:left;vertical-align:top}
.concern{color:#b42318;font-weight:600}.muted{color:#667085}</style></head>
<body><h1>Shepherd routing trace</h1><p class="muted">Counts and route steps only. No screen text, evidence or payloads appear here.</p>
<div class="counters"><div><b id="remote_calls">0</b>cloud calls</div><div><b id="bytes_out">0</b>bytes to cloud</div>
<div><b id="cost_known_usd">$0.000000</b>known cost</div><div><b id="cost_unknown_attempts">0</b>calls with unknown cost</div><div><b id="cached_hits">0</b>cache hits</div></div>
<table><thead><tr><th>Time</th><th>Status</th><th>Route</th><th>Row</th><th>Steps</th></tr></thead><tbody id="events"></tbody></table>
<script src="/trace.js"></script></body></html>`;

export const traceScript = `(async () => {
  const { token } = await (await fetch('/api/session')).json();
  const source = new EventSource('/trace/events?token=' + encodeURIComponent(token));
  const text = (id, value) => { document.getElementById(id).textContent = value; };
  source.addEventListener('counters', (e) => {
    const c = JSON.parse(e.data);
    text('remote_calls', c.remote_calls); text('bytes_out', c.bytes_out); text('cost_known_usd', '$' + c.cost_known_usd.toFixed(6));
    text('cost_unknown_attempts', c.cost_unknown_attempts); text('cached_hits', c.cached_hits);
  });
  source.addEventListener('event', (e) => {
    const v = JSON.parse(e.data);
    const row = document.createElement('tr');
    const cells = [new Date(v.at).toLocaleTimeString(), v.status, v.route, v.policy_row || '',
      v.trace.map((s) => s.tier + ':' + s.outcome + (s.failure_kind ? '/' + s.failure_kind : '') + (s.remote_calls ? ' (' + s.bytes_out + ' B)' : '') + (s.cached ? ' cached' : '')).join(' → ')];
    for (const value of cells) { const cell = document.createElement('td'); cell.textContent = value; row.append(cell); }
    if (v.status === 'concern') row.children[1].className = 'concern';
    document.getElementById('events').prepend(row);
  });
})();`;
