import { test } from 'node:test';
import assert from 'node:assert/strict';
import { growthBetween, yearlyGrowth, monthSummary, avgMonthlyExpense, spendingStats, buildAlerts } from '../js/server/overview.js';

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
    price: 500 - netBuys, dividends: 70, other: 0, savings: 800 - (500 - netBuys) - 70,
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

test('spendingStats: setting wins over records, cash runway', () => {
  assert.deepEqual(spendingStats({ cashTWD: 300_000, setting: 50_000, recorded: 40_000 }),
    { monthly_expense: 50_000, source: 'setting', recorded_monthly_expense: 40_000, cash_months: 6 });
  assert.deepEqual(spendingStats({ cashTWD: null, setting: 0, recorded: 40_000 }),
    { monthly_expense: 40_000, source: 'records', recorded_monthly_expense: 40_000, cash_months: null });
  assert.deepEqual(spendingStats({ cashTWD: 1, setting: 0, recorded: null }),
    { monthly_expense: null, source: null, recorded_monthly_expense: null, cash_months: null });
});

test('buildAlerts: no snapshot, concentration, low cash, stale 收支 and 其他資產', () => {
  const a = buildAlerts({
    today: '2026-11-06',
    latestSnapshot: null,
    topHolding: { symbol: '0050.TW', weight: 42, level: 'danger' },
    spending: { cash_months: 2.1 },
    month: { last_record: '2026-10-01' },
    otherAssets: [{ name: '自住房', updated: '2025-10-01' }, { name: '車', updated: '2026-10-01' }],
  });
  assert.deepEqual(a.map((x) => x.action), ['snapshot', 'portfolio', 'settings', 'expenses', 'settings']);
  assert.match(a[1].text, /0050\.TW 佔股票 42%/);
  assert.match(a[4].text, /自住房/);
  // a stale snapshot is left to the data check
  assert.deepEqual(buildAlerts({ today: '2026-11-06', latestSnapshot: { date: '2026-01-01' }, topHolding: { weight: 30, level: 'warn' },
    spending: {}, month: { last_record: '' }, otherAssets: [] }), []);
});

test('growthBetween: a change in 其他資產 is its own part, not savings', () => {
  const g = growthBetween({ date: '2026-01-01', stock_value_twd: 0, total: 5000, other: 3000 },
    { date: '2026-06-30', stock_value_twd: 0, total: 4900, other: 2500 }, { trades: [], dividends: [], rate: 30 });
  assert.equal(g.other, -500);
  assert.equal(g.savings, 400);
});

test('growthBetween: consecutive periods add up (same-day records go to exactly one period)', () => {
  const a = snap('2026-01-01', 1000, 3000), b = snap('2026-03-01', 1500, 3700, '2026-03-01 10:00:00'), c = snap('2026-06-01', 1800, 4200);
  const opts = {
    trades: [
      tx({ action: 'BUY', shares: 1, price: 100, date: '2026-03-01', created_at: '2026-03-01 09:00:00' }), // before b: first period
      tx({ action: 'BUY', shares: 1, price: 200, date: '2026-03-01', created_at: '2026-03-01 11:00:00' }), // after b: second
    ],
    dividends: [{ amount: 10, currency: 'TWD', date: '2026-03-01', created_at: '2026-03-01 11:00:00' }],
    rate: 30,
  };
  const ab = growthBetween(a, b, opts), bc = growthBetween(b, c, opts), ac = growthBetween(a, c, opts);
  assert.equal(ab.price + bc.price, ac.price);
  assert.equal(ab.dividends + bc.dividends, ac.dividends);
  assert.equal(ab.savings + bc.savings, ac.savings);
  assert.equal(ab.price, 500 - 100);
  assert.equal(bc.price, 300 - 200);
});
