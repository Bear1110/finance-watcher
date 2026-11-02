// Time-weighted-return math.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computePerformance, benchValues, benchReturn, round2, fmtNum,
} from '../js/server/twr_calc.js';
import { USDTWD_SYMBOL } from '../js/server/market.js';

function closesOf(...pairs) {
  const out = [];
  for (let i = 0; i < pairs.length; i += 2) out.push({ date: pairs[i], close: pairs[i + 1], adj_close: pairs[i + 1] });
  return out;
}

const buy = (symbol, date, shares, price) => ({ symbol, market: 'TW', currency: 'TWD', action: 'BUY', date, shares, price, fee: 0, tax: 0, transfer: false });
const sell = (symbol, date, shares, price) => ({ ...buy(symbol, date, shares, price), action: 'SELL' });

function approx(name, got, want) {
  assert.ok(Math.abs(got - want) <= 1e-6, `${name} = ${got}, want ${want}`);
}

// Whole-history TWR of seg as a fraction.
const lastReturn = (r, seg) => { const g = r.series[seg].growth; return g[g.length - 1] - 1; };

test('TWR buy and hold is price return', () => {
  const r = computePerformance({
    txns: [buy('A.TW', '2026-01-05', 10, 100)],
    closes: { 'A.TW': closesOf('2026-01-05', 100, '2026-01-06', 110, '2026-01-07', 99) },
    today: '2026-01-07', liveRate: 30,
  });
  approx('twr', lastReturn(r, 'ALL'), -0.01);
  approx('TW twr', lastReturn(r, 'TW'), -0.01);
  const s = r.stats('ALL', 0);
  assert.equal(s.pnl, -10);
  assert.equal(s.end_value, 990);
  assert.equal(r.stats('US', 0).twr, null, 'US never invested');
});

test('TWR ignores when money is added', () => {
  const r = computePerformance({
    // A second, bigger buy at the 110 close right before the drop.
    txns: [buy('A.TW', '2026-01-05', 10, 100), buy('A.TW', '2026-01-06', 100, 110)],
    closes: { 'A.TW': closesOf('2026-01-05', 100, '2026-01-06', 110, '2026-01-07', 99) },
    today: '2026-01-07', liveRate: 30,
  });
  approx('twr', lastReturn(r, 'ALL'), -0.01);
  // Money-wise it lost: 10 shares +10 then 110 shares −11 each.
  assert.equal(r.stats('ALL', 0).pnl, 100 - 1210);
});

test('TWR sell and dividend', () => {
  const r = computePerformance({
    txns: [buy('A.TW', '2026-01-05', 10, 100), sell('A.TW', '2026-01-07', 10, 130)],
    divs: [{ market: 'TW', currency: 'TWD', date: '2026-01-06', amount: 50 }],
    closes: { 'A.TW': closesOf('2026-01-05', 100, '2026-01-06', 120, '2026-01-07', 125, '2026-01-08', 140) },
    today: '2026-01-08', liveRate: 30,
  });
  // Day 2: (1200 + 50) / 1000; day 3: sold at 130 against a 120 close; day 4: nothing held.
  approx('twr', lastReturn(r, 'ALL'), 1.25 * 1300 / 1200 - 1);
  const s = r.stats('ALL', 0);
  assert.equal(s.pnl, 350);
  assert.equal(s.end_value, 0);
});

test('TWR USD uses daily rate', () => {
  const us = { symbol: 'X', market: 'US', currency: 'USD', action: 'BUY', date: '2026-01-05', shares: 1, price: 100, fee: 0, tax: 0 };
  const r = computePerformance({
    txns: [us],
    closes: {
      X: closesOf('2026-01-05', 100, '2026-01-06', 100),
      [USDTWD_SYMBOL]: closesOf('2026-01-05', 30, '2026-01-06', 31),
    },
    today: '2026-01-06', liveRate: 31,
  });
  approx('US twr', lastReturn(r, 'US'), 31 / 30 - 1);
  approx('ALL twr', lastReturn(r, 'ALL'), 31 / 30 - 1);
});

test('TWR today uses live quote', () => {
  const r = computePerformance({
    txns: [buy('A.TW', '2026-01-05', 10, 100)],
    closes: { 'A.TW': closesOf('2026-01-05', 100, '2026-01-06', 105) },
    live: { 'A.TW': 120 },
    today: '2026-01-06', liveRate: 30,
  });
  approx('twr', lastReturn(r, 'ALL'), 0.2);
});

test('TWR holding import enters at market', () => {
  const imp = { ...buy('A.TW', '2026-01-05', 10, 50), transfer: true }; // average cost, not a trade price
  const r = computePerformance({
    txns: [imp],
    closes: { 'A.TW': closesOf('2026-01-05', 100, '2026-01-06', 110) },
    today: '2026-01-06', liveRate: 30,
  });
  approx('twr', lastReturn(r, 'ALL'), 0.1); // no fake +100% on the import day
});

test('TWR missing history uses trade price', () => {
  const r = computePerformance({
    txns: [buy('A.TW', '2026-01-05', 10, 100)],
    today: '2026-01-06', liveRate: 30,
  });
  approx('twr', lastReturn(r, 'ALL'), 0);
  assert.deepEqual(r.missing, ['A.TW']);
});

test('stats drawdown and periods', () => {
  const r = computePerformance({
    txns: [buy('A.TW', '2026-01-05', 1, 100)],
    closes: { 'A.TW': closesOf('2026-01-05', 100, '2026-01-06', 120, '2026-01-07', 90, '2026-01-08', 125, '2026-01-09', 110) },
    today: '2026-01-09', liveRate: 30,
  });
  const s = r.stats('ALL', 0);
  assert.equal(s.max_drawdown, -25);
  assert.equal(s.dd_peak, '2026-01-06');
  assert.equal(s.dd_trough, '2026-01-07');
  assert.equal(s.dd_recovered, '2026-01-08');
  // From the 01-07 close: 90 → 110.
  const b = r.baseIndex('2026-01-07');
  assert.equal(r.days[b], '2026-01-07');
  assert.equal(r.stats('ALL', b).twr, round2((110 / 90 - 1) * 100));
  assert.equal(r.baseIndex('2025-01-01'), 0, 'before history is the base day');
});

test('monthly returns', () => {
  const r = computePerformance({
    txns: [buy('A.TW', '2025-12-30', 1, 100)],
    closes: { 'A.TW': closesOf('2025-12-30', 100, '2025-12-31', 110, '2026-01-30', 121, '2026-02-02', 108.9) },
    today: '2026-02-02', liveRate: 30,
  });
  const years = r.monthlyReturns('ALL', 0);
  assert.equal(years.length, 2);
  assert.equal(years[0].year, 2025);
  assert.equal(years[1].year, 2026);
  assert.equal(years[0].months[11], 10);
  assert.equal(years[1].months[0], 10);
  assert.equal(years[1].months[1], -10);
  assert.equal(years[1].months[2], null);
  assert.equal(years[1].total, -1);
});

test('benchmark', () => {
  const days = ['2026-01-04', '2026-01-05', '2026-01-06'];
  const v = benchValues(closesOf('2026-01-05', 10, '2026-01-06', 12), days, [30, 30, 31], true);
  assert.deepEqual(v, [0, 300, 372]);
  assert.equal(benchReturn(v, 0), 24, 'starts at first bar');
});

test('TWR buy before the move shares it', () => {
  const r = computePerformance({
    // A big buy at 100, then the stock closes at 105: old and new money both made 5%.
    txns: [buy('A.TW', '2026-01-05', 1, 100), buy('A.TW', '2026-01-06', 1000, 100)],
    closes: { 'A.TW': closesOf('2026-01-05', 100, '2026-01-06', 105) },
    today: '2026-01-06', liveRate: 30,
  });
  approx('twr', lastReturn(r, 'ALL'), 0.05);
});

test('fmtNum', () => {
  const cases = [[115000, '115,000'], [20.05, '20.05'], [1761.96, '1,761.96'], [-1234567.5, '-1,234,567.5'], [0, '0'], [999, '999']];
  for (const [v, want] of cases) assert.equal(fmtNum(v), want, `fmtNum(${v})`);
});

test('cost and realized: FIFO lots with fees, USD cost at the day rate', () => {
  const r = computePerformance({
    txns: [
      { ...buy('A.TW', '2026-01-05', 10, 100), fee: 10 },          // lot cost 101
      buy('A.TW', '2026-01-06', 10, 120),                          // lot cost 120
      { ...sell('A.TW', '2026-01-07', 15, 130), fee: 5, tax: 5 }, // takes 10 @101 + 5 @120
      { ...buy('U', '2026-01-06', 2, 50), market: 'US', currency: 'USD' },
    ],
    closes: {
      'A.TW': closesOf('2026-01-05', 100, '2026-01-06', 120, '2026-01-07', 130),
      U: closesOf('2026-01-06', 50, '2026-01-07', 60),
      [USDTWD_SYMBOL]: closesOf('2026-01-06', 30, '2026-01-07', 32),
    },
    today: '2026-01-07', liveRate: 32,
  });
  const last = (seg, k) => r.series[seg][k][r.series[seg][k].length - 1];
  approx('TW realized', last('TW', 'realized'), 15 * 130 - 10 - (10 * 101 + 5 * 120));
  approx('TW cost', last('TW', 'cost'), 5 * 120);
  approx('TW value', last('TW', 'value'), 5 * 130);
  approx('US cost at day rate', last('US', 'cost'), 2 * 50 * 32);
  approx('ALL cost', last('ALL', 'cost'), 5 * 120 + 2 * 50 * 32);
  approx('US realized', last('US', 'realized'), 0);
});

test('realized uses the ledger realized_pl when the SELL carries one', () => {
  const r = computePerformance({
    txns: [buy('A.TW', '2026-01-05', 10, 100), { ...sell('A.TW', '2026-01-06', 10, 120), realized_pl: 150 }],
    closes: { 'A.TW': closesOf('2026-01-05', 100, '2026-01-06', 120) },
    today: '2026-01-06', liveRate: 30,
  });
  const realized = r.series.TW.realized;
  approx('stored realized', realized[realized.length - 1], 150); // not the recomputed 200
});
