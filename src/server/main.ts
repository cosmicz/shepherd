import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrivateEvidenceJournal } from '../adapters/evidence-journal.ts';
import { createOpenRouterTransport } from '../../tools/cloud-judge/cloud-judge.mjs';
import { NativeBanner } from '../adapters/banner.ts';
import { AccessibilityTreeSource } from '../adapters/accessibility.ts';
import { createDecisionsTransport, DECISION_MODELS, DecisionsJudge, type DecisionModel } from '../adapters/decisions-judge.ts';
import { MessagesFamilyAlert } from '../adapters/family.ts';
import { LlamaLocalModel } from '../adapters/llama-local.ts';
import { LlamaManager } from '../adapters/llama-manager.ts';
import { OcrAnalyzer } from '../adapters/ocr.ts';
import { OpenRouterJudge } from '../adapters/openrouter-judge.ts';
import { RecordingJudge, ReplayJudge } from '../adapters/replay-judge.ts';
import { loadThreatTraceTagger } from '../adapters/threat-trace.ts';
import type { CloudJudgePort } from '../application/routing.ts';
import { localDeadline, RoutedAnalyzer } from '../application/routing.ts';
import { ObservationCollector, ScreenFrameSource, ScreenObservationRecorder } from '../application/observation.ts';
import { demoPersona } from '../domain/persona.ts';
import { makeUnavailable } from '../domain/assessment.ts';
import type { PipelineRecord } from '../domain/pipeline.ts';
import { GrantRegistry } from './consent.ts';
import { startServer } from './server.ts';
import { TraceHub } from './trace.ts';

const port = Number(process.env.SHEPHERD_PORT ?? 4317);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('Invalid SHEPHERD_PORT');
// Routed runtime: rules always; the local model on loopback (llama-server); the
// cloud judge only when OPENROUTER_API_KEY is set, and then only for frames with
// a live registered grant. Missing tiers fall to the policy's unavailable rows.
const consent = new GrantRegistry();
// Explicit local store only: never download or refresh a feed during a session.
const threatStore = process.env.SHEPHERD_THREAT_STORE;
const threats = threatStore ? await loadThreatTraceTagger(threatStore, process.env.SHEPHERD_THREAT_OCR === '1').catch(() => undefined) : undefined;
const trace = new TraceHub({ tagger: (frame) => threats?.tags(frame) ?? [] });
console.log(`Offline threat annotations: ${threats ? 'loaded (indicators only)' : 'off or snapshot unavailable'}`);
// The journal is default-off. Its app-private store is never created until an
// enabled observation actually commits, and first live recording remains an
// operator-run action through the companion switch.
const evidenceJournal = new PrivateEvidenceJournal(process.env.SHEPHERD_JOURNAL_DIR ?? join(homedir(), 'Library', 'Application Support', 'Shepherd', 'journal'));
const collector = new ObservationCollector(evidenceJournal);
const screenRecorder = new ScreenObservationRecorder(new ScreenFrameSource(), collector);
const pipelineByFrame = new Map<string, PipelineRecord>();
const recorder = {
  get enabled() { return screenRecorder.enabled; },
  setEnabled(enabled: boolean) { screenRecorder.setEnabled(enabled); },
  async record(frame: Parameters<ScreenObservationRecorder['record']>[0], assessment: Parameters<ScreenObservationRecorder['record']>[1]) {
    const pipeline = pipelineByFrame.get(frame.frame_id);
    pipelineByFrame.delete(frame.frame_id);
    await screenRecorder.record(frame, assessment, pipeline);
  },
  async deleteAll() { await screenRecorder.deleteAll(); },
};
// The runtime manages llama-server (contract): reuse one already on the port,
// otherwise start SHEPHERD_LOCAL_MODEL with SHEPHERD_LLAMA_SERVER (default on PATH).
const llamaPort = Number(process.env.SHEPHERD_LLAMA_PORT ?? 8080);
const manager = new LlamaManager({
  model: process.env.SHEPHERD_LOCAL_MODEL, binary: process.env.SHEPHERD_LLAMA_SERVER ?? 'llama-server', port: llamaPort,
  onChange: (state) => console.log(`Local model: ${state.state}${state.managed ? ' (managed)' : ''}${state.reason ? ` - ${state.reason}` : ''}`),
});
// One local deadline for the composite and the adapter's own timer (contract).
const localMs = localDeadline(process.env.SHEPHERD_LOCAL_DEADLINE_MS);
const local = new LlamaLocalModel({ baseUrl: manager.baseUrl, manager, timeoutMs: localMs });
const apiKey = process.env.OPENROUTER_API_KEY;
// Cloud judge implementation (5qp, operator requirement 16:27): the Jev/Clef decision
// models by default, the Opus chat judge with SHEPHERD_CLOUD_JUDGE=openrouter.
const judgeKind = process.env.SHEPHERD_CLOUD_JUDGE ?? 'decisions';
if (judgeKind !== 'decisions' && judgeKind !== 'openrouter') throw Error('Invalid SHEPHERD_CLOUD_JUDGE: decisions or openrouter');
const decisionModel = (process.env.SHEPHERD_DECISION_MODEL ?? 'cloudflare/clef-flash') as DecisionModel;
if (!DECISION_MODELS.includes(decisionModel)) throw Error(`Invalid SHEPHERD_DECISION_MODEL: one of ${DECISION_MODELS.join(', ')}`);
const cloudModel = judgeKind === 'decisions' ? decisionModel : process.env.SHEPHERD_CLOUD_MODEL ?? 'anthropic/claude-opus-5';
// Demo safety net (demo/runbook.org): SHEPHERD_CLOUD_REPLAY=<file> serves verdicts
// recorded in rehearsal with SHEPHERD_CLOUD_RECORD=<file>; replays show as cached,
// zero calls, model "replay:<model>".
let cloud: CloudJudgePort | undefined;
if (process.env.SHEPHERD_CLOUD_REPLAY) cloud = new ReplayJudge({ file: process.env.SHEPHERD_CLOUD_REPLAY, model: cloudModel });
else if (apiKey) {
  const live: CloudJudgePort = judgeKind === 'decisions'
    ? new DecisionsJudge({ model: decisionModel, transport: createDecisionsTransport({ apiKey }) })
    : new OpenRouterJudge({ model: cloudModel, transport: createOpenRouterTransport({ apiKey, title: 'Shepherd' }) });
  cloud = process.env.SHEPHERD_CLOUD_RECORD ? new RecordingJudge(live, process.env.SHEPHERD_CLOUD_RECORD) : live;
}
// Model-quote excerpts stay off unless SHEPHERD_QUOTE_EXCERPTS=1 (d3l); the companion's
// scope statement follows the same switch.
const quoteExcerpts = process.env.SHEPHERD_QUOTE_EXCERPTS === '1';
// A lone local-model other_concern (row 12d) is shown, not spoken, unless SHEPHERD_OPEN_CONCERN=spoken.
const openConcern = process.env.SHEPHERD_OPEN_CONCERN === 'spoken' ? 'spoken' as const : 'quiet' as const;
// Rules annotate only; SHEPHERD_RULES_DECIDE=1 lets a strong rule settle a concern alone (row 3).
const rulesDecide = process.env.SHEPHERD_RULES_DECIDE === '1';
// The OCR text of each pixel frame is handed to the trace so a row shows what the rules read.
const ocr = new OcrAnalyzer();
const extractor = { extract: async (frame: Parameters<OcrAnalyzer['extract']>[0], signal: AbortSignal) => { const text = await ocr.extract(frame, signal); trace.recordExtract(frame.frame_id, text); threats?.remember(frame, text); return text; } };
const analyzer = new RoutedAnalyzer({ extractor, local, cloud, consent, quoteExcerpts, openConcern, rulesDecide, deadlines: { local_ms: localMs }, onAttempt: (step) => trace.recordAttempt(step), onPipeline: (record) => {
  trace.recordPipelineSummary(record);
  if (recorder.enabled) pipelineByFrame.set(record.frame_id, record);
} });
// Pause, source change and session end revoke the grant; the verdict cache goes with it.
consent.onRevoke(() => analyzer.clearCache());
// Family alert via Messages: handle from SHEPHERD_FAMILY_HANDLE; names from local
// configuration (demo persona by default). Unset handle -> 'unavailable'.
const persona = { person: process.env.SHEPHERD_PERSON ?? demoPersona.person, family_name: process.env.SHEPHERD_FAMILY_NAME ?? demoPersona.family_name };
const family = new MessagesFamilyAlert({ handle: process.env.SHEPHERD_FAMILY_HANDLE, persona });
// Native in-place banner on concern (x3k), off unless SHEPHERD_BANNER=1. The title
// ends with "Shepherd <nonce>" so shepherd-eyes' --exclude-nonce never reads it.
// The helper refuses a nonce shorter than 16 characters or with whitespace.
const excludeNonce = process.env.SHEPHERD_EXCLUDE_NONCE ?? randomBytes(16).toString('hex');
if (!/^\S{16,}$/.test(excludeNonce)) throw Error('Invalid SHEPHERD_EXCLUDE_NONCE: at least 16 characters, no whitespace');
const banner = process.env.SHEPHERD_BANNER === '1' ? new NativeBanner({
  binary: process.env.SHEPHERD_BANNER_BIN ?? fileURLToPath(new URL('../../tools/shepherd-banner/shepherd-banner', import.meta.url)),
  title: `Shepherd ${excludeNonce}`,
}) : undefined;
// Exact local Accessibility text is off by default. When the operator enables
// it, retain the AX URL/title/app on the frame so rules can inspect only the
// URL and the local trace can show its provenance beside the text.
const accessibility = process.env.SHEPHERD_ACCESSIBILITY === '1' ? new AccessibilityTreeSource(undefined, { exclude_nonce: excludeNonce }) : undefined;
const stopAccessibility = accessibility?.startFrames((frame) => {
  void analyzer.analyze(frame, new AbortController().signal)
    .then((assessment) => trace.recordAssessment(assessment, frame))
    .catch(() => trace.recordAssessment(makeUnavailable(frame), frame));
});
const runtime = await startServer({ port, analyzer, consent, trace, family, recorder, journal: evidenceJournal, quoteExcerpts, banner, persona });
console.log(`Shepherd runtime: ${runtime.origin} (companion: ${runtime.origin}/companion, trace: ${runtime.origin}/trace)`);
console.log(`Tiers: rules on; local model ${local.model} (deadline ${localMs} ms); cloud ${cloud ? `${cloud.model} (${judgeKind})` : 'off (no key)'}; quote excerpts ${quoteExcerpts ? 'on' : 'off'}; open concern ${openConcern}; rules ${rulesDecide ? 'decide' : 'annotate only'}; family alert ${family.configured ? 'configured' : 'not configured'}; banner ${banner ? 'on' : 'off'}; accessibility ${accessibility ? 'on' : 'off'}`);
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  // Stop a server we started (SIGTERM, then SIGKILL after 5 s); never one we reused.
  process.once(signal, () => { stopAccessibility?.(); void manager.stop().then(() => runtime.close()).then(() => process.exit(0)); });
}
// Start (or reuse) the local model in the background: the runtime serves at once,
// and the local tier reports starting/warming until it is ready.
void manager.start();
