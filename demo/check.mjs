// Verify the demo kit offline: static pages make no network loads, and the
// tier-0 rules outcome of each screenshot matches demo/fixtures.json.
//
//   node demo/check.mjs [--rules path/to/src/domain/assessment.ts]
//
// OCR uses the same Tesseract arguments as the runtime OcrAnalyzer. The rules
// are the runtime's own analyzeText, imported rather than copied, so a rule
// change that breaks a fixture's intended tier fails here. Tesseract is an
// installed third-party binary and gets a minimal allowlisted environment; in
// the event rig, run this only after posting intent on the bead and getting the
// operator's go.
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(await readFile(join(root, 'fixtures.json'), 'utf8'));
const rulesArgument = process.argv.indexOf('--rules');
const rulesPath = rulesArgument > 0 ? resolve(process.argv[rulesArgument + 1]) : join(root, '..', 'src', 'domain', 'assessment.ts');
const { analyzeText } = await import(pathToFileURL(rulesPath).href);

function tesseractEnvironment() {
  // Allowlist: PATH to locate the executable, TESSDATA_PREFIX only if the caller set it.
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'en_US.UTF-8' };
  if (process.env.TESSDATA_PREFIX) env.TESSDATA_PREFIX = process.env.TESSDATA_PREFIX;
  return env;
}

function ocr(png) {
  return new Promise((resolveText, reject) => {
    const child = execFile('tesseract', ['stdin', 'stdout', '-l', 'eng', '--psm', '6'], { encoding: 'utf8', timeout: 30_000, maxBuffer: 1 << 20, env: tesseractEnvironment() },
      (error, stdout) => (error ? reject(error) : resolveText(stdout)));
    child.stdin.end(png);
  });
}

const failures = [];
const fail = (id, message) => { failures.push(`${id}: ${message}`); console.log(`FAIL ${id}: ${message}`); };
const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
// Route each terminal row of the policy v2 routing table resolves to (rows 4/8/10/12 hand off to 13-17).
const terminalRoute = { 1: 'local', 2: 'local', 3: 'local', 5: 'local', 6: 'local', 7: 'local-model', 9: 'local-model', 11: 'local-model',
  '12b': 'local-model', '12c': 'local-model', 13: 'cloud', 14: 'cloud', 15: 'cloud', 16: 'cloud', 17: 'cloud' };

function checkManifestRow(page) {
  const rows = page.target_rows ?? [];
  if (!rows.length || rows.some((row) => !manifest.policy_rows.includes(row))) return fail(page.id, `unknown target_rows ${JSON.stringify(rows)}`);
  const route = terminalRoute[rows.at(-1)];
  if (route !== page.target_route) fail(page.id, `target_route ${page.target_route} != route of row ${rows.at(-1)} (${route})`);
  if (route === 'cloud' && !page.cloud_call_allowed) fail(page.id, 'cloud route but cloud_call_allowed is false');
  if (page.kind === 'scam' && !same(page.allowed_final, ['concern'])) fail(page.id, 'scam must allow only concern');
  if (page.kind !== 'scam' && page.allowed_final.includes('concern')) fail(page.id, 'benign page must never allow concern');
}

for (const page of manifest.pages) {
  const before = failures.length;
  checkManifestRow(page);
  const html = await readFile(join(root, 'pages', `${page.id}.html`), 'utf8');
  if (!html.includes(`content="default-src 'none'; style-src 'unsafe-inline'"`)) fail(page.id, 'missing restrictive CSP');
  if (/\b(?:src|href)\s*=\s*["']?(?:https?:)?\/\//i.test(html) || /url\(\s*["']?(?:https?:)?\/\//i.test(html) || /<script\b/i.test(html)) fail(page.id, 'external resource or script');
  if (page.rules.status === 'concern' && !page.allowed_final.includes('concern')) fail(page.id, 'rules concern contradicts allowed_final');

  const png = await readFile(join(root, 'screenshots', `${page.id}.png`)).catch(() => null);
  if (!png) { fail(page.id, 'screenshot missing; run demo/capture.mjs'); continue; }
  const text = await ocr(png);
  const result = analyzeText(text, { frame_id: page.id, source: 'example' });
  const observed = { status: result.status, reasons: result.reasons };
  if (observed.status !== page.rules.status || !same(observed.reasons, page.rules.reasons)) fail(page.id, `rules ${JSON.stringify(observed)} != expected ${JSON.stringify(page.rules)}`);
  if (failures.length === before) console.log(`ok   ${page.id}: rules ${observed.status}${observed.reasons.length ? ` [${observed.reasons.join(', ')}]` : ''}; address bar ${text.replace(/\s+/g, '').includes(page.host) ? 'read' : 'not read (informational)'}`);
}

if (failures.length) { console.log(`${failures.length} failure(s)`); process.exit(1); }
console.log(`all ${manifest.pages.length} fixtures match`);
