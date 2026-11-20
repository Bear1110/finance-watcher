import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as db from '../js/server/db.js';
import { estimateDividend, dividendAlreadyRecorded, dividendSuggestions, stockDividendRecorded, isStockDividend } from '../js/server/dividends.js';
import { handle } from '../js/server/router.js';
import { normalizeTxn } from '../js/server/ledger.js';
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
    NVDA: { cash: [{ ex_date: '2026-02-01', per_share: 1 }, { ex_date: '2026-03-02', per_share: 1 }, { ex_date: '2099-01-01', per_share: 1 }] },
    '2330.TW': { cash: [{ ex_date: '2026-04-01', per_share: 5 }, { ex_date: '2026-07-01', per_share: 5 }] },
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

test('isStockDividend: 台股 ratio between 1 and 2 only', () => {
  assert.equal(isStockDividend('TW', 1.03), true);
  assert.equal(isStockDividend('TW', 4), false); // 0050 1→4 is a real split
  assert.equal(isStockDividend('US', 1.03), false);
});

test('stockDividendRecorded: zero-cost BUY of the symbol within -3..60 days', () => {
  const txns = [{ symbol: 'A', action: 'BUY', price: 0, date: '2026-08-20' }, { symbol: 'B', action: 'BUY', price: 10, date: '2026-08-01' }];
  assert.equal(stockDividendRecorded(txns, 'A', '2026-08-01'), true);
  assert.equal(stockDividendRecorded(txns, 'A', '2026-05-01'), false);
  assert.equal(stockDividendRecorded(txns, 'B', '2026-08-01'), false);
});

test('dividendSuggestions: 配股 rows, later ex-dates count them, cash undone from Yahoo split adjustment', async () => {
  db._reset({
    stock_transactions: [
      { id: 1, symbol: '2892.TW', market: 'TW', currency: 'TWD', action: 'BUY', shares: 10000, price: 25, date: '2024-01-02' },
      { id: 2, symbol: 'NVDA', market: 'US', currency: 'USD', action: 'BUY', shares: 10, price: 100, date: '2024-01-02' },
    ],
  });
  const evs = {
    // Yahoo: 2024 cash 0.85 shown as 0.85 / 1.025 because of the 2025 配股
    '2892.TW': {
      cash: [{ ex_date: '2024-08-08', per_share: 0.829268 }, { ex_date: '2025-08-07', per_share: 0.95 }],
      splits: [{ ex_date: '2024-08-08', ratio: 1.03 }, { ex_date: '2025-08-07', ratio: 1.025 }],
    },
    NVDA: { cash: [{ ex_date: '2024-09-12', per_share: 0.01 }], splits: [{ ex_date: '2024-06-10', ratio: 10 }] },
  };
  const { suggestions } = await dividendSuggestions({ today: '2026-11-20', fetchHistory: async (sym) => evs[sym] });
  assert.deepEqual(suggestions.map((s) => [s.symbol, s.kind, s.ex_date, s.shares, s.kind === 'stock' ? s.new_shares : s.gross]), [
    ['2892.TW', 'cash', '2025-08-07', 10300, 9785],
    ['2892.TW', 'stock', '2025-08-07', 10300, 257], // floor(10300 × 0.025)
    ['NVDA', 'cash', '2024-09-12', 10, 0.1], // US splits are not 配股: untouched
    ['2892.TW', 'cash', '2024-08-08', 10000, 8500],
    ['2892.TW', 'stock', '2024-08-08', 10000, 300],
  ]);
  assert.equal(suggestions[1].per_thousand, 25);

  // Import the 2024 配股 through the batch route: it becomes a zero-cost BUY and is not suggested again.
  await handle('/api/dividends/batch', { method: 'POST', body: JSON.stringify([
    { kind: 'stock', symbol: '2892.TW', market: 'TW', currency: 'TWD', shares: 300, ex_date: '2024-08-08' },
  ]) });
  const buy = db.where('stock_transactions', (t) => t.price === 0)[0];
  assert.deepEqual([buy.action, buy.shares, buy.date, buy.fee], ['BUY', 300, '2024-08-08', 0]);
  assert.equal(db.where('stock_holdings', (h) => h.symbol === '2892.TW')[0].shares, 10300);
  const again = await dividendSuggestions({ today: '2026-11-20', fetchHistory: async (sym) => evs[sym] });
  assert.deepEqual(again.suggestions.filter((s) => s.kind === 'stock').map((s) => [s.ex_date, s.new_shares]), [['2025-08-07', 257]]);
});

test('normalizeTxn: BUY may be 0 (配股), SELL may not', () => {
  const base = { symbol: '2892.TW', market: 'TW', currency: 'TWD', shares: 300, price: 0, date: '2024-08-08' };
  assert.equal(normalizeTxn({ ...base, action: 'BUY' }).price, 0);
  assert.throws(() => normalizeTxn({ ...base, action: 'SELL' }), /價格必須大於 0/);
});
