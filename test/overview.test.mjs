import { test } from 'node:test';
import assert from 'node:assert/strict';
import { growthBetween, yearlyGrowth } from '../js/server/overview.js';

const snap = (date, stock, total, created_at = `${date} 12:00:00`) => ({ date, created_at, stock_value_twd: stock, total });
const tx = (o) => ({ currency: 'TWD', fee: 0, tax: 0, created_at: '', ...o });

test('growthBetween: savings is what price and dividends do not explain', () => {
  const g = growthBetween(snap('2026-01-01', 1000, 3000), snap('2026-06-30', 1500, 3800), {
    trades: [
      tx({ action: 'BUY', shares: 10, price: 30, fee: 1, date: '2026-02-01' }), // 301 cash → stock
      tx({ action: 'SELL', shares: 1, price: 50, fee: 1, tax: 1, date: '2026-03-01' }), // 48 back
      tx({ action: 'BUY', shares: 1, price: 999, date: '2025-12-31' }), // before base
      tx({ action: 'BUY', shares: 1, price: 999, date: '2026-07-01' }), // after end
      tx({ currency: 'USD', action: 'BUY', shares: 1, price: 2, date: '2026-04-01' }), // 2 × 30
    ],
    dividends: [{ amount: 40, currency: 'TWD', date: '2026-05-01' }, { amount: 1, currency: 'USD', date: '2026-05-02' }],
    rate: 30,
  });
  const netBuys = 301 - 48 + 60;
  assert.deepEqual(g, {
    from: '2026-01-01', to: '2026-06-30', start: 3000, change: 800,
    price: 500 - netBuys, dividends: 70, savings: 800 - (500 - netBuys) - 70,
  });
});

test('yearlyGrowth: per-year bases, current year ends live, years without a change skipped', () => {
  const snaps = [ // newest first
    snap('2026-03-01', 0, 1300),
    snap('2025-12-31', 0, 1200),
    snap('2025-06-01', 0, 1000),
    snap('2023-05-01', 0, 500), // 2023 and 2024 have nothing to compare with
  ];
  const live = { date: '2026-11-06', stock_value_twd: 0, total: 1500 };
  const ys = yearlyGrowth(snaps, live, { trades: [], dividends: [], rate: 30 });
  assert.deepEqual(ys.map((y) => [y.year, y.from, y.to, y.change, y.partial, y.current]), [
    [2026, '2025-12-31', '2026-11-06', 300, false, true],
    [2025, '2023-05-01', '2025-12-31', 700, false, false],
  ]);
});

test('yearlyGrowth: a first year without a Jan 1 base starts at its first snapshot', () => {
  const ys = yearlyGrowth([snap('2026-05-01', 0, 900), snap('2026-02-01', 0, 800)],
    { date: '2026-11-06', stock_value_twd: 0, total: 1000 }, { trades: [], dividends: [], rate: 30 });
  assert.deepEqual(ys.map((y) => [y.year, y.from, y.change, y.partial]), [[2026, '2026-02-01', 200, true]]);
  assert.deepEqual(yearlyGrowth([], { date: '2026-11-06', total: 0 }, {}), []);
});
