import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyzeText } from '../src/domain/assessment.ts';

const context = { frame_id: 'frame-1', source: 'example' as const };
const head = 'Garden club minutes. Tomatoes did well this year and the compost bin needs a new lid. ';

test('evidence is the matched span, not the head of the screen (F4)', () => {
  const result = analyzeText(`${head}Your computer is infected with a virus. Call support immediately at the number below.`, context);
  assert.deepEqual(result.reasons, ['support_pressure']);
  assert.equal(result.evidence.length, 1);
  assert.match(result.evidence[0], /computer is infected/);
  assert.match(result.evidence[0], /Call support immediately/);
  assert.ok(!result.evidence[0].includes('Garden'), 'unrelated head text is not evidence');
});

test('each reason contributes its own matched clause', () => {
  const text = `${head}Your account will suspend today. Buy gift cards now and send the codes. Enter your password immediately to keep access.`;
  const result = analyzeText(text, context);
  assert.deepEqual(result.reasons, ['payment_pressure', 'credential_pressure']);
  assert.equal(result.evidence.length, 2);
  assert.match(result.evidence[0], /Buy gift cards now/);
  assert.match(result.evidence[1], /Enter your password immediately/);
  for (const item of result.evidence) assert.ok(!item.includes('Garden') && item.length <= 512);
});

test('no reason means no evidence', () => {
  assert.deepEqual(analyzeText(`${head}Never pay with gift cards.`, context).evidence, []);
});

// the witness: OCR of UI text has no sentence punctuation, so a clause can
// be the whole screen. Evidence must still be a window around the trigger.
const banking = Array.from({ length: 8 }, (_, i) => `Inbox ${i + 3} Weather Checking 44${i}7 balance 23${i}0 Savings 99${i}1 Transfers Statements`).join('\n');

test('unpunctuated payment trigger yields a window around the match, not the screen head', () => {
  assert.ok(banking.length > 512);
  const result = analyzeText(`${banking}\nYour account will be closed\nBuy gift cards now to prevent closing`, context);
  assert.deepEqual(result.reasons, ['payment_pressure']);
  assert.match(result.evidence[0], /Buy gift cards now/);
  for (const fragment of ['Inbox', 'Checking', 'balance', 'Savings', 'Statements']) assert.ok(!result.evidence[0].includes(fragment), fragment);
  assert.ok(result.evidence[0].length <= 200);
});

test('unpunctuated credential trigger yields a window around the match', () => {
  const result = analyzeText(`${banking}\nSecurity notice\nEnter your password immediately to keep access`, context);
  assert.deepEqual(result.reasons, ['credential_pressure']);
  assert.match(result.evidence[0], /Enter your password immediately/);
  for (const fragment of ['Inbox', 'Checking', 'balance', 'Savings', 'Statements']) assert.ok(!result.evidence[0].includes(fragment), fragment);
});
