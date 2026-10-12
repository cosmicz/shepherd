// Loopback-only static server for the Shepherd demo fixtures.
//
// Pages are routed by Host so the live browser's address bar shows a readable
// name (mail.localhost:8099, ...). Browsers resolve *.localhost to loopback, so
// no hosts-file edit is needed. Unknown Host headers are rejected to keep the
// server from answering rebound DNS names.
//
//   node demo/serve.mjs [--port 8099]
//
// Routes:
//   http://<page host>:<port>/        the page, as shown in the live demo
//   http://127.0.0.1:<port>/          index of pages
//   http://127.0.0.1:<port>/pages/ID  a page by id
//   http://127.0.0.1:<port>/frame/ID  the page inside a simulated address bar (screenshot fixtures)
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(await readFile(join(root, 'fixtures.json'), 'utf8'));
const supplemental = JSON.parse(await readFile(join(root, 'supplemental.json'), 'utf8'));
const pages = [...manifest.pages, ...supplemental.pages];
const portArgument = process.argv.indexOf('--port');
const port = portArgument > 0 ? Number(process.argv[portArgument + 1]) : manifest.port;
const byId = new Map(pages.map((page) => [page.id, page]));
const byHost = new Map(pages.map((page) => [page.host, page]));
const loopbackHosts = new Set(['127.0.0.1', 'localhost']);
const policy = "default-src 'none'; style-src 'unsafe-inline'; frame-src 'self'; img-src 'self'; form-action 'none'; base-uri 'none'";
const assets = new Set(['bank-notice.png', 'support-notice.png', 'local-weather.png']);

// The address bar in screenshot frames always shows the manifest port, so
// fixtures stay byte-stable when capture listens elsewhere.
export function displayUrl(page, shownPort = manifest.port) { return `${page.host}:${shownPort}`; }

const escape = (text) => text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function frame(page) {
  // A minimal browser toolbar so OCR of the fixture sees the address bar, as it
  // would when the person shares the whole browser window.
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escape(page.id)}</title><style>
  html,body{margin:0;height:100%;font:15px -apple-system,"Helvetica Neue",Arial,sans-serif}
  .bar{height:44px;display:flex;align-items:center;gap:14px;padding:0 14px;background:#dee1e6;border-bottom:1px solid #c4c7cc;box-sizing:border-box}
  .dots span{display:inline-block;width:12px;height:12px;border-radius:50%;margin-right:6px;background:#c4c7cc}
  .url{flex:1;background:#fff;border-radius:16px;padding:6px 14px;color:#202124}
  iframe{display:block;border:0;width:100%;height:calc(100% - 44px)}
  </style></head><body><div class="bar"><div class="dots"><span></span><span></span><span></span></div>
  <div class="url">${escape(displayUrl(page))}</div></div>
  <iframe src="/pages/${encodeURIComponent(page.id)}" title="${escape(page.id)}"></iframe></body></html>`;
}

function index() {
  const rows = pages.map((page) => `<li><a href="http://${escape(displayUrl(page, port))}/">${escape(page.host)}</a>
    — ${escape(page.kind)} — <a href="/pages/${page.id}">${escape(page.id)}</a> · <a href="/frame/${page.id}">framed</a></li>`).join('\n');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Shepherd demo pages</title></head>
  <body><h1>Shepherd demo pages</h1><p>Local fixtures. Nothing here is real.</p><ul>${rows}</ul></body></html>`;
}

async function page(page) { return readFile(join(root, 'pages', `${page.id}.html`), 'utf8'); }

export { port };
export const server = createServer(async (request, response) => {
  const send = (status, body) => {
    response.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': policy, 'cache-control': 'no-store' });
    response.end(body);
  };
  try {
    if (request.method !== 'GET') return send(405, 'Method not allowed');
    const host = (request.headers.host ?? '').replace(/:\d+$/, '').toLowerCase();
    const path = new URL(request.url ?? '/', 'http://x').pathname;
    const hosted = byHost.get(host);
    if (hosted && path === '/') return send(200, await page(hosted));
    if (!hosted && !loopbackHosts.has(host)) return send(421, 'Unknown host');
    const [, route, id] = path.split('/');
    if (route === 'assets' && assets.has(id) && path === '/assets/' + id) {
      const body = await readFile(join(root, 'assets', id));
      response.writeHead(200, { 'content-type': 'image/png', 'content-security-policy': policy, 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' });
      response.end(body); return;
    }
    const target = byId.get(decodeURIComponent(id ?? ''));
    if (route === 'pages' && target) return send(200, await page(target));
    if (route === 'frame' && target) return send(200, frame(target));
    if (path === '/') return send(200, index());
    return send(404, 'Not found');
  } catch { return send(500, 'Server error'); }
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  server.listen(port, '127.0.0.1', () => console.log(`Shepherd demo pages on http://127.0.0.1:${port}/ (loopback only)`));
}
