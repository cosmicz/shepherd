import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LocalHistory, type StoragePort } from '../src/adapters/history.ts';
import { analyzeText, toEvent } from '../src/domain/assessment.ts';

class MemoryStorage implements StoragePort {
  values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}
const event = (id: string) => toEvent(analyzeText('Garden newsletter: seedlings arrive tomorrow.', { frame_id: id, source: 'example' }), 'shown', id, '2026-10-11T12:00:00Z');

test('history caps retained entries and clear removes previously stored data', () => {
  const storage = new MemoryStorage();
  const history = new LocalHistory(storage);
  for (let i = 0; i < 105; i++) history.append(event(String(i)));
  assert.equal(history.list().length, 100);
  assert.equal(history.list()[0].id, '104');
  assert.equal(history.list().at(-1)?.id, '5');
  history.clear();
  assert.equal(history.list().length, 0);
  assert.equal(storage.values.size, 0);
});

test('stored records are validated and unknown fields are discarded', () => {
  const storage = new MemoryStorage();
  storage.setItem('shepherd.history.v1', JSON.stringify([{ ...event('valid'), screenshot: 'secret' }, { id: 'broken' }]));
  const history = new LocalHistory(storage);
  assert.equal(history.list().length, 1);
  assert.ok(!JSON.stringify(history.list()).includes('secret'));
});

test('storage failures are reported without replacing a live assessment', () => {
  const storage: StoragePort = { getItem: () => null, setItem: () => { throw Error('denied'); }, removeItem: () => {} };
  assert.throws(() => new LocalHistory(storage).append(event('1')), /history/i);
});
