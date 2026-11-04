// mergeTable: the sheet's rows plus this device's pending edits, last writer wins per row.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as db from '../js/server/db.js';

const exp = (id, amount, extra = {}) => ({ id, type: 'expense', amount, category: '飲食', date: '2026-01-01', ...extra });

test('remote rows are adopted; local edits and deletes win for their rows', () => {
  db._reset({ expenses: [exp(1, 100), exp(2, 200), exp(3, 300)] });
  db.update('expenses', 1, { amount: 111 });
  db.remove('expenses', 2);
  const taken = db.takePending();

  // Another device meanwhile added row 4 and changed row 3.
  const remote = [exp(1, 100), exp(2, 200), exp(3, 333), exp(4, 400)];
  const { toWrite: written, remoteDirty, localChanged } = db.mergeTable('expenses', remote, taken.expenses);
  assert.ok(remoteDirty);
  assert.ok(localChanged);

  const byId = Object.fromEntries(written.map((r) => [r.id, r.amount]));
  assert.deepEqual(byId, { 1: 111, 3: 333, 4: 400 });
  assert.deepEqual(db.all('expenses').map((r) => r.id).sort(), [1, 3, 4]);
});

test('edits made while a sync is in flight stay local and pending', () => {
  db._reset({ expenses: [exp(1, 100)] });
  const taken = db.takePending();
  db.insert('expenses', exp(9, 900));
  const { toWrite: written, remoteDirty } = db.mergeTable('expenses', [exp(1, 100)], taken.expenses);
  assert.deepEqual(written.map((r) => r.id), [1]);
  assert.equal(remoteDirty, false);
  assert.deepEqual(db.all('expenses').map((r) => r.id).sort(), [1, 9]);
  assert.ok(db.hasPending());
});

test('failed sync puts taken keys back', () => {
  db._reset({ expenses: [exp(1, 100)] });
  db.update('expenses', 1, { amount: 5 });
  const taken = db.takePending();
  assert.equal(db.hasPending(), false);
  db.restorePending(taken);
  assert.equal(db.pendingCount(), 1);
});

test('settings merge by key and holdings by symbol', () => {
  db._reset({ settings: [{ id: 1, key: 'usd_twd_rate', value: '32' }] });
  db.setSetting('usd_twd_rate', '31.5');
  const taken = db.takePending();
  const remote = [{ id: 77, key: 'usd_twd_rate', value: '32' }, { id: 78, key: 'perf_start_date', value: '2025-01-01' }, { id: 79, key: 'gemini_api_key', value: 'typed-into-sheet' }];
  const { toWrite } = db.mergeTable('settings', remote, taken.settings);
  // Device-local keys never come in from the sheet.
  assert.deepEqual(Object.fromEntries(toWrite.map((r) => [r.key, r.value])), { usd_twd_rate: '31.5', perf_start_date: '2025-01-01' });
});

test('unchanged tables are neither written nor reported as changed', () => {
  db._reset({ expenses: [exp(1, 100)] });
  db.takePending();
  const m = db.mergeTable('expenses', [{ ...exp(1, 100), amount: '100' }], undefined);
  assert.equal(m.remoteDirty, false);
  assert.equal(m.localChanged, false);
});

test('pending edits of a retired table (budgets) left in localStorage are dropped on load', () => {
  const mem = new Map([['fw.pending.v1', JSON.stringify({ budgets: { up: ['2026-3'] }, expenses: { up: ['1'] } })]]);
  globalThis.window = { localStorage: { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v), removeItem: (k) => mem.delete(k) } };
  try {
    db.load();
    assert.equal(db.pendingCount(), 1); // only the expenses edit; nothing would ever sync the budgets one
  } finally {
    delete globalThis.window;
    db._reset({});
  }
});
