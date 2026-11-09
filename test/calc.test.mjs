// Typed sums in money fields (資產快照 的現金): util.js calcExpr, and the snapshot API using it.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const mem = new Map();
globalThis.window = { localStorage: { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) } };
const db = await import('../js/server/db.js');
const { calcExpr } = await import('../js/server/util.js');
const { handle } = await import('../js/server/router.js');
await import('../js/server/assets.js');

test('calcExpr: + − × ÷ with × ÷ first, no brackets', () => {
  assert.equal(calcExpr('1+23+444+5'), 473);
  assert.equal(calcExpr('100-2*30/4'), 85);
  assert.equal(calcExpr('120,000 + 35000'), 155000);
  assert.equal(calcExpr('0.1+0.2'), 0.3);
  assert.equal(calcExpr('-5+10'), 5);
  assert.equal(calcExpr('１２０＋３０'), 150); // 全形
  assert.equal(calcExpr('3×4÷2'), 6);
  assert.equal(calcExpr('2500.5'), 2500.5);
  assert.equal(calcExpr(1200), 1200);
});

test('calcExpr: null when it is not a sum', () => {
  for (const s of ['', '  ', '1+', '+1', '1++2', '(1+2)', 'abc', '1/0', '1e5', null, undefined]) assert.equal(calcExpr(s), null, String(s));
});

test('snapshot API: cash typed as a sum is saved as its result; an unreadable one is refused', async () => {
  db._reset({});
  const snap = (cash) => handle('/api/assets', { method: 'POST', body: JSON.stringify({
    date: '2026-01-31', cash_twd: cash, cash_usd: '100+50', stock_tw_value: 1, stock_value_twd: 1, usd_twd_rate: 30 }) });
  const r = await snap('120000+35000-2*500');
  assert.equal(r.cash_twd, 154000);
  assert.equal(r.cash_usd, 150);
  await assert.rejects(snap('12++3'), /看不懂/);
});
