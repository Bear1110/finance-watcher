import { test } from 'node:test';
import assert from 'node:assert/strict';
import { netWorthOf, netWorthSeries } from '../js/server/assets.js';
import { annualizePct, blendBenchmarks } from '../js/server/twr_calc.js';

test('netWorthOf: cash + USD cash at the rate + stocks − liabilities', () => {
  assert.equal(netWorthOf({ cashTWD: 100, cashUSD: 10, rate: 30, stocks: 1000, liabilities: 200 }), 1200);
});

test('netWorthSeries: per day from the snapshot on or before it, null before the first', () => {
  const series = { dates: ['2026-01-01', '2026-01-02', '2026-01-03'], value: { TW: [100, 110, 120], US: [10, 10, 10] }, fx: [30, 31, 32] };
  const snaps = [ // chronological
    { date: '2026-01-02', cash_twd: 50, cash_usd: 1, liabilities: 20 },
    { date: '2026-01-03', cash_twd: 60, cash_usd: 0 },
  ];
  assert.deepEqual(netWorthSeries(series, snaps), [null, 50 + 31 + 120 - 20, 60 + 130]);
});

test('annualizePct: only beyond a year', () => {
  assert.equal(annualizePct(21, 365), null);
  assert.equal(annualizePct(21, 730), 10);
  assert.equal(annualizePct(null, 800), null);
});

test('blendBenchmarks: weighted by the TW share, either side alone when the other is missing', () => {
  const b = blendBenchmarks([{ label: '0050', ret: 20 }, { label: 'S&P 500', ret: 10 }], 0.75, 100);
  assert.deepEqual(b, { weight_tw: 0.75, ret: 17.5, annualized: null,
    parts: [{ label: '0050', ret: 20, annualized: null }, { label: 'S&P 500', ret: 10, annualized: null }] });
  assert.equal(blendBenchmarks([{ ret: null }, { ret: 8 }], 0.5, 100).ret, 8);
  assert.equal(blendBenchmarks([{ ret: null }, { ret: null }], 0.5, 100), null);
  assert.equal(blendBenchmarks([{ ret: 21 }, { ret: 21 }], 0.5, 730).annualized, 10);
});
