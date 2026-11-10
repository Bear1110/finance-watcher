// Typed sums in money fields (資產快照 的現金): amount.js calcInfo / calcExpr, and the snapshot API using it.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const mem = new Map();
globalThis.window = { localStorage: { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) } };
const db = await import('../js/server/db.js');
const { calcExpr, calcInfo } = await import('../js/server/amount.js');
const { handle } = await import('../js/server/router.js');
await import('../js/server/assets.js');

test('calcExpr: + − × ÷ with × ÷ first, no brackets', () => {
  assert.equal(calcExpr('1+23+444+5'), 473);
  assert.equal(calcExpr('100-2*30/4'), 85);
  assert.equal(calcExpr('120,000 + 35,000'), 155000);
  assert.equal(calcExpr('0.1+0.2'), 0.3);
  assert.equal(calcExpr('100-200'), -100); // the caller decides whether negatives are allowed
  assert.equal(calcExpr('１２０＋３０'), 150); // 全形
  assert.equal(calcExpr('3×4÷2'), 6);
  assert.equal(calcExpr('2500.5'), 2500.5);
  assert.equal(calcExpr('0.5'), 0.5);
  assert.equal(calcExpr('NT$ 120,000 + 500元'), 120500);
  assert.equal(calcExpr('-500'), -500); // an old negative balance being edited
  assert.equal(calcExpr('-5+10'), 5);
  assert.equal(calcExpr(1200), 1200);
});

test('calcExpr: null when it is not a sum', () => {
  for (const s of ['', '  ', '1+', '+1', '--5', '1+-2', '120000 35000', '12 000', '１２０　３０', '1++2', '(1+2)', 'abc', '1/0', '1e5', '1e-7',
    '350,5', '1,2345', '2026-01', '012-345', '2026/01/05', null, undefined]) assert.equal(calcExpr(s), null, String(s));
});

test('calcInfo: whether it is a sum (show the result) and whether the next term is still being typed', () => {
  assert.deepEqual(calcInfo('120000 + 35000'), { value: 155000, sum: true, open: false });
  assert.deepEqual(calcInfo('１２０＋３０'), { value: 150, sum: true, open: false });
  assert.deepEqual(calcInfo('120,000'), { value: 120000, sum: false, open: false });
  assert.deepEqual(calcInfo('120000＋ '), { value: null, sum: false, open: true });
});

test('snapshot API: cash typed as a sum is saved as its result; unreadable or negative cash is refused', async () => {
  db._reset({});
  const snap = (cash, extra = {}) => handle('/api/assets', { method: 'POST', body: JSON.stringify({
    date: '2026-01-31', cash_twd: cash, cash_usd: '100+50', stock_tw_value: 1, stock_value_twd: 1, usd_twd_rate: 30, ...extra }) });
  const r = await snap('120000+35000-2*500');
  assert.equal(r.cash_twd, 154000);
  assert.equal(r.cash_usd, 150);
  await assert.rejects(snap('12++3'), /看不懂/);
  await assert.rejects(snap('100-5000'), /負數/);
  await assert.rejects(snap('-5000'), /負數/);
  // the other fields are plain numbers, as before: no sums, no rounding, exponents fine
  const m = await snap('1', { usd_twd_rate: 1e-7, total_asset: 1e21 });
  assert.equal(m.usd_twd_rate, 1e-7);
  assert.equal(m.total_asset, 1e21);
});

test('snapshot API: editing keeps an old negative cash balance and a stored 0 stock value / rate', async (t) => {
  db._reset({});
  // a trade, and no way to get that day's prices (offline): the stock value can't be looked up
  db.insert('stock_transactions', { symbol: '2330.TW', market: 'TW', action: 'BUY', shares: 1000, price: 500, date: '2024-06-03' });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('offline'); };
  t.after(() => { globalThis.fetch = realFetch; });
  const id = db.insert('asset_snapshots', { date: '2025-01-31', cash_twd: 100, cash_usd: -500, stock_tw_value: 0, stock_us_value: 0,
    stock_value_twd: 0, usd_twd_rate: 30, total_asset: 0, note: '' }).id;
  const edit = (extra) => handle(`/api/assets/${id}`, { method: 'PUT', body: JSON.stringify({
    date: '2025-01-31', cash_twd: '100', cash_usd: '-500', stock_tw_value: 0, stock_us_value: 0, stock_value_twd: 0, usd_twd_rate: 30, note: '改備註', ...extra }) });
  await edit(); // no prices needed: the stored 0 stock value is kept
  const row = db.get('asset_snapshots', id);
  assert.equal(row.note, '改備註');
  assert.equal(row.cash_usd, -500);
  assert.equal(row.stock_value_twd, 0);
  await assert.rejects(edit({ cash_usd: '-600' }), /負數/); // a new negative is still refused
});
