const REASONS = ['support_pressure', 'payment_pressure', 'credential_pressure', 'investment_pressure', 'impersonation', 'remote_access', 'family_emergency', 'prize_claim'];
const RISKS = new Set(['low', 'medium', 'high']);

export class AnalysisCancelled extends Error {
  constructor() { super('analysis cancelled'); this.name = 'AnalysisCancelled'; }
}

function abortIfNeeded(signal) {
  if (signal?.aborted) throw new AnalysisCancelled();
}

function localSchema() {
  return { type: 'object', additionalProperties: false, required: ['risk', 'reasons', 'cue'], properties: {
    risk: { type: 'string', enum: [...RISKS] },
    reasons: { type: 'array', items: { type: 'string', enum: REASONS }, uniqueItems: true },
    cue: { type: 'string', maxLength: 120 },
  } };
}

function parse(value) {
  if (!value || typeof value !== 'object' || Object.keys(value).length !== 3
    || !RISKS.has(value.risk) || !Array.isArray(value.reasons)
    || !value.reasons.every((reason) => REASONS.includes(reason))
    || new Set(value.reasons).size !== value.reasons.length
    || ((value.risk === 'medium' || value.risk === 'high') && value.reasons.length === 0)
    || typeof value.cue !== 'string' || value.cue.length > 120) throw new Error('malformed');
  return { risk: value.risk, reasons: [...value.reasons], cue: value.cue };
}

function failure(failureKind) {
  return { outcome: 'failed', failureKind, trace: { tier: 'local-model', remote_calls: 0, bytes_out: 0, cost: { known: true, usd: 0 } } };
}

export class LocalModelAdapter {
  constructor({ baseUrl = 'http://127.0.0.1:8080', model = 'qwen3-8b-q4_k_m.gguf', timeoutMs = 4000, fetchImpl = fetch } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, ''); this.model = model; this.timeoutMs = timeoutMs; this.fetch = fetchImpl;
  }

  async capabilities() {
    try {
      const response = await this.fetch(`${this.baseUrl}/health`);
      if (!response.ok) return { available: false, model: this.model };
      const warmup = await this.fetch(`${this.baseUrl}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: this.model, messages: [{ role: 'system', content: '/no_think' }, { role: 'user', content: 'warm' }], max_tokens: 1, chat_template_kwargs: { enable_thinking: false } }) });
      return { available: warmup.ok, model: this.model };
    } catch { return { available: false, model: this.model }; }
  }

  async analyze({ text }, callerSignal) {
    abortIfNeeded(callerSignal);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new DOMException('deadline exceeded', 'TimeoutError')), this.timeoutMs);
    const abort = () => controller.abort(callerSignal?.reason);
    callerSignal?.addEventListener('abort', abort, { once: true });
    try {
      const response = await this.fetch(`${this.baseUrl}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: controller.signal, body: JSON.stringify({
        model: this.model, messages: [{ role: 'system', content: '/no_think' }, { role: 'user', content: text }], chat_template_kwargs: { enable_thinking: false },
        response_format: { type: 'json_schema', json_schema: { name: 'local_assessment', strict: true, schema: localSchema() } }, max_tokens: 120, temperature: 0,
      }) });
      abortIfNeeded(callerSignal);
      if (controller.signal.aborted) return failure('timeout');
      if (!response.ok) return failure('network');
      const payload = await response.json();
      const content = payload?.choices?.[0]?.message?.content;
      const value = parse(typeof content === 'string' ? JSON.parse(content) : content);
      return { outcome: 'success', value, trace: { tier: 'local-model', remote_calls: 0, bytes_out: 0, cost: { known: true, usd: 0 } } };
    } catch (error) {
      abortIfNeeded(callerSignal);
      return failure(error?.name === 'AbortError' || error?.name === 'TimeoutError' ? 'timeout' : error?.message === 'malformed' || error instanceof SyntaxError ? 'malformed' : 'network');
    } finally { clearTimeout(timer); callerSignal?.removeEventListener('abort', abort); }
  }
}
