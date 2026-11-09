import { test } from 'node:test';
import assert from 'node:assert/strict';
import { twCode } from '../js/server/names.js';
import { generateFinancialPrompt } from '../js/server/llm.js';

test('names: 台股 code from .TW / .TWO symbols, null for other markets', () => {
  assert.equal(twCode('2330.TW'), '2330');
  assert.equal(twCode('00679B.TWO'), '00679B');
  assert.equal(twCode('AAPL'), null);
  assert.equal(twCode('^TWII'), null);
});

test('prompt: holdings show the stock name next to the symbol', () => {
  const p = generateFinancialPrompt({
    sections: new Set(['portfolio']), rate: 32, names: { '2330.TW': '台積電' },
    holdings: { holdings: [{ symbol: '2330.TW', market: 'TW', shares: 1000, avg_cost: 500, current_price: 1000, market_value_twd: 1_000_000, unrealized_pl_twd: 500_000, pl_percent: 100 }], total_market_value_twd: 1_000_000 },
  });
  assert.match(p, /\| 2330\.TW 台積電 \| TW \|/);
});
