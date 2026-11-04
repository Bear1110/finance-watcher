// Managed account (代管帳戶) math: FIFO holdings, realized P&L, cash adjustments.
// Quotes are fixed and offline: fetch is stubbed to answer like the Yahoo proxy
// (used when config.js has DEFAULT_YAHOO_PROXY), and the GOOGLEFINANCE-style
// fallback hook answers the same prices when no proxy is configured.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// db.js reads window.localStorage; give it an in-memory one.
const mem = new Map();
globalThis.window = {
  localStorage: {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
    removeItem: (k) => mem.delete(k),
  },
};

const db = await import('../js/server/db.js');
const market = await import('../js/server/market.js');
const { handle } = await import('../js/server/router.js');
const { computeHoldings } = await import('../js/server/managed.js');
await import('../js/server/expenses.js');
await import('../js/server/settings.js');

const PRICES = { NVDA: 150, '2330.TW': 1000, 'USDTWD=X': 30 };
market.setQuoteFallback(async (symbols) => {
  const out = {};
  for (const s of symbols) if (PRICES[s]) out[s] = { price: PRICES[s], prevClose: PRICES[s] };
  return out;
});
globalThis.fetch = async (url) => {
  const m = String(url).match(/\/v8\/finance\/chart\/([^?]+)/);
  const sym = m && decodeURIComponent(m[1]);
  if (!PRICES[sym]) return new Response('not found', { status: 404 });
  const meta = { regularMarketPrice: PRICES[sym], chartPreviousClose: PRICES[sym], currency: '', shortName: sym };
  return Response.json({ chart: { result: [{ meta }], error: null } });
};

const post = (url, body) => handle(url, { method: 'POST', body: JSON.stringify(body) });

beforeEach(() => {
  mem.clear();
  market.invalidateCache();
  market.invalidateForexCache();
  db._reset({
    settings: [{ id: 1, key: 'usd_twd_rate', value: '30' }],
    managed_accounts: [{ id: 1, name: '弟弟', cash_twd: 100000, cash_usd: 10000, note: '' }],
  });
});

test('BUY/SELL adjust cash and SELL realizes FIFO P&L', async () => {
  await post('/api/managed/accounts/1/transactions', { symbol: 'NVDA', market: 'US', action: 'BUY', shares: 10, price: 100, fee: 1, date: '2026-01-01' });
  await post('/api/managed/accounts/1/transactions', { symbol: 'NVDA', market: 'US', action: 'BUY', shares: 10, price: 120, fee: 1, date: '2026-02-01' });
  // Sells 15: 10 @100 + 5 @120 → (130-100)*10 + (130-120)*5 - 2 = 348
  const sell = await post('/api/managed/accounts/1/transactions', { symbol: 'NVDA', market: 'US', action: 'SELL', shares: 15, price: 130, fee: 2, date: '2026-03-01' });
  assert.equal(sell.realized_pl, 348);
  assert.equal(sell.account_id, 1);

  const acc = db.get('managed_accounts', 1);
  assert.equal(acc.cash_usd, 10000 - 1001 - 1201 + (1950 - 2));

  // Second SELL starts after the lots the first one used: 5 left @120
  const sell2 = await post('/api/managed/accounts/1/transactions', { symbol: 'NVDA', market: 'US', action: 'SELL', shares: 5, price: 110, fee: 0, date: '2026-04-01' });
  assert.equal(sell2.realized_pl, -50);
});

test('holdings keep the cost of the unsold lots and price them in TWD', async () => {
  await post('/api/managed/accounts/1/transactions', { symbol: 'NVDA', market: 'US', action: 'BUY', shares: 10, price: 100, date: '2026-01-01' });
  await post('/api/managed/accounts/1/transactions', { symbol: 'NVDA', market: 'US', action: 'BUY', shares: 10, price: 120, date: '2026-02-01' });
  await post('/api/managed/accounts/1/transactions', { symbol: 'NVDA', market: 'US', action: 'SELL', shares: 15, price: 130, date: '2026-03-01' });
  await post('/api/managed/accounts/1/transactions', { symbol: '2330.TW', market: 'TW', action: 'BUY', shares: 100, price: 900, date: '2026-01-05' });

  const hs = await computeHoldings(1);
  const nvda = hs.find((h) => h.symbol === 'NVDA');
  assert.equal(nvda.shares, 5);
  assert.equal(nvda.avg_cost, 120);
  assert.equal(nvda.market_value_twd, 5 * 150 * 30);
  assert.equal(nvda.cost_twd, 5 * 120 * 30);
  assert.equal(nvda.pl_percent, 25);

  const s = await handle('/api/managed/accounts/1/summary');
  assert.equal(s.stock_us_value_twd, 22500);
  assert.equal(s.stock_tw_value_twd, 100000);
  assert.equal(s.realized_pl_twd, ((130 - 100) * 10 + (130 - 120) * 5) * 30);
  assert.equal(s.cash_total_twd, s.account.cash_twd + s.account.cash_usd * 30);
  assert.equal(s.total_value_twd, s.cash_total_twd + s.stock_value_twd);
  assert.equal(s.transactions.length, 4);
  assert.equal(s.transactions[0].date, '2026-03-01');
});

test('deleting a trade or cash movement reverses its cash impact', async () => {
  const buy = await post('/api/managed/accounts/1/transactions', { symbol: '2330.TW', market: 'TW', action: 'BUY', shares: 10, price: 1000, fee: 20, date: '2026-01-01' });
  assert.equal(db.get('managed_accounts', 1).cash_twd, 100000 - 10020);
  await handle(`/api/managed/transactions/${buy.id}`, { method: 'DELETE' });
  assert.equal(db.get('managed_accounts', 1).cash_twd, 100000);

  const mv = await post('/api/managed/accounts/1/cash', { type: 'withdraw', currency: 'USD', amount: 500 });
  assert.equal(db.get('managed_accounts', 1).cash_usd, 9500);
  await handle(`/api/managed/cash/${mv.id}`, { method: 'DELETE' });
  assert.equal(db.get('managed_accounts', 1).cash_usd, 10000);
});

test('delete account refuses with trades unless forced', async () => {
  await post('/api/managed/accounts/1/transactions', { symbol: 'NVDA', action: 'BUY', shares: 1, price: 1 });
  await assert.rejects(handle('/api/managed/accounts/1', { method: 'DELETE' }), (e) => e.status === 409);
  await handle('/api/managed/accounts/1?force=1', { method: 'DELETE' });
  assert.equal(db.all('managed_accounts').length, 0);
  assert.equal(db.all('stock_transactions').length, 0);
});

test('snapshot freezes values and holding details', async () => {
  await post('/api/managed/accounts/1/transactions', { symbol: 'NVDA', market: 'US', action: 'BUY', shares: 2, price: 100, date: '2026-01-01' });
  const snap = await handle('/api/managed/accounts/1/snapshot?date=2026-05-01&note=x', { method: 'POST' });
  assert.equal(snap.date, '2026-05-01');
  assert.equal(snap.usd_twd_rate, 30);
  assert.equal(snap.stock_value_twd, 2 * 150 * 30);
  assert.equal(JSON.parse(snap.detail_json)[0].pl_twd, 2 * 50 * 30);
  const list = await handle('/api/managed/accounts/1/snapshots');
  assert.equal(list.length, 1);
});

test('expense stats: actuals per month with USD converted', async () => {
  await post('/api/expenses', { type: 'income', amount: 100, currency: 'USD', category: '薪資', date: '2026-03-05' });
  await post('/api/expenses', { type: 'expense', amount: 500, category: '飲食', date: '2026-03-06' });
  const m = (await handle('/api/expenses/stats?year=2026')).months[2];
  assert.equal(m.income, 3000);
  assert.equal(m.expense, 500);
  await assert.rejects(post('/api/expenses', { amount: 0, date: '2026-01-01' }), (e) => e.status === 400);
});

test('settings are saved and included in the backup', async () => {
  await handle('/api/settings', { method: 'PUT', body: JSON.stringify({ usd_twd_rate: 31.5 }) });
  assert.equal((await handle('/api/settings')).usd_twd_rate, '31.5');
  const { buildBackup } = await import('../js/server/settings.js');
  const bk = buildBackup();
  assert.equal(bk.format, 'finance-watcher-backup');
  assert.ok(bk.tables.settings.some((r) => r.key === 'usd_twd_rate' && r.value === '31.5'));
});
