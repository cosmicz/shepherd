import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyzeText } from '../src/domain/assessment.ts';
import { lookalikeHosts, normalizeConfusables } from '../src/domain/rules.ts';

const context = { frame_id: 'f', source: 'native' as const };
const reasons = (text: string, options?: Parameters<typeof analyzeText>[2]) => analyzeText(text, context, options).reasons;

// Strong reason: claim and call-now in one 200-character window, neither negated.
test('support popup wording is a strong support_pressure match', () => {
  assert.deepEqual(reasons('Your computer has been blocked. Your computer is infected with 3 viruses. Call Support immediately to unlock your computer.'), ['support_pressure']);
  // Negation in an earlier, separate sentence does not cancel the instruction.
  assert.deepEqual(reasons('Your computer is infected. Do not restart or close this window, or your files may be lost. Call support now.'), ['support_pressure']);
});

test('the fyv v2 hard-benign counterexample and other negations never match', () => {
  assert.deepEqual(reasons('The one rule to remember: if your computer says it is infected, do not call the number on the screen.'), []);
  assert.deepEqual(reasons('If your computer says it is infected, do not call support now. Close the tab.'), []);
  assert.deepEqual(reasons('If your computer says it is infected, never call support immediately.'), []);
  assert.deepEqual(reasons('Your computer is not infected. Call support now if you need help with billing.'), []);
});

// the team F-FIXTURE: the counterexample is only meaningful if its un-negated
// form matches; "call the number on the screen" is itself a scam instruction.
test('the counterexample is non-vacuous: without the negation it is a strong match', () => {
  assert.deepEqual(reasons('If your computer says it is infected, call the number on the screen.'), ['support_pressure']);
  assert.deepEqual(reasons('If your computer says it is infected, do not call the number on the screen.'), []);
  assert.deepEqual(reasons('Your computer is infected. Do not call support now.'), [], 'the team F-SUPPORT');
});

test('claim and instruction more than 200 characters apart do not pair', () => {
  const filler = 'Weekly bulletin and community events calendar for residents of the neighborhood. '.repeat(3);
  assert.ok(filler.length > 200);
  assert.deepEqual(reasons(`Your computer is infected with spyware according to this article. ${filler} Call support now for a free appointment.`), []);
});

// the witnesses: navigation chrome must not pair a trigger with an
// urgency word from another line.
test('benign navigation text does not raise payment_pressure (08s)', () => {
  const retail = 'Deals Registry Buy Again Gift Cards Customer Service Sell\nKitchen mixer\nAdd to Cart\nBuy Now';
  const weather = 'Weather San Francisco 64 F Sunny\nNews Markets rally as rates hold\nSubscribe now\nSend gift cards to friends this holiday';
  const bank = 'Accounts Bill pay Gift cards Rewards Help\nOpen a savings account now and earn 4.6 percent';
  for (const text of [retail, weather, bank]) assert.equal(analyzeText(text, context).status, 'no_signal', text);
});

// the team: instruction form + urgency + threat/consequence cue in one window.
test('hard-benign commerce and newsletter pages raise nothing (08s fixtures)', () => {
  const giftCardProduct = 'Gift Cards\nBuy a gift card for any occasion. Send it by email in minutes.\nOrder now for delivery today\nAdd to cart\nBuy now';
  const newsletter = 'Stay in the loop\nSubscribe now and get 10% off. Send our gift cards to friends this holiday.\nEnter your email address\nSign up';
  for (const text of [giftCardProduct, newsletter]) assert.equal(analyzeText(text, context).status, 'no_signal', text);
});

test('an instruction with urgency but no threat or consequence cue is not pressure', () => {
  assert.deepEqual(reasons('Please buy gift cards now and send them to your nieces.'), []);
});

test('real pressure still matches, including a trigger wrapped across OCR lines', () => {
  assert.deepEqual(reasons('The court only takes gift cards for bail on weekends. Please buy\ngift cards at the pharmacy now and text me the numbers on the\nback.'), ['payment_pressure']);
  assert.deepEqual(reasons('Pay immediately using gift cards to prevent your account closing.'), ['payment_pressure']);
  assert.deepEqual(reasons('Security notice\nEnter your password immediately to keep access'), ['credential_pressure']);
  assert.deepEqual(reasons('Medicare will never ask you to\npay with gift cards.'), []);
});

// Lookalike-domain rule: weak impersonation, an OCR indicator, never authentication.
test('confusable normalization covers digits, letter pairs and Unicode lookalikes', () => {
  assert.equal(normalizeConfusables('micros0ft'), 'microsoft');
  assert.equal(normalizeConfusables('microsOft'), 'microsoft');
  assert.equal(normalizeConfusables('app1e'), 'apple');
  assert.equal(normalizeConfusables('pay5afe'), 'paysafe');
  assert.equal(normalizeConfusables('rnicrosoft'), 'microsoft');
  assert.equal(normalizeConfusables('vvellsfargo'), 'wellsfargo');
  assert.equal(normalizeConfusables('аpple'), 'apple'); // Cyrillic а
});

test('brand lookalikes in text or URL yield impersonation; official and allowlisted hosts do not', () => {
  assert.deepEqual(lookalikeHosts('Visit microsOft-support.com to restore access'), ['microsOft-support.com']);
  assert.deepEqual(reasons('Sign in at rnicrosoft.com/account'), ['impersonation']);
  assert.deepEqual(reasons('Alert', { url: 'https://apple.com-security-alert.help/fix' }), ['impersonation']);
  assert.deepEqual(reasons('Read more at support.microsoft.com and news.apple.com'), []);
  assert.deepEqual(reasons('Your statement from mybank-chase.example is ready', { allowlist: ['mybank-chase.example'] }), []);
  assert.deepEqual(reasons('Weekly forecast', { url: 'https://weather.localhost:8099/' }), []);
  const result = analyzeText('Verify at paypa1-billing.com today', context);
  assert.equal(result.status, 'concern');
  assert.match(result.evidence[0], /paypa1-billing\.com/);
});
