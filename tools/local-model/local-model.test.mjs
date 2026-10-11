import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import { AnalysisCancelled, LocalModelAdapter } from './local-model.mjs';

async function fakeServer(responder) {
  const server = createServer(async (request, response) => {
    const body = await new Promise((resolve) => {
      let text = '';
      request.on('data', (chunk) => { text += chunk; });
      request.on('end', () => resolve(text));
    });
    await responder(request, response, body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve, reject) => { server.close((error) => error ? reject(error) : resolve()); server.closeAllConnections(); }),
  };
}

function respondJSON(response, value) {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
}

test('probes local capability and sends a thinking-disabled closed-schema request', async (t) => {
  const fixture = await fakeServer((request, response, body) => {
    if (request.url === '/health') return respondJSON(response, { status: 'ok' });
    assert.equal(request.url, '/v1/chat/completions');
    const payload = JSON.parse(body);
    assert.deepEqual(payload.chat_template_kwargs, { enable_thinking: false });
    assert.equal(payload.max_tokens, payload.messages[1].content === 'warm' ? 1 : 120);
    assert.equal(payload.messages[0].content, '/no_think');
    if (payload.messages[1].content !== 'warm') assert.equal(payload.response_format.json_schema.strict, true);
    respondJSON(response, { choices: [{ message: { content: JSON.stringify({ risk: 'high', reasons: ['support_pressure'], cue: 'Call-now support pressure.' }) } }] });
  });
  t.after(() => fixture.close());
  const adapter = new LocalModelAdapter({ baseUrl: fixture.baseUrl, model: 'qwen3-8b-q4_k_m.gguf' });
  assert.deepEqual(await adapter.capabilities(), { available: true, model: 'qwen3-8b-q4_k_m.gguf' });
  const result = await adapter.analyze({ text: 'call support now' });
  assert.equal(result.outcome, 'success');
  assert.equal(result.value.risk, 'high');
  assert.deepEqual(result.trace, { tier: 'local-model', remote_calls: 0, bytes_out: 0, cost: { known: true, usd: 0 } });
});

test('maps invalid outputs to malformed, including high risk with no reasons', async (t) => {
  const fixture = await fakeServer((_request, response) => respondJSON(response, {
    choices: [{ message: { content: JSON.stringify({ risk: 'high', reasons: [], cue: 'x' }) } }],
  }));
  t.after(() => fixture.close());
  const result = await new LocalModelAdapter({ baseUrl: fixture.baseUrl }).analyze({ text: 'x' });
  assert.equal(result.failureKind, 'malformed');
  assert.equal(result.trace.remote_calls, 0);
});

test('maps the local deadline to timeout and preserves caller cancellation', async (t) => {
  const fixture = await fakeServer(async (_request, response) => {
    await new Promise((resolve) => setTimeout(resolve, 40));
    respondJSON(response, { choices: [{ message: { content: '{}' } }] });
  });
  t.after(() => fixture.close());
  const adapter = new LocalModelAdapter({ baseUrl: fixture.baseUrl, timeoutMs: 5 });
  const timedOut = await adapter.analyze({ text: 'x' });
  assert.equal(timedOut.failureKind, 'timeout');

  const caller = new AbortController();
  caller.abort();
  await assert.rejects(adapter.analyze({ text: 'x' }, caller.signal), AnalysisCancelled);
});

test('opt-in integration reaches the approved local llama-server', {
  skip: process.env.LLAMA_INTEGRATION !== '1',
  timeout: 30_000,
}, async () => {
  const adapter = new LocalModelAdapter();
  const capability = await adapter.capabilities();
  assert.equal(capability.available, true);
  const result = await adapter.analyze({ text: 'A page says to call fake support now because the computer is infected.' });
  assert.equal(result.outcome, 'success');
  assert.ok(['low', 'medium', 'high'].includes(result.value.risk));
});
