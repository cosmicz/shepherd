// Routing counterfactual over the frozen demo fixtures.
//
//   npx tsx eval/routing-eval.ts                 # cloud dry run: exact request bytes, no network
//   node --env-file=.env --import tsx eval/routing-eval.ts --live-cloud --cap 20
//
// Three policies see the same OCR text of the seven 2x fixture screenshots:
//   local-only  rules + local model (llama-server on loopback); the cloud step is skipped
//   cloud-only  a naive cloud design: every frame's redacted OCR text (<= 2 KB) to the judge
//   routed      the full contract v2 table, through the real HTTP server and HttpAnalyzer
// The cloud cap is enforced before dispatch: past it the judge reports unavailable.
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

import { createOpenRouterTransport, type Transport } from '../tools/cloud-judge/cloud-judge.mjs';
import { HttpAnalyzer } from '../src/adapters/http-analyzer.ts';
import { LlamaLocalModel } from '../src/adapters/llama-local.ts';
import { OcrAnalyzer } from '../src/adapters/ocr.ts';
import { OpenRouterJudge } from '../src/adapters/openrouter-judge.ts';
import { RoutedAnalyzer, type CloudJudgePort, type TextExtractor } from '../src/application/routing.ts';
import type { Assessment, Frame, Grant, Status } from '../src/domain/assessment.ts';
import { GrantRegistry } from '../src/server/consent.ts';
import { startServer } from '../src/server/server.ts';

const live = process.argv.includes('--live-cloud');
const capArgument = process.argv.indexOf('--cap');
const cap = capArgument > 0 ? Number(process.argv[capArgument + 1]) : 20;
const model = process.env.SHEPHERD_CLOUD_MODEL ?? 'anthropic/claude-opus-5';
const policyArgument = process.argv.indexOf('--policies');
const selected = new Set(policyArgument > 0 ? process.argv[policyArgument + 1].split(',') : ['local-only', 'cloud-only', 'routed']);
const root = new URL('../', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('demo/fixtures.json', root), 'utf8')) as {
  pages: Array<{ id: string; kind: 'scam' | 'hard_benign' | 'easy_benign'; allowed_final: Status[]; target_rows: string[] }>;
};

// Transport: live OpenRouter (key from --env-file) or a dry run that measures the
// exact request body and answers "unclear" without touching the network.
let dispatched = 0;
const base: Transport = live
  ? createOpenRouterTransport({ apiKey: process.env.OPENROUTER_API_KEY ?? '', title: 'Shepherd eval' })
  : async () => ({ choices: [{ message: { content: JSON.stringify({ verdict: 'unclear', reasons: [], pattern: 'other', rationale: 'dry run' }) } }] });
const transport: Transport = async (request) => { dispatched++; return base(request); };
if (live && !process.env.OPENROUTER_API_KEY) throw Error('--live-cloud needs OPENROUTER_API_KEY (node --env-file=.env)');
class CappedJudge extends OpenRouterJudge {
  available(): boolean { return super.available() && dispatched < cap; }
}
const judge: CloudJudgePort = new CappedJudge({ model, transport });

// OCR each screenshot once; every policy sees the same text.
const ocr = new OcrAnalyzer();
const texts = new Map<string, string>();
const images = new Map<string, string>();
for (const page of manifest.pages) {
  const png = await readFile(new URL(`demo/screenshots/${page.id}.png`, root));
  images.set(page.id, `data:image/png;base64,${png.toString('base64')}`);
  const frame: Frame = { frame_id: page.id, source: 'example', image: images.get(page.id) as string };
  texts.set(page.id, await ocr.extract(frame, new AbortController().signal));
}
const extractor: TextExtractor = { extract: async (frame) => texts.get(frame.frame_id.split('#')[0]) ?? '' };

const session = { session_id: randomUUID(), generation: 1 };
const now = Date.now();
const grant: Grant = { id: randomUUID(), ...session, source: 'example', scope: 'redacted-text', max_bytes: 2048, version: 1,
  granted_at: new Date(now - 1000).toISOString(), expires_at: new Date(now + 3600_000).toISOString() };
// Real screenshots on the wire (the server decodes them); OCR text comes from the cache.
const frameFor = (id: string, policy: string): Frame => ({ frame_id: `${id}#${policy}`, source: 'example', image: images.get(id) as string, ...session, consent: grant });
const local = new LlamaLocalModel();

interface Row { id: string; kind: string; status: Status; expected: Status[]; row: string; ms: number; remote_calls: number; bytes_out: number; cost_usd: number; unknown_cost: number; steps: string }
const toRow = (id: string, assessment: Assessment, ms: number): Row => {
  const page = manifest.pages.find((p) => p.id === id)!;
  const cloud = assessment.trace.filter((step) => step.tier === 'cloud');
  return { id, kind: page.kind, status: assessment.status, expected: page.allowed_final, row: assessment.policy_row ?? '', ms,
    remote_calls: cloud.reduce((sum, step) => sum + step.remote_calls, 0), bytes_out: cloud.reduce((sum, step) => sum + step.bytes_out, 0),
    cost_usd: cloud.reduce((sum, step) => sum + (step.cost.known ? step.cost.usd : 0), 0),
    unknown_cost: cloud.filter((step) => step.remote_calls > 0 && !step.cost.known).length,
    steps: assessment.trace.map((step) => `${step.tier}:${step.outcome}${step.failure_kind ? `/${step.failure_kind}` : ''}`).join(' > ') };
};

async function runPolicy(name: string, analyze: (frame: Frame) => Promise<Assessment>): Promise<Row[]> {
  const rows: Row[] = [];
  for (const page of manifest.pages) {
    const started = performance.now();
    const assessment = await analyze(frameFor(page.id, name));
    rows.push(toRow(page.id, assessment, Math.round(performance.now() - started)));
  }
  return rows;
}

// local-only: no cloud port at all.
const localOnly = !selected.has('local-only') ? [] : await runPolicy('local-only', (frame) => new RoutedAnalyzer({ extractor, local }).analyze(frame, new AbortController().signal));

// cloud-only: every frame's redacted OCR text to the judge (naive design, labelled).
const cloudOnly = !selected.has('cloud-only') ? [] : await runPolicy('cloud-only', async (frame) => {
  const text = texts.get(frame.frame_id.split('#')[0]) ?? '';
  let excerpt = judge.redact(text.replace(/\s+/g, ' ').trim());
  while (Buffer.byteLength(excerpt) > 2048) excerpt = excerpt.slice(0, Math.floor(excerpt.length * 0.9));
  const request = { excerpt, rulesReasons: [], localRisk: 'medium' as const, localReasons: [], source: frame.source, patternHints: [] };
  const base = { frame_id: frame.frame_id, source: frame.source, reasons: [], evidence: [], message: 'cloud-only', media_origin: 'not_assessed' as const, duration_ms: 0 };
  if (!judge.available()) {
    return { ...base, status: 'inconclusive', analyzer: { id: 'local-ocr-rules', kind: 'rules', version: '1' }, route: 'local', trace: [] } as Assessment;
  }
  const outcome = await judge.judge(request, new AbortController().signal, frame);
  const status: Status = outcome.ok ? (outcome.verdict === 'scam' || outcome.verdict === 'suspicious' ? 'concern' : outcome.verdict === 'benign' ? 'no_signal' : 'inconclusive') : 'inconclusive';
  return { ...base, status, reasons: status === 'concern' ? (outcome.ok && outcome.reasons.length ? outcome.reasons : ['impersonation']) : [],
    analyzer: { id: 'cloud-judge', kind: 'model', provider: 'anthropic', model }, route: 'cloud',
    trace: [{ tier: 'cloud', analyzer_id: 'cloud-judge', outcome: outcome.ok ? status : 'failed', ...(outcome.ok ? {} : { failure_kind: outcome.failure_kind }),
      duration_ms: 0, remote_calls: 1, bytes_out: outcome.bytes_out, payload_sha256: outcome.payload_sha256, cost: outcome.cost, cached: false, versions: { policy: 2, prompt: 1, schema: 2 } }] } as Assessment;
});

// routed: the real loopback server + HttpAnalyzer, with the grant registered.
const consent = new GrantRegistry();
consent.register(grant);
const runtime = await startServer({ port: 0, consent, analyzer: new RoutedAnalyzer({ extractor, local, cloud: judge, consent }) });
const client = new HttpAnalyzer(runtime.origin);
const routed = !selected.has('routed') ? [] : await runPolicy('routed', (frame) => client.analyze(frame, new AbortController().signal));
await runtime.close();

// Report.
const perDay = (8 * 3600) / 5;
const pct = (values: number[], q: number) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * q))];
function summary(name: string, rows: Row[]) {
  const sum = (key: 'remote_calls' | 'bytes_out' | 'cost_usd' | 'unknown_cost') => rows.reduce((total, row) => total + row[key], 0);
  return {
    policy: name,
    missed: rows.filter((r) => r.kind === 'scam' && r.status !== 'concern').length,
    false_alarms: rows.filter((r) => r.kind !== 'scam' && r.status === 'concern').length,
    abstentions: rows.filter((r) => r.status === 'inconclusive' || r.status === 'unavailable').length,
    within_expected: rows.filter((r) => r.expected.includes(r.status)).length,
    p50_ms: pct(rows.map((r) => r.ms), 0.5), p95_ms: pct(rows.map((r) => r.ms), 0.95),
    remote_calls: sum('remote_calls'), bytes_out: sum('bytes_out'), cost_known_usd: Math.round(sum('cost_usd') * 1e6) / 1e6, unknown_cost_attempts: sum('unknown_cost'),
    per_day_calls_same_mix: Math.round((sum('remote_calls') / rows.length) * perDay),
    per_day_known_usd_same_mix: Math.round((sum('cost_usd') / rows.length) * perDay * 100) / 100,
  };
}
const policies = Object.fromEntries(Object.entries({ 'local-only': localOnly, 'cloud-only': cloudOnly, routed }).filter(([name]) => selected.has(name)));
const summaries = Object.entries(policies).map(([name, rows]) => summary(name, rows));
const result = { run_at: new Date().toISOString(), live_cloud: live, model, cap, dispatched, frames: manifest.pages.length,
  ocr_sha256: createHash('sha256').update([...texts.values()].join('\n')).digest('hex'), summaries, rows: policies };
await writeFile(new URL(`eval/results-${live ? 'live' : 'dry'}.json`, root), `${JSON.stringify(result, null, 2)}\n`);

const header = '| policy | missed | false alarms | abstentions | within expected | p50 ms | p95 ms | cloud calls | bytes out | known USD | unknown-cost calls | calls/day (same mix) | known USD/day (same mix) |';
console.log(`${live ? 'LIVE' : 'DRY RUN (no network; cloud answers "unclear")'} — model ${model}, ${manifest.pages.length} frames, cloud requests sent: ${dispatched}/${cap}`);
console.log(header);
console.log('|-' + '-+-'.repeat(12) + '-|');
for (const s of summaries) console.log(`| ${s.policy} | ${s.missed} | ${s.false_alarms} | ${s.abstentions} | ${s.within_expected}/${manifest.pages.length} | ${s.p50_ms} | ${s.p95_ms} | ${s.remote_calls} | ${s.bytes_out} | ${s.cost_known_usd} | ${s.unknown_cost_attempts} | ${s.per_day_calls_same_mix} | ${s.per_day_known_usd_same_mix} |`);
console.log('\nper frame (policy: id status row ms calls bytes):');
for (const [name, rows] of Object.entries(policies)) for (const r of rows) console.log(`${name}: ${r.id} ${r.status} row ${r.row} ${r.ms} ms calls ${r.remote_calls} bytes ${r.bytes_out} [${r.steps}]`);
