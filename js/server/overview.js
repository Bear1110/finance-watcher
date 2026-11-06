// 總覽: how net worth grew, split into what can be measured.

import * as db from './db.js';
import { route } from './router.js';
import { storedUSDTWDRate, toTWD } from './util.js';
import { listSnapshots, afterSnapshot, tradeCash, carriedCash } from './assets.js';
import { listHoldings } from './stocks.js';

/**
 * Net worth change from base to end, split into 股價 (stock value change − net buys: cash turned
 * into stock isn't a gain), 股利 (dividends received) and 儲蓄 (the rest: money saved, plus FX on
 * cash and anything unrecorded). 儲蓄 is the remainder on purpose: trades and dividends are
 * recorded reliably, 收支 often isn't.
 * base / end: { date, created_at?, stock_value_twd, total } with total = net worth.
 */
export function growthBetween(base, end, { trades, dividends, rate }) {
  const inRange = (r) => afterSnapshot(r, base) && r.date <= end.date;
  // Imported positions count as buys here: their value appearing isn't a price gain.
  const netBuys = -trades.filter(inRange).reduce((s, t) => s + toTWD(tradeCash(t), t.currency, rate), 0);
  const price = end.stock_value_twd - base.stock_value_twd - netBuys;
  const div = dividends.filter(inRange).reduce((s, d) => s + toTWD(d.amount || 0, d.currency, rate), 0);
  const change = end.total - base.total;
  return { from: base.date, to: end.date, start: base.total, change, price, dividends: div, savings: change - price - div };
}

/**
 * growthBetween per calendar year, newest first. A year starts from the last snapshot on or
 * before Jan 1 (else its first snapshot: partial) and ends at its last snapshot; the current
 * year ends at `live` (today's net worth). snaps: newest first, each with `total`.
 */
export function yearlyGrowth(snaps, live, opts) {
  const asc = [...snaps].reverse();
  if (!asc.length) return [];
  const thisYear = Number(live.date.slice(0, 4));
  const out = [];
  for (let y = Number(asc[0].date.slice(0, 4)); y <= thisYear; y++) {
    let base = asc.findLast((s) => s.date <= `${y}-01-01`);
    const partial = !base;
    base ||= asc.find((s) => s.date.startsWith(`${y}-`));
    const end = y === thisYear ? live : asc.findLast((s) => s.date <= `${y}-12-31`);
    if (!base || !end || end === base) continue;
    out.push({ year: y, partial, current: y === thisYear, ...growthBetween(base, end, opts) });
  }
  return out.reverse();
}

route('GET', '/api/overview', async () => {
  const rate = storedUSDTWDRate();
  const snaps = listSnapshots().map((s) => ({ ...s, total: s.total_asset }));
  const cash = carriedCash();
  const stocks = await listHoldings();
  const live = {
    date: db.today(),
    stock_value_twd: stocks.total_value_twd,
    total: cash ? cash.twd + cash.usd * rate + stocks.total_value_twd : null,
  };
  const opts = {
    trades: db.where('stock_transactions', (t) => t.account_id == null),
    dividends: db.all('dividends'),
    rate,
  };
  return { net_worth: live.total, years: cash ? yearlyGrowth(snaps, live, opts) : [] };
});
