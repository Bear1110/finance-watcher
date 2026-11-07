import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tradeStats } from '../js/server/stocks.js';

test('tradeStats: same win rate, very different trade quality', () => {
  // A: 10 wins of 10k, 1 loss of 50k; B: 10 wins of 50k, 1 loss of 100k
  const a = tradeStats([...Array(10).fill(10000), -50000]);
  const b = tradeStats([...Array(10).fill(50000), -100000]);
  assert.equal(a.win_rate, b.win_rate);
  assert.deepEqual([a.profit_factor, a.avg_win, a.avg_loss, a.payoff, a.expectancy], [2, 10000, 50000, 0.2, 4545.45]);
  assert.deepEqual([b.profit_factor, b.payoff, b.expectancy], [5, 0.5, 36363.64]);
});

test('tradeStats: no losses, flat trades, nothing', () => {
  const s = tradeStats([100, 0, 300]);
  assert.equal(s.profit_factor, null);
  assert.equal(s.payoff, null);
  assert.equal(s.flat, 1);
  assert.equal(s.expectancy, 133.33);
  const e = tradeStats([]);
  assert.deepEqual([e.trades, e.win_rate, e.expectancy, e.profit_factor], [0, 0, 0, null]);
});
