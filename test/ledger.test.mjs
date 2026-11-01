// FIFO replay, plus the transaction routes on top of it.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const db = await import('../js/server/db.js');
const { replaySymbol } = await import('../js/server/ledger.js');
const { handle } = await import('../js/server/router.js');
await import('../js/server/stocks.js');

beforeEach(() => db._reset());

let nextId = 1;
function insertTxns(symbol, ...rows) {
  return rows.map((r) => db.insert('stock_transactions', {
    id: nextId++, symbol, market: 'TW', currency: 'TWD',
    fee: 0, tax: 0, realized_pl: 0, pl_manual: 0, lots_consumed: 1, ...r,
  }).id);
}

const realizedPL = (id) => db.get('stock_transactions', id).realized_pl;
const holding = (symbol) => db.findBy('stock_holdings', 'symbol', symbol);

test('replay FIFO with fees', () => {
  const ids = insertTxns('A.TW',
    { action: 'BUY', shares: 10, price: 100, fee: 10, date: '2026-01-02' },
    { action: 'BUY', shares: 10, price: 120, date: '2026-01-03' },
    { action: 'SELL', shares: 15, price: 130, fee: 5, tax: 2, date: '2026-01-04' },
  );
  const res = replaySymbol('A.TW');
  // Lot 1 cost 101 (fee included): 10×29 + 5×10 − 5 − 2.
  assert.ok(Math.abs(realizedPL(ids[2]) - 333) < 1e-6);
  assert.equal(res.shares, 5);
  assert.ok(Math.abs(res.avgCost - 120) < 1e-9);
  const h = holding('A.TW');
  assert.equal(h.shares, 5);
  assert.ok(Math.abs(h.avg_cost - 120) < 1e-9);
});

test('replay: same-day BUYs fund SELLs', () => {
  // The SELL row is inserted first but the BUY on the same day must fund it.
  const ids = insertTxns('A.TW',
    { action: 'SELL', shares: 5, price: 110, date: '2026-01-02' },
    { action: 'BUY', shares: 5, price: 100, date: '2026-01-02' },
  );
  const res = replaySymbol('A.TW');
  assert.equal(res.uncovered.size, 0);
  assert.equal(realizedPL(ids[0]), 50);
});

test('replay: manual SELLs keep their P&L', () => {
  const ids = insertTxns('A.TW',
    { action: 'BUY', shares: 10, price: 100, date: '2026-01-02' },
    // Imported history: fixed P&L, never touched holdings.
    { action: 'SELL', shares: 100, price: 50, date: '2026-01-03', realized_pl: 777, pl_manual: 1, lots_consumed: 0 },
    // Fixed P&L but still reduces holdings.
    { action: 'SELL', shares: 4, price: 200, date: '2026-01-04', realized_pl: 123, pl_manual: 1, lots_consumed: 1 },
  );
  replaySymbol('A.TW');
  assert.equal(realizedPL(ids[1]), 777);
  assert.equal(realizedPL(ids[2]), 123);
  assert.equal(holding('A.TW').shares, 6);
});

test('replay reports oversell', () => {
  const ids = insertTxns('A.TW',
    { action: 'BUY', shares: 3, price: 100, date: '2026-01-02' },
    { action: 'SELL', shares: 5, price: 100, date: '2026-01-03' },
  );
  const res = replaySymbol('A.TW');
  assert.equal(res.uncovered.get(ids[1]), 2);
});

// --- routes

const call = (method, url, b) => handle(url, { method, body: b === undefined ? undefined : JSON.stringify(b) });

test('POST /api/transactions rejects oversell and rolls back', async () => {
  await call('POST', '/api/transactions', { symbol: '2330.tw', action: 'BUY', shares: 3, price: 100, date: '2026-01-02' });
  await assert.rejects(
    call('POST', '/api/transactions', { symbol: '2330.TW', action: 'SELL', shares: 5, price: 100, date: '2026-01-03' }),
    (e) => e.status === 400 && /缺少 2 股/.test(e.message));
  assert.equal(db.all('stock_transactions').length, 1);
  assert.equal(holding('2330.TW').shares, 3);
});

test('POST /api/transactions computes realized P&L and auto fee', async () => {
  await call('POST', '/api/transactions', { symbol: '2330.TW', action: 'BUY', shares: 1000, price: 100, date: '2026-01-02', auto_fee: true });
  const sell = await call('POST', '/api/transactions', { symbol: '2330.TW', action: 'SELL', shares: 1000, price: 110, date: '2026-01-03', auto_fee: true });
  // fee 142 each side, tax 330: 10000 - 142 - 142 - 330
  assert.equal(sell.fee, 156);
  assert.equal(sell.tax, 330);
  assert.equal(sell.realized_pl, 110000 - 100142 - 156 - 330);
  assert.equal(sell.market, 'TW');
  assert.equal(sell.currency, 'TWD');
});

test('PUT/DELETE /api/transactions replay and warn', async () => {
  const buy = await call('POST', '/api/transactions', { symbol: 'NVDA', action: 'BUY', shares: 10, price: 100, date: '2026-01-02' });
  await call('POST', '/api/transactions', { symbol: 'NVDA', action: 'SELL', shares: 4, price: 150, date: '2026-01-03' });
  const upd = await call('PUT', `/api/transactions/${buy.id}`, { symbol: 'NVDA', action: 'BUY', shares: 10, price: 50, date: '2026-01-02' });
  assert.equal(upd.warnings, null);
  const sell = db.where('stock_transactions', (t) => t.action === 'SELL')[0];
  assert.equal(sell.realized_pl, 400);
  const del = await call('DELETE', `/api/transactions/${buy.id}`);
  // No BUY left: nothing to warn about (pure imported SELLs are expected)
  assert.equal(del.warnings, null);
});

test('GET /api/transactions/summary groups sells by symbol', async () => {
  insertTxns('A.TW',
    { action: 'SELL', shares: 10, price: 110, realized_pl: 100, date: '2025-05-01' },
    { action: 'SELL', shares: 10, price: 90, realized_pl: -100, date: '2026-05-01' },
  );
  const all = await call('GET', '/api/transactions/summary');
  assert.deepEqual(all.years, ['2026', '2025']);
  assert.equal(all.by_stock[0].total_trades, 2);
  assert.equal(all.overall.win_rate, 50);
  const y = await call('GET', '/api/transactions/summary?year=2025');
  assert.equal(y.overall.total_trades, 1);
  assert.equal(y.overall.best_trade.pct, 10);
});

test('POST /api/stocks imports a holding as a transfer BUY; DELETE removes its BUYs', async () => {
  const r = await call('POST', '/api/stocks', { symbol: '0050.TW', shares: 100, avg_cost: 150, date: '2025-01-01', note: '匯入' });
  assert.equal(r.shares, 100);
  const h = holding('0050.TW');
  assert.equal(h.note, '匯入');
  assert.equal(db.get('stock_transactions', r.id).is_transfer, 1);
  await call('DELETE', `/api/stocks/${h.id}`);
  assert.equal(db.all('stock_transactions').length, 0);
  assert.equal(holding('0050.TW'), null);
});
