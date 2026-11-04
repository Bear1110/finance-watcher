// /api/expenses/stats: per-month totals and category sums for the 收支 page,
// and /api/budgets built on the same monthly totals.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// db.js reads window.localStorage; give it an in-memory one.
const mem = new Map();
globalThis.window = {
  localStorage: {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
    removeItem: (k) => mem.delete(k),
  },
};

const db = await import('../js/server/db.js');
const { handle } = await import('../js/server/router.js');
await import('../js/server/expenses.js');

const exp = (id, date, type, amount, category, currency = 'TWD') =>
  ({ id, date, type, amount, category, currency, note: '', created_at: '' });

beforeEach(() => {
  mem.clear();
  db._reset({
    settings: [{ id: 1, key: 'usd_twd_rate', value: '30' }],
    budgets: [{ id: 1, year: 2026, month: 3, planned_income: 100000, planned_expense: 20000 }],
    expenses: [
      exp(1, '2025-12-31', 'expense', 999, '飲食'),
      exp(2, '2026-03-01', 'expense', 1000, '飲食'),
      exp(3, '2026-03-15', 'expense', 500, '飲料'),
      exp(4, '2026-03-20', 'expense', 10, '飲食', 'USD'),
      exp(5, '2026-03-05', 'income', 80000, '薪資'),
      exp(6, '2026-04-02', 'expense', 200, ''),
    ],
  });
});

test('stats: monthly totals, category sums (USD converted), planned expense', async () => {
  const s = await handle('/api/expenses/stats?year=2026');
  assert.equal(s.months.length, 12);
  const mar = s.months[2];
  assert.equal(mar.month, 3);
  assert.equal(mar.expense, 1000 + 500 + 300);
  assert.equal(mar.income, 80000);
  assert.equal(mar.planned_expense, 20000);
  assert.deepEqual(mar.by_category.expense, { 飲食: 1300, 飲料: 500 });
  assert.deepEqual(mar.by_category.income, { 薪資: 80000 });
  assert.deepEqual(s.months[3].by_category.expense, { '': 200 });
  assert.equal(s.months[0].expense, 0);
  assert.deepEqual(s.prev_december, { income: 0, expense: 999 });
});

test('foreign records count in TWD at their own rate; old USD rows without one use the current rate', async () => {
  db.insert('expenses', { date: '2026-05-01', type: 'expense', amount: 1000, currency: 'JPY', fx_rate: 0.2, category: '飲食', note: '' });
  db.insert('expenses', { date: '2026-05-02', type: 'expense', amount: 10, currency: 'USD', category: '飲食', note: '' });
  const s = await handle('/api/expenses/stats?year=2026');
  assert.equal(s.months[4].expense, 200 + 300);
  const list = await handle('/api/expenses');
  assert.deepEqual(list.filter((e) => e.date.startsWith('2026-05')).map((e) => e.amount_twd).sort(), [200, 300]);
});

test('a foreign record keeps the rate it was saved with; unsupported currencies are rejected', async () => {
  const post = (b) => handle('/api/expenses', { method: 'POST', body: JSON.stringify(b) });
  const r = await post({ type: 'expense', amount: 500, currency: 'JPY', fx_rate: 0.205, category: '飲食', date: '2026-06-01' });
  assert.equal(db.get('expenses', r.id).fx_rate, 0.205);
  await assert.rejects(post({ type: 'expense', amount: 5, currency: 'GBP', category: '飲食', date: '2026-06-01' }), (e) => e.status === 400);
});

test('budgets: actual columns come from the same monthly totals', async () => {
  const b = await handle('/api/budgets?year=2026');
  assert.equal(b.months[2].actual_expense, 1800);
  assert.equal(b.months[2].actual_income, 80000);
  assert.equal(b.months[2].planned_expense, 20000);
  assert.equal(b.months[3].actual_expense, 200);
});
