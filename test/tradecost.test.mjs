// Taiwan trading costs (lots.js): the fee estimate for new trades and the sell cost taken off 未實現損益.
import test from 'node:test';
import assert from 'node:assert/strict';
import { twTradeCost, estSellCost } from '../js/server/lots.js';

test('twTradeCost: fee with discount and minimum, tax only on a sale, 0.1% for ETFs', () => {
  assert.deepEqual(twTradeCost('2330.TW', 'BUY', 1000, 1000), { fee: 1425, tax: 0 });
  assert.deepEqual(twTradeCost('2330.TW', 'SELL', 1000, 1000, 0.6), { fee: 855, tax: 3000 });
  assert.deepEqual(twTradeCost('0050.TW', 'SELL', 1000, 100), { fee: 142, tax: 100 });
  assert.equal(twTradeCost('2330.TW', 'BUY', 1000, 10).fee, 20); // board lot: at least NT$20
  assert.equal(twTradeCost('2330.TW', 'BUY', 10, 10).fee, 1); // odd lot: at least NT$1
});

test('estSellCost: Taiwan only, nothing without shares or a price', () => {
  assert.equal(estSellCost('TW', '2330.TW', 1000, 1000, 0.6), 855 + 3000);
  assert.equal(estSellCost('US', 'AAPL', 10, 200), 0);
  assert.equal(estSellCost('TW', '2330.TW', 0, 1000), 0);
  assert.equal(estSellCost('TW', '2330.TW', 1000, undefined), 0);
});
