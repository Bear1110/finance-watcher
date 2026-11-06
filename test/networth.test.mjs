import { test } from 'node:test';
import assert from 'node:assert/strict';
import { netWorthOf, netWorthSeries } from '../js/server/assets.js';
import { annualizePct } from '../js/server/twr_calc.js';

test('netWorthOf: cash + USD cash at the rate + stocks + counted 其他資產', () => {
  assert.equal(netWorthOf({ cashTWD: 100, cashUSD: 10, rate: 30, stocks: 1000, other: 200 }), 1600);
  assert.equal(netWorthOf({ cashTWD: 100, cashUSD: 10, rate: 30, stocks: 1000 }), 1400);
});

test('netWorthSeries: per day from the snapshot on or before it, null before the first', () => {
  const series = { dates: ['2026-01-01', '2026-01-02', '2026-01-03'], value: { TW: [100, 110, 120], US: [10, 10, 10] }, fx: [30, 31, 32] };
  const snaps = [ // chronological
    { date: '2026-01-02', cash_twd: 50, cash_usd: 1, other_assets: 20 },
    { date: '2026-01-03', cash_twd: 60, cash_usd: 0 },
  ];
  assert.deepEqual(netWorthSeries(series, snaps), [null, 50 + 31 + 120 + 20, 60 + 130]);
  assert.deepEqual(netWorthSeries(series, snaps, false), [null, 50 + 31 + 120, 60 + 130]);
});

test('annualizePct: only beyond a year', () => {
  assert.equal(annualizePct(21, 365), null);
  assert.equal(annualizePct(21, 730), 10);
  assert.equal(annualizePct(null, 800), null);
});
