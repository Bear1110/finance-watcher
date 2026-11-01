// Loads the inputs for the time-weighted-return math
// (twr_calc.js), keeps the local daily-close cache, and serves
// GET /api/stocks/performance.

import * as db from './db.js';
import { route } from './router.js';
import { isCounted, isHistorySell, settingString, storedUSDTWDRate, cmp, round4 } from './util.js';
import { fetchDailyCloses, fetchQuotes, hasProxy, MarketUnavailableError, USDTWD_SYMBOL } from './market.js';
import { queryDividends } from './dividends.js';
import {
  computePerformance, perfSegments, benchValues, benchReturn, addDays, addDate, isDateOnly, goRound,
} from './twr_calc.js';

// How long cached daily closes are trusted before the last week is refetched
// (the latest bar may have been an intraday price).
const PRICE_SYNC_TTL_MS = 30 * 60 * 1000;

// Optional settings date (YYYY-MM-DD) before which records are known to be
// incomplete; "全部", the chart and the heatmap start there.
export const PERF_START_KEY = 'perf_start_date';

// Offered as comparison lines, priced with dividend-adjusted closes so they are
// total returns like the portfolio's TWR.
export const perfBenchmarks = [
  { symbol: '0050.TW', label: '台灣50 (0050)', currency: 'TWD' },
  { symbol: 'SPY', label: 'S&P 500 (SPY)', currency: 'USD' },
  { symbol: 'QQQ', label: 'Nasdaq 100 (QQQ)', currency: 'USD' },
];

const utcDate = (s) => new Date(s + 'T00:00:00Z');
const dateOnly = (d) => d.toISOString().slice(0, 10);

// Concurrent syncs (e.g. two dashboard loads at startup) run one after another,
// so the second reads the first one's cache instead of refetching everything.
let priceSyncChain = Promise.resolve();

/**
 * Makes sure price_history covers [need[sym], today] for each symbol, fetching
 * from Yahoo only what is missing or stale, and returns every symbol's closes,
 * oldest first. need: { symbol: 'YYYY-MM-DD' }. Fetch errors are logged; the
 * caller falls back to trade prices for symbols with no closes.
 */
export function syncPriceHistory(need) {
  const run = priceSyncChain.then(() => doSyncPriceHistory(need));
  priceSyncChain = run.catch(() => {});
  return run;
}

async function doSyncPriceHistory(need) {
  const jobs = [];
  const symbols = Object.keys(need);
  const nowMs = Date.now();
  for (const sym of symbols) {
    const from = need[sym];
    const sync = db.findBy('price_history_sync', 'symbol', sym);
    if (!sync || from < sync.from_date) {
      jobs.push({ sym, since: utcDate(addDays(from, -10)), reset: true });
      continue;
    }
    const t = Date.parse(sync.synced_at);
    if (!Number.isNaN(t) && nowMs - t < PRICE_SYNC_TTL_MS) continue;
    let since = new Date(nowMs - 7 * 86400000);
    const last = lastPriceDate(sym);
    if (isDateOnly(last)) {
      const lt = utcDate(addDays(last, -7));
      if (lt < since) since = lt;
    }
    jobs.push({ sym, since, reset: false });
  }

  const results = await Promise.all(jobs.map(async (j) => {
    try {
      return { closes: await fetchDailyCloses(j.sym, j.since) };
    } catch (err) {
      return { err };
    }
  }));

  const now = new Date().toISOString();
  jobs.forEach((j, i) => {
    const r = results[i];
    if (r.err) {
      console.warn(`price history for ${j.sym}:`, r.err.message);
      return;
    }
    savePriceHistory(j.sym, r.closes, j.reset ? need[j.sym] : '', now);
  });
  return loadPriceHistory(symbols);
}

function lastPriceDate(sym) {
  let last = '';
  for (const r of db.where('price_history', (x) => x.symbol === sym)) if (r.date > last) last = r.date;
  return last;
}

/** Cached closes without touching Yahoo: { symbol: [{date, close, adj_close}] }. */
export function loadPriceHistory(symbols) {
  const want = new Set(symbols);
  const out = {};
  for (const r of db.where('price_history', (x) => want.has(x.symbol))) {
    (out[r.symbol] ||= []).push({ date: r.date, close: r.close, adj_close: r.adj_close });
  }
  for (const list of Object.values(out)) list.sort((a, b) => cmp(a.date, b.date));
  return out;
}

/**
 * Stores fetched closes. A non-empty resetFrom replaces the symbol's whole
 * series and records the new start; empty merges into the existing series.
 */
export function savePriceHistory(sym, closes, resetFrom, syncedAt) {
  if (resetFrom) {
    db.removeWhere('price_history', (x) => x.symbol === sym);
  } else {
    const dates = new Set(closes.map((c) => c.date));
    db.removeWhere('price_history', (x) => x.symbol === sym && dates.has(x.date));
  }
  for (const c of closes) {
    db.insert('price_history', { symbol: sym, date: c.date, close: c.close, adj_close: c.adj_close });
  }
  const prev = db.findBy('price_history_sync', 'symbol', sym);
  db.upsert('price_history_sync', {
    symbol: sym,
    from_date: resetFrom || (prev ? prev.from_date : ''),
    synced_at: syncedAt,
  });
}

const perfTxn = (t, over = {}) => ({
  symbol: t.symbol, market: t.market, action: t.action, shares: t.shares, price: t.price,
  fee: t.fee, tax: t.tax, currency: t.currency, date: t.date, transfer: t.is_transfer === 1,
  synthetic: false, ...over,
});

/**
 * Self trades for performance and XIRR, oldest first (perfTxn shape): the
 * counted trades, plus each imported-history SELL (「歷史已實現損益」, no BUY on
 * record) as a one-day round trip, bought the day before at the cost its stored
 * realized_pl implies. The ledger and holdings never see these synthetic rows.
 */
export function loadPerfTxns() {
  const out = [];
  for (const t of db.all('stock_transactions')) {
    if (isCounted(t)) {
      out.push({ ...perfTxn(t), _id: t.id });
    } else if (t.account_id == null && isHistorySell(t) && isDateOnly(t.date) && t.shares > 0) {
      const cost = t.shares * t.price - t.fee - t.tax - t.realized_pl;
      if (!(cost > 0)) continue;
      out.push({ ...perfTxn(t, { action: 'BUY', date: addDays(t.date, -1), price: cost / t.shares, fee: 0, tax: 0, synthetic: true }), _id: t.id });
      out.push({ ...perfTxn(t, { synthetic: true }), _id: t.id });
    }
  }
  // Same order as before (date, then id); a round trip's BUY sorts on the day before.
  out.sort((a, b) => cmp(a.date, b.date) || a._id - b._id);
  return out.map(({ _id, ...t }) => t);
}

/**
 * Dividends dated on the ex-date when known: that is when the price drops, so
 * the cash belongs to that day's return.
 */
export function loadPerfDivs() {
  return queryDividends().map((d) => ({
    market: d.market, currency: d.currency, date: d.ex_date || d.date, amount: d.amount,
  }));
}

/** Symbols with shares left (kept current by the ledger replay). */
export function heldSymbols() {
  return db.where('stock_holdings', (h) => h.shares > 0).map((h) => h.symbol);
}

/**
 * The day performance starts: the first trade, or the perf_start_date setting
 * when it is a valid later date. Returns { setting, origin } (origin '' with no trades).
 */
export function perfOrigin(txns) {
  const setting = settingString(PERF_START_KEY);
  if (txns.length === 0) return { setting, origin: '' };
  let origin = txns[0].date;
  if (isDateOnly(setting) && setting > origin) origin = setting;
  return { setting, origin };
}

/**
 * GET /api/stocks/performance
 * Time-weighted return of the self stock portfolio in TWD per period and
 * market, with drawdown, volatility, a monthly heatmap, the daily series for
 * the chart, and benchmark returns.
 */
async function performance() {
  const txns = loadPerfTxns();
  const divs = loadPerfDivs();
  const { setting: startSetting, origin } = perfOrigin(txns);
  const today = db.today();
  if (txns.length === 0 || txns[0].date > today) {
    return { as_of: today, periods: [], start_setting: startSetting };
  }
  if (!hasProxy()) {
    throw new MarketUnavailableError('投資績效需要 Yahoo 歷史股價，請先到「設定 → 行情來源」設定行情代理網址');
  }
  const first = txns[0].date;

  // Symbols to price, each from its first trade; benchmarks from the origin.
  const need = { [USDTWD_SYMBOL]: first };
  for (const t of txns) {
    if (!(t.symbol in need) && isDateOnly(t.date)) need[t.symbol] = t.date;
  }
  for (const b of perfBenchmarks) {
    if (!(b.symbol in need) || origin < need[b.symbol]) need[b.symbol] = origin;
  }
  const closes = await syncPriceHistory(need);

  // Today uses the same live quotes and rate as the holdings page.
  const live = {};
  for (const [sym, q] of Object.entries(await fetchQuotes(heldSymbols()))) live[sym] = q.price;
  const res = computePerformance({
    txns, divs, closes, live, liveRate: storedUSDTWDRate(), today,
  });

  // Everything starts at the close of the day before the origin.
  const o = res.baseIndex(addDays(origin, -1));
  const bench = {};
  for (const b of perfBenchmarks) {
    bench[b.symbol] = benchValues(closes[b.symbol], res.days, res.fx, b.currency === 'USD');
  }

  const periodDefs = [
    { key: '1M', label: '1 個月', start: addDate(today, 0, -1, 0) },
    { key: '3M', label: '3 個月', start: addDate(today, 0, -3, 0) },
    { key: '6M', label: '6 個月', start: addDate(today, 0, -6, 0) },
    { key: 'YTD', label: '今年', start: `${Number(today.slice(0, 4)) - 1}-12-31` },
    { key: '1Y', label: '1 年', start: addDate(today, -1, 0, 0) },
    { key: 'ALL', label: '全部', start: '' },
  ];
  const last = res.days.length - 1;
  const periods = periodDefs.map((p) => {
    const b = Math.max(res.baseIndex(p.start), o);
    const pp = {
      key: p.key, label: p.label, start: res.days[b], days: last - b,
      partial: p.start !== '' && p.start < res.days[b],
      markets: {}, bench: {},
    };
    for (const seg of perfSegments) pp.markets[seg] = res.stats(seg, b);
    for (const [sym, v] of Object.entries(bench)) pp.bench[sym] = benchReturn(v, b);
    return pp;
  });

  // Daily series from the origin for the charts (the client rebases growth to
  // 0% at a period's start). Growth is null until the day before a segment
  // first has capital at work; benchmarks are null before their first bar.
  const series = { dates: res.days.slice(o) };
  const growth = {};
  const value = {};
  const benchOut = {};
  for (const seg of perfSegments) {
    const ps = res.series[seg];
    const g = [];
    const v = [];
    for (let i = o; i <= last; i++) {
      g.push(i + 1 > last || ps.active[i + 1] > 0 ? goRound(ps.growth[i] * 1e6) / 1e6 : null);
      v.push(goRound(ps.value[i]));
    }
    growth[seg] = g;
    value[seg] = v;
  }
  for (const [sym, vals] of Object.entries(bench)) {
    benchOut[sym] = vals.slice(o).map((x) => (x > 0 ? round4(x) : null));
  }
  series.growth = growth;
  series.value = value;
  series.bench = benchOut;
  series.fx = res.fx.slice(o).map(round4);

  const monthly = {};
  for (const seg of perfSegments) monthly[seg] = res.monthlyReturns(seg, o);

  return {
    as_of: today,
    inception: res.days[Math.min(o + 1, last)],
    start_setting: startSetting,
    periods,
    monthly,
    benchmarks: perfBenchmarks.map(({ symbol, label }) => ({ symbol, label })),
    missing: res.missing,
    series,
  };
}

route('GET', '/api/stocks/performance', performance);
