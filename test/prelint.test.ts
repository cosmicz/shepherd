import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyzeText } from '../src/domain/assessment.ts';
import { decide } from '../src/domain/policy.ts';
import { speechKind } from '../src/domain/templates.ts';

const context = { frame_id: 'f', source: 'native' as const };

// remote_access stays weak but recognises named tools with an instruction.
test('named remote-access tools with an install/allow instruction raise weak remote_access', () => {
  for (const text of [
    'To fix your account, download AnyDesk now and read me the nine digit code.',
    'Please install TeamViewer QuickSupport so our technician can connect.',
    'Open UltraViewer and give me the ID and password to continue the refund.',
    'Allow screen share so the agent can verify your bank login.',
    'Go to logmein123 and enter the code I give you.',
  ]) assert.ok(analyzeText(text, context).reasons.includes('remote_access'), text);
});

test('ordinary mentions of remote tools raise nothing', () => {
  for (const text of [
    'IT newsletter: TeamViewer licences renew in March.',
    'Splashtop and ConnectWise compared: a review of remote desktop products.',
    'Never let a caller install AnyDesk on your computer.',
  ]) assert.ok(!analyzeText(text, context).reasons.includes('remote_access'), text);
});

test('remote_access is weak: needs local corroboration (row 7) and speaks cautiously', () => {
  assert.deepEqual(decide({ rules: { status: 'concern', reasons: ['remote_access'] } }), { kind: 'call-local' });
  const local = decide({ rules: { status: 'concern', reasons: ['remote_access'] }, local: { kind: 'result', risk: 'high', reasons: ['remote_access'] } });
  assert.equal((local as { row: string }).row, '7');
  const assessment = { ...analyzeText('Please install TeamViewer QuickSupport so our technician can connect.', context), route: 'local-model' as const,
    analyzer: { id: 'local-model' as const, kind: 'model' as const, model: 'q' }, policy_row: '7' as const };
  assert.equal(speechKind(assessment), 'suspicious');
});
