// Routing counterfactual over the frozen demo fixtures.
//
//   npx tsx eval/routing-eval.ts                 # cloud dry run: exact request bytes, no network
//   node --env-file=.env --import tsx eval/routing-eval.ts --live-cloud --cap 20
//
// Three policies see the same OCR text of the eight 2x fixture screenshots:
//   local-only  rules + local model (llama-server on loopback); the cloud step is skipped
//   cloud-only  a naive cloud design: every frame's redacted OCR text (<= 2 KB) to the judge
//   routed      the full contract v2 table, through the real HTTP server and HttpAnalyzer
// The cloud cap is enforced before dispatch: past it the judge reports unavailable.
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';

import { createOpenRouterTransport, type Transport } from '../tools/cloud-judge/cloud-judge.mjs';
import { HttpAnalyzer } from '../src/adapters/http-analyzer.ts';
import { LlamaLocalModel } from '../src/adapters/llama-local.ts';
import { OcrAnalyzer } from '../src/adapters/ocr.ts';
import { OpenRouterJudge } from '../src/adapters/openrouter-judge.ts';
import { RoutedAnalyzer, type CloudJudgePort, type TextExtractor } from '../src/application/routing.ts';
import type { AnalyzerPort } from '../src/application/analyzer.ts';
import { POLICY_VERSION, PROMPT_VERSION, SCHEMA_VERSION, type Assessment, type Frame, type Grant, type Status } from '../src/domain/assessment.ts';
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
  pages: Array<{ id: string; kind: 'scam' | 'hard_benign' | 'easy_benign'; allowed_final: Status[]; target_rows: string[]; target_route: string }>;
};

// Transport: live OpenRouter (key from --env-file) or a dry run that measures the
// exact request body and answers "unclear" without touching the network.
let dispatched = 0;
const base: Transport = live
  ? createOpenRouterTransport({ apiKey: process.env.OPENROUTER_API_KEY ?? '', title: 'Shepherd eval' })
  : async () => ({ choices: [{ message: { content: JSON.stringify({ verdict: 'unclear', reasons: [], pattern: 'other', rationale: 'dry run' }) } }] });
const resolvedModels = new Set<string>();
const transport: Transport = async (request) => {
  dispatched++;
  const response = await base(request) as { model?: string };
  if (typeof response?.model === 'string') resolvedModels.add(response.model);
  return response;
};
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

interface Row { id: string; kind: string; status: Status; expected: Status[]; row: string; target_rows: string[]; row_deviation: boolean; ms: number; remote_calls: number; bytes_out: number; cost_usd: number; unknown_cost: number; steps: string }
const toRow = (id: string, assessment: Assessment, ms: number): Row => {
  const page = manifest.pages.find((p) => p.id === id)!;
  const cloud = assessment.trace.filter((step) => step.tier === 'cloud');
  const row = assessment.policy_row ?? '';
  return { id, kind: page.kind, status: assessment.status, expected: page.allowed_final, row, target_rows: page.target_rows, row_deviation: row !== page.target_rows.at(-1), ms,
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

// Every policy runs behind the same boundary: a loopback server + HttpAnalyzer,
// so latencies are comparable (OCR time excluded: text is cached per fixture).
class CloudOnlyAnalyzer implements AnalyzerPort {
  // Naive cloud design for the counterfactual: each frame's redacted OCR text (<= 2 KB).
  async capabilities() { return [{ id: 'cloud-judge' as const, kind: 'model' as const, route: 'cloud' as const, available: judge.available(), model }]; }
  async analyze(frame: Frame, signal: AbortSignal): Promise<Assessment> {
    const text = texts.get(frame.frame_id.split('#')[0]) ?? '';
    let excerpt = judge.redact(text.replace(/\s+/g, ' ').trim());
    while (Buffer.byteLength(excerpt) > 2048) excerpt = excerpt.slice(0, Math.floor(excerpt.length * 0.9));
    const started = performance.now();
    const outcome = await judge.judge({ excerpt, rulesReasons: [], localRisk: 'medium', localReasons: [], source: frame.source, patternHints: [] }, signal, frame);
    const status: Status = outcome.ok ? (outcome.verdict === 'scam' || outcome.verdict === 'suspicious' ? 'concern' : outcome.verdict === 'benign' ? 'no_signal' : 'inconclusive') : 'inconclusive';
    return { frame_id: frame.frame_id, source: frame.source, status, reasons: status === 'concern' ? (outcome.ok && outcome.reasons.length ? outcome.reasons : ['impersonation']) : [],
      evidence: [], message: 'cloud-only', media_origin: 'not_assessed', duration_ms: Math.round(performance.now() - started),
      analyzer: { id: 'cloud-judge', kind: 'model', provider: 'anthropic', model }, route: 'cloud',
      trace: [{ tier: 'cloud', analyzer_id: 'cloud-judge', outcome: outcome.ok ? status : 'failed', ...(outcome.ok ? {} : { failure_kind: outcome.failure_kind }),
        duration_ms: Math.round(performance.now() - started), remote_calls: 1, bytes_out: outcome.bytes_out, ...(outcome.payload_sha256 ? { payload_sha256: outcome.payload_sha256 } : {}),
        cost: outcome.cost, cached: false, versions: { policy: POLICY_VERSION, prompt: PROMPT_VERSION, schema: SCHEMA_VERSION } }] };
  }
}

async function overHttp(name: string, analyzer: AnalyzerPort, consent?: GrantRegistry): Promise<Row[]> {
  if (!selected.has(name)) return [];
  const runtime = await startServer({ port: 0, analyzer, consent });
  try {
    const client = new HttpAnalyzer(runtime.origin);
    return await runPolicy(name, (frame) => client.analyze(frame, new AbortController().signal));
  } finally { await runtime.close(); }
}

const consent = new GrantRegistry();
consent.register(grant);
const localOnly = await overHttp('local-only', new RoutedAnalyzer({ extractor, local }));
const cloudOnly = await overHttp('cloud-only', new CloudOnlyAnalyzer());
const routed = await overHttp('routed', new RoutedAnalyzer({ extractor, local, cloud: judge, consent }), consent);

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
    row_target_deviations: rows.filter((r) => r.row_deviation).length,
    p50_ms: pct(rows.map((r) => r.ms), 0.5), p95_ms: pct(rows.map((r) => r.ms), 0.95),
    remote_calls: sum('remote_calls'), bytes_out: sum('bytes_out'), cost_known_usd: Math.round(sum('cost_usd') * 1e6) / 1e6, unknown_cost_attempts: sum('unknown_cost'),
    per_day_calls_same_mix: Math.round((sum('remote_calls') / rows.length) * perDay),
    per_day_known_usd_same_mix: Math.round((sum('cost_usd') / rows.length) * perDay * 100) / 100,
  };
}
const policies = Object.fromEntries(Object.entries({ 'local-only': localOnly, 'cloud-only': cloudOnly, routed }).filter(([name]) => selected.has(name)));
const summaries = Object.entries(policies).map(([name, rows]) => summary(name, rows));
const git = (...args: string[]) => execFileSync('git', args, { cwd: new URL('.', root).pathname, encoding: 'utf8' }).trim();
const sha256File = (path: string) => new Promise<string>((resolve, reject) => {
  const hash = createHash('sha256');
  createReadStream(path).on('data', (chunk) => hash.update(chunk)).on('end', () => resolve(hash.digest('hex'))).on('error', reject);
});
const fixtureHash = createHash('sha256');
fixtureHash.update(await readFile(new URL('demo/fixtures.json', root)));
for (const page of manifest.pages) fixtureHash.update(await readFile(new URL(`demo/screenshots/${page.id}.png`, root)));
const localModelFile = `${homedir()}/models/gguf/qwen3-8b-q4_k_m.gguf`;
const provenance = {
  source_sha: git('rev-parse', 'HEAD'), source_dirty: git('status', '--porcelain') !== '',
  runner_sha256: createHash('sha256').update(await readFile(new URL('eval/routing-eval.ts', root))).digest('hex'),
  fixtures_sha256: fixtureHash.digest('hex'), local_model_file: localModelFile, local_model_sha256: await sha256File(localModelFile).catch(() => 'unavailable'),
  cloud_model_requested: model, cloud_models_resolved: [...resolvedModels], ocr_time_excluded: true, boundary: 'loopback HTTP server + HttpAnalyzer for every policy',
};
const result = { run_at: new Date().toISOString(), provenance, live_cloud: live, model, cap, dispatched, frames: manifest.pages.length,
  ocr_sha256: createHash('sha256').update([...texts.values()].join('\n')).digest('hex'), summaries, rows: policies };
await writeFile(new URL(`eval/results-${live ? 'live' : 'dry'}.json`, root), `${JSON.stringify(result, null, 2)}\n`);

const header = '| policy | missed | false alarms | abstentions | within expected | row-target deviations | p50 ms | p95 ms | cloud calls | bytes out | known USD | unknown-cost calls | calls/day (same mix) | known USD/day (same mix) |';
console.log(`${live ? 'LIVE' : 'DRY RUN (no network; cloud answers "unclear")'} — model ${model} (resolved: ${[...resolvedModels].join(', ') || 'n/a'}), ${manifest.pages.length} frames, cloud requests sent: ${dispatched}/${cap}`);
console.log(`source ${provenance.source_sha}${provenance.source_dirty ? ' (dirty)' : ''}; runner ${provenance.runner_sha256.slice(0, 12)}; fixtures ${provenance.fixtures_sha256.slice(0, 12)}; local model ${provenance.local_model_sha256.slice(0, 12)}; OCR time excluded`);
console.log(header);
console.log('|-' + '-+-'.repeat(13) + '-|');
for (const s of summaries) console.log(`| ${s.policy} | ${s.missed} | ${s.false_alarms} | ${s.abstentions} | ${s.within_expected}/${manifest.pages.length} | ${s.row_target_deviations} | ${s.p50_ms} | ${s.p95_ms} | ${s.remote_calls} | ${s.bytes_out} | ${s.cost_known_usd} | ${s.unknown_cost_attempts} | ${s.per_day_calls_same_mix} | ${s.per_day_known_usd_same_mix} |`);
console.log('\nper frame (policy: id status row ms calls bytes):');
for (const [name, rows] of Object.entries(policies)) for (const r of rows) console.log(`${name}: ${r.id} ${r.status}${r.expected.includes(r.status) ? '' : ' (UNEXPECTED)'} row ${r.row} (target ${r.target_rows.join('>')})${r.row_deviation ? ' DEVIATES' : ''} ${r.ms} ms calls ${r.remote_calls} bytes ${r.bytes_out} [${r.steps}]`);
