import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as db from '../js/server/db.js';
import { summarizeRealized } from '../js/server/stocks.js';

const { handle } = await import('../js/server/router.js');

test('交易紀錄: each trade’s realized P&L in TWD, adding up to the 已實現損益 total (US$ converted)', async () => {
  db._reset({
    settings: [{ key: 'usd_twd_rate', value: '32' }],
    stock_transactions: [
      { id: 1, symbol: '2330.TW', market: 'TW', currency: 'TWD', action: 'SELL', shares: 100, price: 1100, fee: 0, tax: 0, date: '2025-01-15', realized_pl: 24393, pl_manual: 1, lots_consumed: 0 },
      { id: 2, symbol: 'NVDA', market: 'US', currency: 'USD', action: 'SELL', shares: 20, price: 180, fee: 0, tax: 0, date: '2025-12-01', realized_pl: 1200, pl_manual: 1, lots_consumed: 0 },
    ],
  });
  const list = await handle('/api/transactions');
  assert.deepEqual(list.map((t) => t.realized_pl_twd).sort((a, b) => a - b), [24393, 38400]);
  const total = list.reduce((s, t) => s + t.realized_pl_twd, 0);
  assert.equal(total, summarizeRealized().overall.total_realized_pl_twd);
});
