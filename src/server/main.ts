import { createOpenRouterTransport } from '../../tools/cloud-judge/cloud-judge.mjs';
import { MessagesFamilyAlert } from '../adapters/family.ts';
import { LlamaLocalModel } from '../adapters/llama-local.ts';
import { OcrAnalyzer } from '../adapters/ocr.ts';
import { OpenRouterJudge } from '../adapters/openrouter-judge.ts';
import { RoutedAnalyzer } from '../application/routing.ts';
import { demoPersona } from '../domain/persona.ts';
import { GrantRegistry } from './consent.ts';
import { startServer } from './server.ts';
import { TraceHub } from './trace.ts';

const port = Number(process.env.SHEPHERD_PORT ?? 4317);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('Invalid SHEPHERD_PORT');
// Routed runtime: rules always; the local model on loopback (llama-server); the
// cloud judge only when OPENROUTER_API_KEY is set, and then only for frames with
// a live registered grant. Missing tiers fall to the policy's unavailable rows.
const consent = new GrantRegistry();
const trace = new TraceHub();
const local = new LlamaLocalModel({ baseUrl: process.env.SHEPHERD_LLAMA_URL ?? 'http://127.0.0.1:8080' });
const apiKey = process.env.OPENROUTER_API_KEY;
const cloud = apiKey ? new OpenRouterJudge({
  model: process.env.SHEPHERD_CLOUD_MODEL ?? 'anthropic/claude-opus-5',
  transport: createOpenRouterTransport({ apiKey, title: 'Shepherd' }),
}) : undefined;
const analyzer = new RoutedAnalyzer({ extractor: new OcrAnalyzer(), local, cloud, consent, onAttempt: (step) => trace.recordAttempt(step) });
// Pause, source change and session end revoke the grant; the verdict cache goes with it.
consent.onRevoke(() => analyzer.clearCache());
// Family alert via Messages: handle from SHEPHERD_FAMILY_HANDLE; names from local
// configuration (demo persona by default). Unset handle -> 'unavailable'.
const family = new MessagesFamilyAlert({
  handle: process.env.SHEPHERD_FAMILY_HANDLE,
  persona: { person: process.env.SHEPHERD_PERSON ?? demoPersona.person, family_name: process.env.SHEPHERD_FAMILY_NAME ?? demoPersona.family_name },
});
const runtime = await startServer({ port, analyzer, consent, trace, family });
console.log(`Shepherd runtime: ${runtime.origin} (trace: ${runtime.origin}/trace)`);
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => { void runtime.close().then(() => process.exit(0)); });
}
