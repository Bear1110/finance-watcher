// XIRR: imported-history SELLs (no BUY on record) count as a one-day round trip
// at the cost their stored realized_pl implies, without touching holdings.

import { test } from 'node:test';
import assert from 'node:assert/strict';

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
const { xirr } = await import('../js/server/performance.js');
await import('../js/server/stocks.js');

// Offline quotes, whether or not config.js has a default proxy.
const PRICES = { AAA: 110, 'USDTWD=X': 30 };
market.setQuoteFallback(async (symbols) =>
  Object.fromEntries(symbols.filter((s) => PRICES[s]).map((s) => [s, { price: PRICES[s], prevClose: PRICES[s] }])));
globalThis.fetch = async (url) => {
  const sym = decodeURIComponent((String(url).match(/\/chart\/([^?]+)/) || [])[1] || '');
  if (!PRICES[sym]) return new Response('not found', { status: 404 });
  const meta = { regularMarketPrice: PRICES[sym], chartPreviousClose: PRICES[sym], currency: '', shortName: sym };
  return Response.json({ chart: { result: [{ meta }], error: null } });
};

const daysAgo = (n) => db.today(new Date(Date.now() - n * 86400000));
const txn = (o) => ({ market: 'US', currency: 'USD', fee: 0, tax: 0, realized_pl: 0, pl_manual: 0, lots_consumed: 1, is_transfer: 0, ...o });

function load(withHistory) {
  mem.clear();
  market.invalidateCache();
  db.load();
  db.insert('settings', { key: 'usd_twd_rate', value: '30' });
  db.insert('stock_transactions', txn({ id: 1, symbol: 'AAA', action: 'BUY', shares: 10, price: 100, date: daysAgo(365) }));
  db.insert('stock_holdings', { symbol: 'AAA', market: 'US', shares: 10, avg_cost: 100, currency: 'USD' });
  if (withHistory) {
    // Sold 10 @ 120 for a stored +200 → implied cost 1000, bought "the day before".
    db.insert('stock_transactions', txn({ id: 2, symbol: 'BBB', action: 'SELL', shares: 10, price: 120,
      realized_pl: 200, pl_manual: 1, lots_consumed: 0, date: daysAgo(180) }));
  }
}

test('history SELLs add a one-day round trip to XIRR', async () => {
  load(false);
  const base = (await handle('/api/stocks/xirr')).US;
  load(true);
  const withHist = (await handle('/api/stocks/xirr')).US;

  assert.equal(withHist.flows, base.flows + 2);
  assert.ok(withHist.xirr > base.xirr, `${withHist.xirr} should beat ${base.xirr}`);
  // Holdings are untouched: BBB never appears, AAA keeps its 10 shares.
  assert.deepEqual(db.all('stock_holdings').map((h) => [h.symbol, h.shares]), [['AAA', 10]]);
});

test('xirr solver: short spikes fall outside the range, a year is exact', () => {
  // -1000 the day before, +1200 on the sale day, nothing else: the solver sees
  // a 20% one-day gain, which annualizes past the search range.
  const day = 86400000;
  assert.equal(xirr([{ t: 0, amt: -1000 }, { t: day, amt: 1200 }], 0), null);
  // Over a year the same flows give exactly 20%.
  const r = xirr([{ t: 0, amt: -1000 }, { t: 365 * day, amt: 1200 }], 0);
  assert.ok(Math.abs(r - 0.2) < 1e-6);
});
