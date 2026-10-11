import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { OcrAnalyzer } from '../adapters/ocr.ts';
import { AnalysisCancelled, type AnalyzerPort } from '../application/analyzer.ts';
import { makeUnavailable, parseAssessment, type Frame } from '../domain/assessment.ts';
import { companionPage, companionScript } from './companion.ts';
import { GrantError, type GrantRegistry } from './consent.ts';
import { decodeFrame, MAX_BODY_BYTES } from './frame.ts';
import { tracePage, traceScript, type TraceHub } from './trace.ts';
import type { MessagesFamilyAlert } from '../adapters/family.ts';
import { oneOf, patterns } from '../domain/assessment.ts';

// Compiled browser-safe runtime modules, served to the companion page. Same
// relative location from src/server (tsx) and dist/server (built).
const DIST = new URL('../../dist/', import.meta.url);
// Only the browser-safe runtime graph behind dist/index.js is served.
const browserModules = new Set([
  'index', 'domain/assessment', 'domain/rules', 'domain/policy', 'domain/templates', 'domain/persona',
  'application/analyzer', 'application/session', 'adapters/history', 'adapters/http-analyzer', 'adapters/http-family',
].map((name) => `/dist/${name}.js`));
const pagePolicy = "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'";

// Routed analyses can take a local model and a cloud call (16 s end to end).
const REQUEST_DEADLINE_MS = 20_000;

class HttpError extends Error { constructor(readonly status: number) { super('Request rejected'); } }

function send(response: ServerResponse, status: number, data: unknown): void {
  response.writeHead(status, {
    'Content-Type': 'application/json', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin',
    'Content-Security-Policy': "default-src 'none'; connect-src 'self'; frame-ancestors 'none'",
  });
  response.end(JSON.stringify(data));
}

function sendText(response: ServerResponse, type: string, body: string, policy: string): void {
  response.writeHead(200, {
    'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    'Cross-Origin-Resource-Policy': 'same-origin', 'Content-Security-Policy': policy,
  });
  response.end(body);
}

async function readJson(request: IncomingMessage, limit: number): Promise<unknown> {
  if (request.headers['content-type'] !== 'application/json') throw new HttpError(415);
  if (request.headers['content-encoding']) throw new HttpError(415);
  if (Number(request.headers['content-length'] ?? 0) > limit) throw new HttpError(413);
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > limit) throw new HttpError(413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new HttpError(400); }
}

async function readFrame(request: IncomingMessage): Promise<Frame> {
  const body = await readJson(request, MAX_BODY_BYTES);
  try { return decodeFrame(body).frame; }
  catch { throw new HttpError(400); }
}

function matchesToken(value: string | string[] | undefined, token: string): boolean {
  if (typeof value !== 'string') return false;
  const supplied = Buffer.from(value);
  const expected = Buffer.from(token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export async function startServer(options: { port?: number; analyzer?: AnalyzerPort; consent?: GrantRegistry; trace?: TraceHub; family?: MessagesFamilyAlert } = {}) {
  const analyzer = options.analyzer ?? new OcrAnalyzer();
  const { consent, trace, family } = options;
  const token = randomBytes(32).toString('hex');
  let origin = '';
  let busy = false;
  let currentAbort: AbortController | undefined;
  let currentGrant: string | undefined;
  // Revoking a grant aborts the analysis that carries it: no result, no side effects.
  consent?.onRevoke((id) => { if (id === currentGrant) currentAbort?.abort(); });
  const authorized = (request: IncomingMessage) => request.headers.origin === origin && matchesToken(request.headers['x-shepherd-token'], token);
  let capability: ReturnType<AnalyzerPort['capabilities']> | undefined;

  async function analyze(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!authorized(request)) throw new HttpError(403);
    if (busy) throw new HttpError(429);
    busy = true;
    const abort = new AbortController();
    currentAbort = abort;
    const disconnected = () => { if (!response.writableEnded) abort.abort(); };
    response.on('close', disconnected);
    let reading = true;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      abort.abort();
      if (reading) request.destroy();
    }, REQUEST_DEADLINE_MS);
    try {
      const frame = await readFrame(request);
      reading = false;
      currentGrant = frame.consent?.id;
      if (currentGrant && consent && !consent.live(frame, Date.now())) currentGrant = undefined;
      let assessment;
      let cancelled = false;
      try {
        assessment = parseAssessment(await analyzer.analyze(frame, abort.signal));
        if (assessment.frame_id !== frame.frame_id || assessment.source !== frame.source) throw Error('Mismatched assessment');
      } catch (error) {
        cancelled = error instanceof AnalysisCancelled && !timedOut;
        assessment = makeUnavailable(frame);
      }
      if (response.destroyed) return;
      // Cancellation ends the response without a body; the client discards it.
      if (cancelled || (abort.signal.aborted && !timedOut)) { response.writeHead(204, { 'Cache-Control': 'no-store' }); response.end(); return; }
      const result = abort.signal.aborted ? makeUnavailable(frame) : assessment;
      trace?.recordAssessment(result);
      send(response, 200, result);
    } finally {
      clearTimeout(timeout);
      response.off('close', disconnected);
      busy = false;
      currentAbort = undefined;
      currentGrant = undefined;
    }
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if (request.headers.host !== new URL(origin).host
        || (request.headers.origin !== undefined && request.headers.origin !== origin)
        || ![undefined, 'same-origin', 'none'].includes(request.headers['sec-fetch-site'] as string | undefined)) throw new HttpError(403);
      if (request.method === 'GET' && request.url === '/api/session') send(response, 200, { token });
      else if (request.method === 'GET' && request.url === '/api/capabilities') {
        capability ??= analyzer.capabilities();
        try { send(response, 200, { analyzers: await capability }); }
        finally { capability = undefined; }
      } else if (request.method === 'POST' && request.url === '/api/consent' && consent) {
        if (!authorized(request)) throw new HttpError(403);
        send(response, 201, { id: consent.register(await readJson(request, 4096)).id });
      } else if (request.method === 'DELETE' && request.url?.startsWith('/api/consent/') && consent) {
        if (!authorized(request)) throw new HttpError(403);
        consent.revoke(decodeURIComponent(request.url.slice('/api/consent/'.length)));
        response.writeHead(204, { 'Cache-Control': 'no-store' });
        response.end();
      } else if (request.method === 'POST' && request.url === '/api/family-alert') {
        // Only a closed pattern code is accepted; the runtime renders the fixed
        // family template from local configuration.
        if (!authorized(request)) throw new HttpError(403);
        const body = await readJson(request, 1024);
        let pattern;
        try { pattern = oneOf((body as Record<string, unknown>)?.pattern, patterns); } catch { throw new HttpError(400); }
        send(response, 200, { status: family ? await family.notify(pattern) : 'unavailable' });
      } else if (request.method === 'GET' && request.url === '/companion') {
        sendText(response, 'text/html; charset=utf-8', companionPage, pagePolicy);
      } else if (request.method === 'GET' && request.url === '/companion.js') {
        sendText(response, 'text/javascript; charset=utf-8', companionScript, "default-src 'none'");
      } else if (request.method === 'GET' && browserModules.has(request.url ?? '')) {
        let body: string;
        try { body = await readFile(new URL((request.url as string).slice('/dist/'.length), DIST), 'utf8'); } catch { throw new HttpError(404); }
        sendText(response, 'text/javascript; charset=utf-8', body, "default-src 'none'");
      } else if (request.method === 'GET' && request.url === '/trace' && trace) {
        sendText(response, 'text/html; charset=utf-8', tracePage, "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'");
      } else if (request.method === 'GET' && request.url === '/trace.js' && trace) {
        sendText(response, 'text/javascript; charset=utf-8', traceScript, "default-src 'none'");
      } else if (request.method === 'GET' && request.url?.startsWith('/trace/events?') && trace) {
        const supplied = new URL(request.url, origin).searchParams.get('token') ?? undefined;
        if (!matchesToken(supplied, token)) throw new HttpError(403);
        trace.subscribe(response);
      } else if (request.method === 'GET' && request.url === '/') {
        send(response, 200, { service: 'Shepherd local runtime', companion: 'not implemented', route: 'local' });
      } else if (request.method === 'POST' && request.url === '/api/analyze') await analyze(request, response);
      else throw new HttpError(404);
    } catch (error) {
      const status = error instanceof HttpError || error instanceof GrantError ? error.status : 503;
      if (!response.destroyed && !response.headersSent) send(response, status, { error: 'Request unavailable or rejected' });
    }
  }
  const server = createServer({ requestTimeout: 12_000, headersTimeout: 5000, maxHeaderSize: 8192 }, (request, response) => { void handle(request, response); });
  server.maxConnections = 16;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 4317, '127.0.0.1', () => resolve());
  });
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    origin,
    close: async () => {
      currentAbort?.abort();
      const closed = new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      server.closeAllConnections();
      await closed;
    },
  };
}
