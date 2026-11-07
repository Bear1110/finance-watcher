import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dividendSources, OTHER_SOURCE } from '../js/server/dividends.js';

const d = (date, symbol, amount, currency = 'TWD') => ({ date, symbol, amount, currency });

test('dividendSources: per year by stock, what moved the total, last-12-month concentration', () => {
  const rows = [
    d('2025-01-20', '0056', 10_000), d('2025-07-20', '00881', 30_000), d('2025-08-01', 'AAPL', 100, 'USD'),
    d('2026-01-20', '00881', 300_000), d('2026-02-01', '0056', 5_000),
    ...['A', 'B', 'C', 'D', 'E'].map((s) => d('2026-03-01', s, 10)), // small payers → 其他
  ];
  const r = dividendSources(rows, 32, '2026-11-07');
  assert.deepEqual(r.years.map((y) => y.year), ['2026', '2025']);
  const [y26, y25] = r.years;
  assert.equal(y25.total, 10_000 + 30_000 + 3_200);
  assert.equal(y25.change, null);
  assert.equal(y26.change, 305_050 - 43_200);
  assert.deepEqual(y26.drivers.map((x) => x.symbol), ['00881', '0056', 'AAPL']);
  assert.equal(y26.drivers[0].delta, 270_000);
  assert.ok(y26.parts.some((p) => p.symbol === OTHER_SOURCE)); // only the top 5 overall get their own color
  assert.equal(r.symbols[0], '00881');
  assert.equal(r.ttm.parts[0].symbol, '00881');
  assert.ok(Math.abs(r.ttm.top_share - 300_000 / 305_050 * 100) < 1e-9);
});
