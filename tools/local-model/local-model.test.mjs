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
    assert.equal(payload.max_tokens, payload.messages[1].content === 'warm' ? 1 : 128);
    if (payload.messages[1].content === 'warm') assert.equal(payload.messages[0].content, '/no_think');
    else {
      assert.match(payload.messages[0].content, /untrusted page content/);
      assert.match(payload.messages[0].content, /JSON only/);
      assert.equal(payload.max_tokens, 128);
      assert.equal(payload.response_format.json_schema.strict, true);
      assert.equal(payload.response_format.json_schema.schema.properties.cue.maxLength, 160);
      assert.equal(payload.response_format.json_schema.schema.properties.reasons.maxItems, 3);
    }
    respondJSON(response, { choices: [{ message: { content: JSON.stringify({ risk: 'high', reasons: ['support_pressure', 'support_pressure'], cue: 'call support now' }) } }] });
  });
  t.after(() => fixture.close());
  const adapter = new LocalModelAdapter({ baseUrl: fixture.baseUrl, model: 'qwen3-8b-q4_k_m.gguf' });
  assert.deepEqual(await adapter.capabilities(), { available: true, model: 'qwen3-8b-q4_k_m.gguf' });
  const result = await adapter.analyze({ text: 'call support now' });
  assert.equal(result.outcome, 'success');
  assert.equal(result.value.risk, 'high');
  assert.deepEqual(result.trace, { tier: 'local-model', remote_calls: 0, bytes_out: 0, cost: { known: true, usd: 0 } });
  assert.deepEqual(result.value.reasons, ['support_pressure']);
  assert.equal(result.value.cue, 'call support now');
  assert.equal(result.value.quote, 'call support now');
});

test('sets a paraphrased quote to null without discarding the model result', async (t) => {
  const fixture = await fakeServer((_request, response) => respondJSON(response, {
    choices: [{ message: { content: JSON.stringify({ risk: 'high', reasons: ['support_pressure'], cue: 'Call technical support' }) } }],
  }));
  t.after(() => fixture.close());
  const result = await new LocalModelAdapter({ baseUrl: fixture.baseUrl }).analyze({ text: 'Call support now' });
  assert.equal(result.outcome, 'success');
  assert.equal(result.value.cue, 'Call technical support');
  assert.equal(result.value.quote, null);
});

test('marks text over the model input cap as partial', async (t) => {
  const fixture = await fakeServer((_request, response) => respondJSON(response, {
    choices: [{ message: { content: JSON.stringify({ risk: 'low', reasons: [], cue: 'benign opening' }) } }],
  }));
  t.after(() => fixture.close());
  const result = await new LocalModelAdapter({ baseUrl: fixture.baseUrl }).analyze({ text: `benign opening ${'x'.repeat(4096)}` });
  assert.equal(result.outcome, 'success');
  assert.equal(result.value.partial, true);
});

test('maps invalid outputs to malformed, including high risk with no reasons or an empty quote', async (t) => {
  const fixture = await fakeServer((_request, response) => respondJSON(response, {
    choices: [{ message: { content: JSON.stringify({ risk: 'high', reasons: [], cue: '' }) } }],
  }));
  t.after(() => fixture.close());
  const result = await new LocalModelAdapter({ baseUrl: fixture.baseUrl }).analyze({ text: 'x' });
  assert.equal(result.failureKind, 'malformed');
  assert.equal(result.trace.remote_calls, 0);
});

test('v2.1 open category: other_concern needs a verbatim cue; unknown reasons are dropped', async (t) => {
  const text = 'Please verify your account by uploading a photo of your passport to keep your parking spot.';
  const replies = [
    { risk: 'high', reasons: ['other_concern'], cue: 'uploading a photo of your passport' },
    { risk: 'high', reasons: ['qr_parking_scam'], cue: 'uploading a photo of your passport' },
    { risk: 'high', reasons: ['other_concern'], cue: 'a photo of your driving licence' },
    { risk: 'high', reasons: ['qr_parking_scam'], cue: '' },
    { risk: 'medium', reasons: ['payment_pressure', 'qr_parking_scam'], cue: '' },
  ];
  let index = 0;
  const fixture = await fakeServer((_request, response, body) => {
    assert.ok(JSON.parse(body).response_format.json_schema.schema.properties.reasons.items.enum.includes('other_concern'));
    assert.match(JSON.parse(body).messages[0].content, /other_concern/);
    respondJSON(response, { choices: [{ message: { content: JSON.stringify(replies[index++]) } }] });
  });
  t.after(() => fixture.close());
  const adapter = new LocalModelAdapter({ baseUrl: fixture.baseUrl });
  const results = [];
  for (let i = 0; i < replies.length; i++) results.push(await adapter.analyze({ text }));
  assert.deepEqual(results.map((r) => r.outcome === 'success' ? r.value.reasons : r.failureKind), [
    ['other_concern'], ['other_concern'], 'malformed', 'malformed', ['payment_pressure'],
  ]);
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

test('does not follow redirects from the loopback model server', async (t) => {
  const fixture = await fakeServer((_request, response) => {
    response.writeHead(302, { location: 'http://127.0.0.1:1/elsewhere' });
    response.end();
  });
  t.after(() => fixture.close());
  const adapter = new LocalModelAdapter({ baseUrl: fixture.baseUrl });
  assert.deepEqual(await adapter.capabilities(), { available: false, model: 'qwen3-8b-q4_k_m.gguf' });
  const result = await adapter.analyze({ text: 'Call support now' });
  assert.equal(result.failureKind, 'network');
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
