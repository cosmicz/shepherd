import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decide, type Decision, type LocalView, type PolicyInput } from '../src/domain/policy.ts';

// One case per row of the contract v2 routing table. Row 19 (abort)
// is the composite's AnalysisCancelled path and is tested there.
const open = { grant: true, provider: true, budget: true };
const strong = { status: 'concern', reasons: ['support_pressure'] } as const;
const weak = { status: 'concern', reasons: ['payment_pressure'] } as const;
const twoWeak = { status: 'concern', reasons: ['payment_pressure', 'impersonation'] } as const;
const none = { status: 'no_signal', reasons: [] } as const;
const failedLocal = { kind: 'failed', failure_kind: 'unavailable' } as const;
const local = (risk: 'low' | 'medium' | 'high'): LocalView => ({ kind: 'result', risk, reasons: risk === 'low' ? [] : ['payment_pressure'] });
const verdict = (value: 'scam' | 'suspicious' | 'benign' | 'unclear') => ({ kind: 'verdict', verdict: value, reasons: [], pattern: 'other' }) as const;

const rows: Array<[string, PolicyInput, Decision]> = [
  ['1', { rules: { status: 'unavailable', reasons: [] } }, { kind: 'final', row: '1', status: 'unavailable', route: 'local', message: 'default' }],
  ['2', { rules: { status: 'inconclusive', reasons: [] } }, { kind: 'final', row: '2', status: 'inconclusive', route: 'local', message: 'default' }],
  ['3', { rules: strong }, { kind: 'final', row: '3', status: 'concern', route: 'local', message: 'default' }],
  ['local first (weak)', { rules: weak }, { kind: 'call-local' }],
  ['local first (no_signal)', { rules: none }, { kind: 'call-local' }],
  ['4', { rules: weak, local: failedLocal, gate: open }, { kind: 'call-cloud', row: '4' }],
  ['5', { rules: weak, local: failedLocal, gate: { ...open, grant: false } }, { kind: 'final', row: '5', status: 'inconclusive', route: 'local', message: 'evidence', skipped: 'no_consent' }],
  ['6', { rules: none, local: { kind: 'failed', failure_kind: 'malformed' }, gate: open }, { kind: 'final', row: '6', status: 'inconclusive', route: 'local', message: 'default' }],
  ['7', { rules: weak, local: local('high'), gate: open }, { kind: 'final', row: '7', status: 'concern', route: 'local-model', message: 'default' }],
  ['8', { rules: weak, local: local('medium'), gate: open }, { kind: 'call-cloud', row: '8' }],
  ['9', { rules: weak, local: local('medium'), gate: { ...open, grant: false } }, { kind: 'final', row: '9', status: 'inconclusive', route: 'local-model', message: 'caution', skipped: 'no_consent' }],
  ['10', { rules: weak, local: local('low'), gate: open }, { kind: 'call-cloud', row: '10' }],
  ['11', { rules: weak, local: local('low'), gate: { ...open, grant: false } }, { kind: 'final', row: '11', status: 'inconclusive', route: 'local-model', message: 'evidence', skipped: 'no_consent' }],
  ['12', { rules: none, local: local('medium'), gate: open }, { kind: 'call-cloud', row: '12' }],
  ['12 (high)', { rules: none, local: local('high'), gate: open }, { kind: 'call-cloud', row: '12' }],
  ['12b', { rules: none, local: local('high'), gate: { ...open, grant: false } }, { kind: 'final', row: '12b', status: 'inconclusive', route: 'local-model', message: 'default', skipped: 'no_consent' }],
  ['12c', { rules: none, local: local('low'), gate: open }, { kind: 'final', row: '12c', status: 'no_signal', route: 'local-model', message: 'default' }],
  ['13', { rules: none, local: local('medium'), gate: open, cloud: verdict('scam') }, { kind: 'final', row: '13', status: 'concern', route: 'cloud', message: 'scam' }],
  ['14', { rules: weak, local: local('medium'), gate: open, cloud: verdict('suspicious') }, { kind: 'final', row: '14', status: 'concern', route: 'cloud', message: 'caution' }],
  ['15 (R no_signal)', { rules: none, local: local('high'), gate: open, cloud: verdict('benign') }, { kind: 'final', row: '15', status: 'no_signal', route: 'cloud', message: 'default' }],
  ['15 (R weak)', { rules: weak, local: local('low'), gate: open, cloud: verdict('benign') }, { kind: 'final', row: '15', status: 'inconclusive', route: 'cloud', message: 'default' }],
  ['16', { rules: weak, local: local('medium'), gate: open, cloud: verdict('unclear') }, { kind: 'final', row: '16', status: 'inconclusive', route: 'cloud', message: 'default' }],
  ['17', { rules: none, local: local('medium'), gate: open, cloud: { kind: 'failed', failure_kind: 'refusal' } }, { kind: 'final', row: '17', status: 'inconclusive', route: 'cloud', message: 'default' }],
  // Row 18: the gate is checked in contract order G, P, B; the outcome is the no-consent row.
  ['18 provider', { rules: weak, local: local('medium'), gate: { ...open, provider: false } }, { kind: 'final', row: '9', status: 'inconclusive', route: 'local-model', message: 'caution', skipped: 'unavailable' }],
  ['18 budget', { rules: none, local: local('medium'), gate: { ...open, budget: false } }, { kind: 'final', row: '12b', status: 'inconclusive', route: 'local-model', message: 'default', skipped: 'budget' }],
  ['18 grant first', { rules: weak, local: failedLocal, gate: { grant: false, provider: false, budget: false } }, { kind: 'final', row: '5', status: 'inconclusive', route: 'local', message: 'evidence', skipped: 'no_consent' }],
];

for (const [name, input, expected] of rows) {
  test(`routing row ${name}`, () => { assert.deepEqual(decide(input), expected); });
}

test('two weak reasons stay weak: never a local concern without the model', () => {
  assert.deepEqual(decide({ rules: twoWeak }), { kind: 'call-local' });
  assert.equal((decide({ rules: twoWeak, local: local('low'), gate: { ...open, grant: false } }) as { status: string }).status, 'inconclusive');
});

test('a weak rules concern is never downgraded to no_signal, whatever the later tiers say', () => {
  for (const cloud of [verdict('benign'), verdict('unclear'), { kind: 'failed', failure_kind: 'timeout' } as const]) {
    for (const risk of ['low', 'medium'] as const) {
      const decision = decide({ rules: weak, local: local(risk), gate: open, cloud });
      assert.equal(decision.kind, 'final');
      assert.notEqual((decision as { status: string }).status, 'no_signal');
    }
  }
});

test('the table is total: every combination yields exactly one decision', () => {
  const rulesValues = [{ status: 'unavailable', reasons: [] }, { status: 'inconclusive', reasons: [] }, strong, weak, none] as const;
  const localValues = [undefined, failedLocal, local('low'), local('medium'), local('high')];
  const gates = [undefined, open, { ...open, grant: false }, { ...open, provider: false }, { ...open, budget: false }];
  const clouds = [undefined, verdict('scam'), verdict('suspicious'), verdict('benign'), verdict('unclear'), { kind: 'failed', failure_kind: 'network' } as const];
  for (const rules of rulesValues) for (const localResult of localValues) for (const gate of gates) for (const cloud of clouds) {
    const decision = decide({ rules: { ...rules, reasons: [...rules.reasons] }, local: localResult, gate, cloud } as PolicyInput);
    assert.ok(['final', 'call-local', 'call-cloud'].includes(decision.kind));
  }
});
