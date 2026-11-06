import { test } from 'node:test';
import assert from 'node:assert/strict';
import { growthBetween, yearlyGrowth, monthSummary, avgMonthlyExpense, fireStats, buildAlerts } from '../js/server/overview.js';

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

const ex = (date, amount, category = '餐飲', type = 'expense') => ({ date, amount_twd: amount, category, type });

test('monthSummary: month to date vs the same days last month, clamped to its length', () => {
  const m = monthSummary([
    ex('2026-03-01', 100), ex('2026-03-02', 50, '交通'), ex('2026-03-03', 300, '購物'), ex('2026-03-02', 1000, '薪資', 'income'),
    ex('2026-02-28', 70), ex('2026-02-27', 30), ex('2026-02-10', 5), ex('2026-03-31', 999), // future: not counted
  ], '2026-03-30');
  assert.equal(m.expense, 450);
  assert.equal(m.income, 1000);
  assert.equal(m.prev_to, '2026-02-28');
  assert.equal(m.prev_expense, 105);
  assert.deepEqual(m.top.map((t) => t.category), ['購物', '餐飲', '交通']);
  assert.equal(m.last_record, '2026-03-31');
  assert.equal(monthSummary([], '2026-01-15').prev_from, '2025-12-01');
});

test('avgMonthlyExpense: full months only, since records began', () => {
  const rows = [ex('2026-08-15', 3000), ex('2026-09-01', 6000), ex('2026-10-31', 3000), ex('2026-11-02', 99999), ex('2026-10-01', 500, '薪資', 'income')];
  assert.equal(avgMonthlyExpense(rows, '2026-11-06', 12), 4000); // Aug–Oct
  assert.equal(avgMonthlyExpense(rows, '2026-11-06', 2), 4500); // Sep–Oct
  assert.equal(avgMonthlyExpense([ex('2026-11-01', 10)], '2026-11-06', 12), null); // only this month
  assert.equal(avgMonthlyExpense([], '2026-11-06', 12), null);
});

test('fireStats: setting wins over records, 4% default, dividends and cash coverage', () => {
  const f = fireStats({ netWorth: 6_000_000, cashTWD: 300_000, setting: 50_000, recorded: 40_000, withdrawRate: 0, dividendsTTM: 60_000 });
  assert.equal(f.source, 'setting');
  assert.equal(f.target, 15_000_000);
  assert.equal(f.progress, 40);
  assert.equal(f.dividend_cover, 10);
  assert.equal(f.cash_months, 6);
  const r = fireStats({ netWorth: 1, cashTWD: null, setting: 0, recorded: 40_000, withdrawRate: 3.5, dividendsTTM: 0 });
  assert.equal(r.source, 'records');
  assert.ok(Math.abs(r.target - 40_000 * 12 / 0.035) < 1e-6);
  assert.equal(r.cash_months, null);
  assert.deepEqual(fireStats({ netWorth: 1, setting: 0, recorded: null, withdrawRate: 0 }),
    { monthly_expense: null, source: null, recorded_monthly_expense: null, withdraw_rate: 4 });
});

test('buildAlerts: no snapshot, concentration, low cash, stale 收支 and liabilities', () => {
  const a = buildAlerts({
    today: '2026-11-06',
    latestSnapshot: null,
    topHolding: { symbol: '0050.TW', weight: 42, level: 'danger' },
    fire: { cash_months: 2.1 },
    month: { last_record: '2026-10-01' },
    liabilities: [{ name: '房貸', updated: '2026-01-01' }, { name: '車貸', updated: '2026-10-01' }],
  });
  assert.deepEqual(a.map((x) => x.action), ['snapshot', 'portfolio', 'settings', 'expenses', 'settings']);
  assert.match(a[1].text, /0050\.TW 佔股票 42%/);
  assert.match(a[4].text, /房貸/);
  // a stale snapshot is left to the data check
  assert.deepEqual(buildAlerts({ today: '2026-11-06', latestSnapshot: { date: '2026-01-01' }, topHolding: { weight: 30, level: 'warn' },
    fire: {}, month: { last_record: '' }, liabilities: [] }), []);
});
