import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyzeText } from '../src/domain/assessment.ts';

const context = { frame_id: 'f', source: 'native' as const };
const flagged = (host: string) => analyzeText('Account center', context, { url: `https://${host}/login` }).reasons.includes('impersonation');

test('edit rule: confusables, transpositions, one dropped or doubled letter only', () => {
  for (const host of ['amaz0n.com', 'arnazon.com', 'gogle.com', 'paypa1.com', 'amzaon.com', 'gooogle.com', 'micro5oft.com', 'meclicare.com']) assert.ok(flagged(host), host);
  for (const host of ['phase.com', 'chasm.com', 'goggle.com', 'apple-pie-recipes.com']) assert.equal(flagged(host), false, host);
});

test('token rule: brand plus a suspicious second token, never on hosting platforms', () => {
  for (const host of ['apple-support-billing.com', 'apple.verify-id.net', 'paypal-login.net']) assert.ok(flagged(host), host);
  for (const host of ['paypal-community.com', 'google.github.io', 'microsoft-support.github.io', 'apple-support.wordpress.com']) assert.equal(flagged(host), false, host);
});

test('official-TLD rule for the ten demo brands', () => {
  for (const host of ['paypal.support', 'microsoft.help', 'amazon.gift', 'irs.info', 'apple.top']) assert.ok(flagged(host), host);
  for (const host of ['amazon.de', 'google.co.uk', 'apple.com', 'irs.gov', 'ssa.gov', 'support.microsoft.com']) assert.equal(flagged(host), false, host);
});

test('address bar only: page prose mentioning brand lookalikes raises nothing', () => {
  assert.deepEqual(analyzeText('Weekly digest\nScammers use sites like paypa1-login.com and amaz0n.com to trick people.', context).reasons, []);
  // An OCR'd address bar line (first line) still counts for pixel frames.
  assert.deepEqual(analyzeText('paypa1-login.com/verify\nWelcome back', context).reasons, ['impersonation']);
});
