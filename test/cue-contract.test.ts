// One verbatim-cue contract (r81 post-merge, the team 14:48): after whitespace
// normalisation the cue is 8 to 160 characters and a substring of the frame text
// within the 4,096-character window the local model saw. The tea adapter, the
// bridge and routing must give identical outcomes on every boundary.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LocalModelAdapter } from '../tools/local-model/local-model.mjs';
import { LlamaLocalModel } from '../src/adapters/llama-local.ts';
import { RoutedAnalyzer } from '../src/application/routing.ts';
import { analyzeText, type TextFrame } from '../src/domain/assessment.ts';
import { CUE_MAX, CUE_MIN, CUE_WINDOW, verbatimCue } from '../src/domain/cue.ts';

// Neutral words, so the rules find nothing and only the cue decides.
const words = 'garden tomato compost workshop saturday newsletter seedling trellis mulch harvest basil pepper ';
const page = words.repeat(4).trim();
const slice = (length: number) => page.slice(0, length);
// The same words with irregular whitespace on the page: a collapsed cue still matches.
const spaced = 'garden  tomato\n\tcompost   workshop\nsaturday newsletter';
// A phrase that appears only after the 4,096-character window.
const late = 'lantern orchard quietly ripening';
const beyond = `${words.repeat(Math.ceil(4200 / words.length))}${late}`;

const cases: Array<[string, string, string, boolean]> = [
  ['7 chars', page, slice(7), false],
  ['8 chars', page, slice(8), true],
  ['80 chars', page, slice(80), true],
  ['121 chars', page, slice(121), true],
  ['160 chars', page, slice(160), true],
  ['161 chars', page, slice(161), false],
  ['collapsed whitespace', spaced, 'garden tomato compost workshop saturday', true],
  ['raw cue over 160 that normalises inside the bound', page, slice(150).replace(/ /g, '   '), true],
  ['beyond the 4,096 window', beyond, late, false],
];

const reply = (cue: string) => (async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ risk: 'high', reasons: ['other_concern'], cue }) } }] }), { status: 200 })) as unknown as typeof fetch;
const frame = (text: string): TextFrame => ({ frame_id: `cue-${Math.random()}`, source: 'native', text, captured_at: '2026-10-11T14:50:00Z' });

test('the bounds are the contract values', () => {
  assert.deepEqual([CUE_MIN, CUE_MAX, CUE_WINDOW], [8, 160, 4096]);
});

for (const [name, text, cue, valid] of cases) {
  test(`cue ${name}: shared validator, adapter, bridge and routing agree (${valid ? 'valid' : 'invalid'})`, async () => {
    assert.equal(analyzeText(text, { frame_id: 'x', source: 'native' }).status, 'no_signal', 'fixture must not match a rule');
    assert.equal(verbatimCue(text, cue) !== undefined, valid, 'shared validator');
    const adapted = await new LocalModelAdapter({ fetchImpl: reply(cue) }).analyze({ text });
    assert.deepEqual(adapted.outcome === 'success' ? adapted.value.reasons : adapted.failureKind, valid ? ['other_concern'] : 'malformed', 'adapter');
    const bridged = new LlamaLocalModel({ fetchImpl: reply(cue) });
    if (valid) assert.deepEqual(((await bridged.assess(text, new AbortController().signal)) as { reasons: string[] }).reasons, ['other_concern'], 'bridge');
    else await assert.rejects(bridged.assess(text, new AbortController().signal), /malformed/, 'bridge');
    const routed = await new RoutedAnalyzer({ extractor: { extract: async (f) => ('text' in f ? f.text : '') }, local: new LlamaLocalModel({ fetchImpl: reply(cue) }) }).analyze(frame(text), new AbortController().signal);
    assert.deepEqual([routed.policy_row, routed.status], valid ? ['12d', 'inconclusive'] : ['6', 'inconclusive'], 'routing via the bridge');
    // Routing alone, over a port that skips the adapter's own check.
    const direct = await new RoutedAnalyzer({ extractor: { extract: async (f) => ('text' in f ? f.text : '') },
      local: { model: 'fake', available: async () => true, assess: async () => ({ risk: 'high', reasons: ['other_concern'], cue }) } }).analyze(frame(text), new AbortController().signal);
    assert.deepEqual([direct.policy_row, direct.status], valid ? ['12d', 'inconclusive'] : ['6', 'inconclusive'], 'routing directly');
  });
}

test('a long cue with known reasons is not malformed; it is simply not a verbatim cue', async () => {
  const cue = 'x'.repeat(300);
  const routed = await new RoutedAnalyzer({ extractor: { extract: async (f) => ('text' in f ? f.text : '') },
    local: { model: 'fake', available: async () => true, assess: async () => ({ risk: 'high', reasons: ['payment_pressure'], cue }) } }).analyze(frame(page), new AbortController().signal);
  assert.deepEqual([routed.policy_row, routed.status], ['12b', 'inconclusive']);
});
