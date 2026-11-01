import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as db from '../js/server/db.js';
import { estimateDividend, dividendAlreadyRecorded, dividendSuggestions } from '../js/server/dividends.js';
import { MarketUnavailableError } from '../js/server/market.js';

test('estimateDividend: US withholding, TW NHI premium threshold, rounding', () => {
  assert.deepEqual(estimateDividend('US', 'USD', 100, 0.3), { gross: 100, amount: 70, withheld: 30 });
  assert.deepEqual(estimateDividend('TW', 'TWD', 19999.6, 0.3), { gross: 20000, amount: 20000, withheld: 0 });
  assert.deepEqual(estimateDividend('TW', 'TWD', 30000, 0.3), { gross: 30000, amount: 29367, withheld: 633 });
  assert.deepEqual(estimateDividend('US', 'USD', 12.345, 0.3), { gross: 12.35, amount: 8.64, withheld: 3.7 });
});

test('dividendAlreadyRecorded: ex_date match or manual payout within -3..60 days', () => {
  const ex = [{ symbol: 'A', ex_date: '', date: '2026-03-01' }, { symbol: 'B', ex_date: '2026-01-10', date: '2026-02-01' }];
  assert.equal(dividendAlreadyRecorded(ex, 'A', '2026-01-15'), true);
  assert.equal(dividendAlreadyRecorded(ex, 'A', '2025-12-01'), false);
  assert.equal(dividendAlreadyRecorded(ex, 'B', '2026-01-10'), true);
  assert.equal(dividendAlreadyRecorded(ex, 'B', '2026-01-11'), false);
});

test('dividendSuggestions: shares held before ex-date, dedupe, settings rate', async () => {
  db._reset({
    stock_transactions: [
      { id: 1, symbol: 'NVDA', market: 'US', currency: 'USD', action: 'BUY', shares: 10, price: 1, date: '2026-01-01' },
      { id: 2, symbol: 'NVDA', market: 'US', currency: 'USD', action: 'SELL', shares: 4, price: 1, date: '2026-03-01' },
      { id: 3, symbol: '2330.TW', market: 'TW', currency: 'TWD', action: 'BUY', shares: 10000, price: 1, date: '2026-01-01' },
      // managed account trades do not count
      { id: 4, symbol: 'NVDA', market: 'US', currency: 'USD', action: 'BUY', shares: 99, price: 1, date: '2026-01-01', account_id: 7 },
    ],
    dividends: [{ id: 1, symbol: '2330.TW', amount: 1, date: '2026-04-10', ex_date: '2026-04-01' }],
    settings: [{ id: 1, key: 'us_div_withholding', value: '0.1' }],
  });
  const evs = {
    NVDA: [{ ex_date: '2026-02-01', per_share: 1 }, { ex_date: '2026-03-02', per_share: 1 }, { ex_date: '2099-01-01', per_share: 1 }],
    '2330.TW': [{ ex_date: '2026-04-01', per_share: 5 }, { ex_date: '2026-07-01', per_share: 5 }],
  };
  const { suggestions, errors } = await dividendSuggestions({
    today: '2026-10-31',
    fetchHistory: async (sym) => evs[sym],
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(suggestions.map((s) => [s.symbol, s.ex_date, s.shares, s.gross, s.amount, s.withheld]), [
    ['2330.TW', '2026-07-01', 10000, 50000, 48945, 1055],
    ['NVDA', '2026-03-02', 6, 6, 5.4, 0.6],
    ['NVDA', '2026-02-01', 10, 10, 9, 1],
  ]);
});

test('dividendSuggestions: per-symbol errors listed, missing market source throws', async () => {
  db._reset({
    stock_transactions: [{ id: 1, symbol: 'X', market: 'US', currency: 'USD', action: 'BUY', shares: 1, price: 1, date: '2026-01-01' }],
  });
  const r = await dividendSuggestions({ fetchHistory: async () => { throw new Error('boom'); } });
  assert.deepEqual(r, { suggestions: [], errors: ['X: boom'] });
  await assert.rejects(
    dividendSuggestions({ fetchHistory: async () => { throw new MarketUnavailableError(); } }),
    MarketUnavailableError);
});
