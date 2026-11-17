// /api/expenses/stats: per-month totals and category sums for the 收支 page,

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

// Yahoo proxy (config.js has DEFAULT_YAHOO_PROXY): offline until a test sets fxOnline; JPY/TWD closes at 0.21.
let fxOnline = false;
globalThis.fetch = async (url) => {
  if (!fxOnline || !String(url).includes('JPYTWD')) return new Response('offline', { status: 503 });
  const ts = [Date.parse('2026-06-01T01:00:00Z') / 1000];
  return Response.json({ chart: { result: [{ meta: { gmtoffset: 0 }, timestamp: ts, indicators: { quote: [{ close: [0.21] }] } }], error: null } });
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

test('stats: monthly totals, category sums (USD converted)', async () => {
  const s = await handle('/api/expenses/stats?year=2026');
  assert.equal(s.months.length, 12);
  const mar = s.months[2];
  assert.equal(mar.month, 3);
  assert.equal(mar.expense, 1000 + 500 + 300);
  assert.equal(mar.income, 80000);
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

test('offline: a foreign record is saved at the last known rate (estimated), then fixed once online', async () => {
  const post = (url, b) => handle(url, { method: 'POST', body: JSON.stringify(b) });
  fxOnline = false;
  db.insert('expenses', { date: '2026-04-01', type: 'expense', amount: 100, currency: 'JPY', fx_rate: 0.2, category: '飲食', note: '' });
  const r = await post('/api/expenses', { type: 'expense', amount: 1000, currency: 'JPY', category: '飲食', date: '2026-06-02' });
  assert.deepEqual([db.get('expenses', r.id).fx_rate, db.get('expenses', r.id).fx_pending], [0.2, 1]);
  assert.equal((await handle('/api/expenses/stats?year=2026')).months[5].expense, 200);
  assert.deepEqual(await handle('/api/expenses/fx?currency=JPY&date=2026-06-02'), { rate: 0.2, date: '2026-04-01', estimated: true });
  // Nothing known for KRW: the user has to type a rate
  await assert.rejects(post('/api/expenses', { type: 'expense', amount: 5000, currency: 'KRW', category: '飲食', date: '2026-06-02' }), (e) => e.status === 400);

  fxOnline = true;
  assert.deepEqual(await post('/api/expenses/refresh-fx', {}), { updated: 1 });
  assert.deepEqual([db.get('expenses', r.id).fx_rate, db.get('expenses', r.id).fx_pending], [0.21, 0]);
  fxOnline = false;
});


test('POST /api/expenses/delete removes the chosen records', async () => {
  const r = await handle('/api/expenses/delete', { method: 'POST', body: JSON.stringify({ ids: [2, 5, 999] }) });
  assert.equal(r.deleted, 2);
  assert.deepEqual(db.all('expenses').map((e) => e.id), [1, 3, 4, 6]);
  await assert.rejects(handle('/api/expenses/delete', { method: 'POST', body: JSON.stringify({ ids: [] }) }), (e) => e.status === 400);
});

test('recentDays: 7 days up to today, oldest first; empty days have count 0; income counts', async () => {
  const { recentDays } = await import('../js/server/expenses.js');
  const rec = (date, type, amount_twd) => ({ date, type, amount_twd, category: '' });
  const days = recentDays([
    rec('2026-11-17', 'expense', 85), rec('2026-11-17', 'expense', 300),
    rec('2026-11-15', 'income', 50000),
    rec('2026-11-10', 'expense', 999), // 8 days ago: outside
    rec('2026-11-18', 'expense', 1),   // future: outside
  ], '2026-11-17');
  assert.deepEqual(days.map(d => d.date), ['2026-11-11', '2026-11-12', '2026-11-13', '2026-11-14', '2026-11-15', '2026-11-16', '2026-11-17']);
  const totals = ({ date, count, income, expense }) => ({ date, count, income, expense });
  assert.deepEqual(totals(days[6]), { date: '2026-11-17', count: 2, income: 0, expense: 385 });
  assert.deepEqual(days[6].records.map(e => e.amount_twd), [85, 300]); // the day's records, for the list under it
  assert.deepEqual(totals(days[4]), { date: '2026-11-15', count: 1, income: 50000, expense: 0 });
  assert.deepEqual([days[5].count, days[5].records], [0, []]);
  // Across a month / year boundary
  assert.deepEqual(recentDays([], '2027-01-02', 3).map(d => d.date), ['2026-12-31', '2027-01-01', '2027-01-02']);
});

test('#tags: ✕ hides a tag from the suggestions; a new record using it brings it back, editing an old one does not', async () => {
  const post = (url, b) => handle(url, { method: 'POST', body: JSON.stringify(b) });
  assert.deepEqual(await handle('/api/expenses/hidden-tags'), []);
  assert.deepEqual((await post('/api/expenses/hide-tag', { tag: '#舊專案A' })).hidden, ['#舊專案a']);
  await post('/api/expenses/hide-tag', { tag: '＃裝潢' }); // full-width ＃ counts
  assert.deepEqual(await handle('/api/expenses/hidden-tags'), ['#舊專案a', '#裝潢']);
  await assert.rejects(post('/api/expenses/hide-tag', { tag: '沒有井字號' }), (e) => e.status === 400);

  // Editing an old record that has the tag: still hidden
  await handle('/api/expenses/2', { method: 'PUT', body: JSON.stringify({ date: '2026-03-01', type: 'expense', amount: 1000, category: '飲食', note: '#裝潢 補記' }) });
  assert.deepEqual(await handle('/api/expenses/hidden-tags'), ['#舊專案a', '#裝潢']);
  // A new record with it (any spelling of the case): suggested again
  await post('/api/expenses', { date: '2026-06-01', type: 'expense', amount: 50, category: '飲食', note: '午餐 #舊專案A' });
  assert.deepEqual(await handle('/api/expenses/hidden-tags'), ['#裝潢']);
});
