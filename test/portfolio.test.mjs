import { test } from 'node:test';
import assert from 'node:assert/strict';
import { portfolioStats, concentrationLevel } from '../js/server/portfolio.js';

const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} ≈ ${b}`);
const h = (symbol, market, currency, value, cost, pl = value - cost) =>
  ({ symbol, market, currency, market_value_twd: value, cost_twd: cost, unrealized_pl_twd: pl, pl_percent: pl / cost * 100 });

test('concentrationLevel thresholds', () => {
  assert.equal(concentrationLevel(24.9), '');
  assert.equal(concentrationLevel(25), 'warn');
  assert.equal(concentrationLevel(40), 'danger');
});

test('portfolioStats: weights, concentration, USD exposure, dividends, split', () => {
  const s = portfolioStats({
    holdings: [
      h('0050.TW', 'TW', 'TWD', 600, 400),
      h('VOO', 'US', 'USD', 300, 400),
      h('2330.TW', 'TW', 'TWD', 100, 200),
    ],
    ttmTWD: { '0050.TW': 20, VOO: 8 },
    cash: { twd: 500, usd: -10 }, // negative carried cash counts as is
    rate: 30,
  });
  assert.deepEqual(s.rows.map((r) => [r.symbol, r.weight, r.cost_weight, r.level]), [
    ['0050.TW', 60, 40, 'danger'], ['VOO', 30, 40, 'warn'], ['2330.TW', 10, 20, ''],
  ]);
  close(s.rows[0].yield_cost, 5);
  assert.equal(s.rows[2].yield_cost, null);
  close(s.top3, 100);
  close(s.effective, 1 / (0.36 + 0.09 + 0.01));
  // USD: 300 stock − 300 cash over net worth 1000 + 500 − 300
  assert.deepEqual(s.usd, { stock: 300, cash: -300, pct: 0 });
  assert.equal(s.dividends.ttm, 28);
  close(s.dividends.yield_cost, 2.8);
  assert.deepEqual(s.split, { tw: 700, us: 300 });
});

test('portfolioStats: no value → null; no snapshot → stocks only', () => {
  assert.equal(portfolioStats({ holdings: [], ttmTWD: {}, cash: null, rate: 30 }), null);
  const s = portfolioStats({ holdings: [h('VOO', 'US', 'USD', 100, 100)], ttmTWD: {}, cash: null, rate: 30 });
  assert.deepEqual(s.usd, { stock: 100, cash: null, pct: 100 });
});
