// Market data: quotes, USD/TWD rate, daily price history and dividend history.
//
// Every request is a Yahoo Finance chart call. Browsers cannot call Yahoo
// directly (no CORS), so requests go through a pass-through proxy
// (worker/yahoo-proxy.js) whose URL is in config.js. Without a
// proxy, quotes and the USD/TWD rate fall back to a provider registered by the
// cloud layer (GOOGLEFINANCE in the user's sheet); history and dividends are
// then unavailable.

import { DEFAULT_YAHOO_PROXY } from '../config.js';
import { today } from './db.js';
import { addDays } from './twr_calc.js';

const QUOTE_TTL_MS = 5 * 60 * 1000;
const FOREX_TTL_MS = 30 * 60 * 1000;
const DIVIDEND_TTL_MS = 6 * 60 * 60 * 1000;
export const USDTWD_SYMBOL = 'USDTWD=X';

export class MarketUnavailableError extends Error {
  constructor(msg = '沒有設定行情代理（設定 → 行情來源），無法取得 Yahoo 歷史資料') {
    super(msg);
    this.name = 'MarketUnavailableError';
  }
}

export function proxyURL() {
  const u = (DEFAULT_YAHOO_PROXY || '').trim();
  return u.replace(/\/+$/, '');
}

export function hasProxy() {
  return proxyURL() !== '';
}

// Fallback for quotes when there is no proxy: async (symbols) => { [symbol]: { price, prevClose, name, currency } }
let quoteFallback = null;
export function setQuoteFallback(fn) {
  quoteFallback = fn;
}

/** GET a Yahoo chart path (`/v8/finance/chart/SYM?...`) through the proxy. */
async function yahooGetJSON(path, label) {
  const base = proxyURL();
  if (!base) throw new MarketUnavailableError();
  let resp;
  try {
    resp = await fetch(base + path, { signal: AbortSignal.timeout ? AbortSignal.timeout(15000) : undefined });
  } catch (e) {
    throw new Error(`fetch ${label}: ${e.message}`);
  }
  if (!resp.ok) throw new Error(`yahoo API returned ${resp.status} for ${label}`);
  return resp.json();
}

/** 台股中文名稱 { '2330': '台積電' } for the given codes, from the proxy's /tw-names (TWSE open data). */
export async function fetchTWNames(codes) {
  const base = proxyURL();
  if (!base) throw new MarketUnavailableError();
  const resp = await fetch(`${base}/tw-names?codes=${codes.map(encodeURIComponent).join(',')}`,
    { signal: AbortSignal.timeout ? AbortSignal.timeout(15000) : undefined });
  if (!resp.ok) throw new Error(`tw-names returned ${resp.status}`);
  return resp.json();
}

const chartPath = (symbol, query) => `/v8/finance/chart/${encodeURIComponent(symbol)}?${query}`;

// ---------------------------------------------------------------- quotes

const quoteCache = new Map(); // symbol -> quote
const inflight = new Map(); // symbol -> Promise
let lastFetchAt = null;

export function lastFetchTime() {
  return lastFetchAt;
}

export function invalidateCache() {
  quoteCache.clear();
  lastFetchAt = null;
}

function cached(symbol) {
  const q = quoteCache.get(symbol);
  if (!q) return null;
  if (Date.now() - Date.parse(q.fetched_at) > QUOTE_TTL_MS) return null;
  return q;
}

// Yahoo exchange code -> Google Finance's, for the quote page link (Taiwan ones are derived from the symbol)
const GOOGLE_EXCHANGE = {
  NMS: 'NASDAQ', NGM: 'NASDAQ', NCM: 'NASDAQ', NAS: 'NASDAQ',
  NYQ: 'NYSE', PCX: 'NYSEARCA', ASE: 'NYSEAMERICAN', BTS: 'BATS',
};

function makeQuote(symbol, price, prevClose, currency, name, exchange, type) {
  const q = {
    symbol, price, change: 0, change_percent: 0,
    currency: currency || '', name: name || '', exchange: GOOGLE_EXCHANGE[exchange] || '',
    type: type || '', // Yahoo instrumentType: 'EQUITY' | 'ETF' | 'MUTUALFUND' | …; '' when unknown (no proxy)
    fetched_at: new Date().toISOString(),
  };
  if (prevClose > 0) {
    q.change = price - prevClose;
    q.change_percent = q.change / prevClose * 100;
  }
  return q;
}

async function fetchQuoteYahoo(symbol) {
  const yr = await yahooGetJSON(chartPath(symbol, 'interval=1d&range=1d'), symbol);
  if (yr.chart?.error) throw new Error(`yahoo API error for ${symbol}: ${yr.chart.error.description}`);
  const res = yr.chart?.result?.[0];
  if (!res) throw new Error(`no results for ${symbol}`);
  const m = res.meta;
  return makeQuote(symbol, m.regularMarketPrice, m.chartPreviousClose, m.currency, m.shortName, m.exchangeName, m.instrumentType);
}

export async function fetchQuote(symbol) {
  const c = cached(symbol);
  if (c) return c;
  if (inflight.has(symbol)) return inflight.get(symbol);
  const p = (async () => {
    let q;
    if (hasProxy()) {
      q = await fetchQuoteYahoo(symbol);
    } else {
      const m = await fallbackQuotes([symbol]);
      q = m[symbol];
      if (!q) throw new Error(`no quote for ${symbol}`);
    }
    quoteCache.set(symbol, q);
    lastFetchAt = new Date();
    return q;
  })();
  inflight.set(symbol, p);
  try {
    return await p;
  } finally {
    inflight.delete(symbol);
  }
}

async function fallbackQuotes(symbols) {
  if (!quoteFallback) throw new MarketUnavailableError('沒有設定行情代理，也尚未登入 Google（GOOGLEFINANCE 報價需要登入）');
  const raw = await quoteFallback(symbols);
  const out = {};
  for (const [sym, r] of Object.entries(raw || {})) {
    if (r && r.price > 0) out[sym] = makeQuote(sym, r.price, r.prevClose, r.currency, r.name);
  }
  return out;
}

/** Fault-tolerant batch fetch: missing symbols are simply absent from the result. */
export async function fetchQuotes(symbols) {
  const results = {};
  const toFetch = [];
  for (const s of symbols) {
    const c = cached(s);
    if (c) results[s] = c; else toFetch.push(s);
  }
  if (!toFetch.length) return results;
  if (!hasProxy()) {
    try {
      const m = await fallbackQuotes(toFetch);
      for (const [s, q] of Object.entries(m)) { quoteCache.set(s, q); results[s] = q; }
      lastFetchAt = new Date();
    } catch (e) {
      console.warn('quote fallback failed', e);
    }
    return results;
  }
  await Promise.all(toFetch.map(async (s) => {
    try {
      results[s] = await fetchQuote(s);
    } catch (e) {
      console.warn(`failed to fetch quote for ${s}:`, e.message);
    }
  }));
  return results;
}

// ---------------------------------------------------------------- forex

let cachedRate = 0;
let cachedRateAt = null;

/** Live USD/TWD rate: { rate, at: Date }. Cached 30 minutes. */
export async function fetchUSDTWDRate() {
  if (cachedRateAt && Date.now() - cachedRateAt.getTime() < FOREX_TTL_MS && cachedRate > 0) {
    return { rate: cachedRate, at: cachedRateAt };
  }
  const rate = hasProxy()
    ? (await fetchQuoteYahoo(USDTWD_SYMBOL)).price
    : (await fallbackQuotes([USDTWD_SYMBOL]))[USDTWD_SYMBOL]?.price;
  if (!(rate > 0)) throw new Error(`invalid rate: ${rate}`);
  cachedRate = rate;
  cachedRateAt = new Date();
  return { rate, at: cachedRateAt };
}

export function invalidateForexCache() {
  cachedRate = 0;
  cachedRateAt = null;
}

// ---------------------------------------------------------------- daily closes

const unix = (d) => Math.floor(d.getTime() / 1000);

// End of the current UTC hour: a stable period2 lets the proxy's edge cache
// answer repeat history requests instead of every call missing.
const periodEnd = () => Math.ceil(Date.now() / 3600000) * 3600;

/**
 * Daily closes for symbol from `since` (Date) to `until` (Date, default now), oldest first:
 * [{ date, close, adj_close }]. close is split-adjusted, adj_close also folds
 * in dividends. The last bar may be today's in-progress price.
 */
export async function fetchDailyCloses(symbol, since, until = null) {
  const body = await yahooGetJSON(
    chartPath(symbol, `interval=1d&period1=${unix(since)}&period2=${until ? unix(until) : periodEnd()}`),
    `${symbol} history`);
  if (body.chart?.error) throw new Error(`yahoo history error for ${symbol}: ${body.chart.error.description}`);
  const res = body.chart?.result?.[0];
  if (!res || !res.indicators?.quote?.length) return [];
  const closes = res.indicators.quote[0].close || [];
  const adj = res.indicators.adjclose?.[0]?.adjclose || [];
  const offset = res.meta?.gmtoffset || 0;
  const out = [];
  (res.timestamp || []).forEach((ts, i) => {
    const c = closes[i];
    if (c == null || !(c > 0)) return;
    // Bars are stamped at market open; the exchange's offset keeps the date right.
    const date = new Date((ts + offset) * 1000).toISOString().slice(0, 10);
    const bar = { date, close: c, adj_close: adj[i] > 0 ? adj[i] : c };
    if (out.length && out[out.length - 1].date === date) out[out.length - 1] = bar;
    else out.push(bar);
  });
  return out;
}

// ---------------------------------------------------------------- forex on a date

const fxCache = new Map(); // `${currency}|${date}` -> { rate, date }

/**
 * Market rate of 1 `currency` in TWD on `date` (YYYY-MM-DD): that day's close, or the last
 * trading day before it (weekends, holidays). Without a proxy only today's rate is
 * available (GOOGLEFINANCE in the sheet), so that is used for any date.
 */
export async function fetchFxRate(currency, date) {
  const proxy = hasProxy();
  const key = `${currency}|${proxy ? date : today()}`; // no proxy: one (today's) rate for every date
  if (fxCache.has(key)) return fxCache.get(key);
  const symbol = `${currency}TWD=X`;
  let out;
  if (proxy) {
    const utc = (d) => new Date(`${d}T00:00:00Z`);
    const bars = await fetchDailyCloses(symbol, utc(addDays(date, -10)), utc(addDays(date, 1)));
    const bar = bars.filter((b) => b.date <= date).pop() || bars[0];
    if (!bar) throw new Error(`查不到 ${currency} 匯率`);
    out = { rate: bar.close, date: bar.date };
  } else {
    const price = (await fallbackQuotes([symbol]))[symbol]?.price;
    if (!(price > 0)) throw new MarketUnavailableError(`查不到 ${currency} 匯率（沒有行情代理時需要登入），請手動填寫`);
    out = { rate: price, date: today() };
  }
  fxCache.set(key, out);
  return out;
}

// ---------------------------------------------------------------- dividends

const dividendCache = new Map(); // symbol|since -> { at, evs }

/** Ex-dividend events since `since` (Date): [{ ex_date, per_share }], oldest first. */
export async function fetchDividendHistory(symbol, since) {
  const key = `${symbol}|${since.toISOString().slice(0, 10)}`;
  const e = dividendCache.get(key);
  if (e && Date.now() - e.at < DIVIDEND_TTL_MS) return e.evs;
  const body = await yahooGetJSON(
    chartPath(symbol, `interval=1mo&events=div&period1=${unix(since)}&period2=${periodEnd()}`),
    `${symbol} dividends`);
  const res = body.chart?.result?.[0];
  const evs = [];
  for (const d of Object.values(res?.events?.dividends || {})) {
    if (!(d.amount > 0)) continue;
    // Fixed UTC+8 so the calendar date doesn't shift with the browser's timezone.
    evs.push({ ex_date: new Date((d.date + 8 * 3600) * 1000).toISOString().slice(0, 10), per_share: d.amount });
  }
  evs.sort((a, b) => (a.ex_date < b.ex_date ? -1 : a.ex_date > b.ex_date ? 1 : 0));
  dividendCache.set(key, { at: Date.now(), evs });
  return evs;
}

// ---------------------------------------------------------------- ETF holdings

const HOLDINGS_TTL_MS = 6 * 60 * 60 * 1000;
const holdingsCache = new Map(); // symbol -> { at, info }

/**
 * Yahoo's top holdings for symbol (quoteSummary topHoldings, usually the top 10):
 * { is_fund, holdings: [{ symbol, name, weight }], bond } with weights (and bond, the fund's
 * bond share) as fractions of the fund. is_fund is false for a plain stock.
 */
export async function fetchFundHoldings(symbol) {
  const e = holdingsCache.get(symbol);
  if (e && Date.now() - e.at < HOLDINGS_TTL_MS) return e.info;
  const body = await yahooGetJSON(`/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=quoteType,topHoldings`, `${symbol} holdings`);
  const res = body.quoteSummary?.result?.[0];
  if (!res) throw new Error(body.quoteSummary?.error?.description || `no holdings for ${symbol}`);
  const type = res.quoteType?.quoteType || '';
  const th = res.topHoldings;
  const raw = (v) => (typeof v?.raw === 'number' ? v.raw : 0);
  const info = {
    is_fund: (type === 'ETF' || type === 'MUTUALFUND') && !!th,
    holdings: (th?.holdings || [])
      .filter((x) => x.symbol && raw(x.holdingPercent) > 0)
      .map((x) => ({ symbol: x.symbol, name: x.holdingName || '', weight: raw(x.holdingPercent) })),
    bond: raw(th?.bondPosition),
  };
  holdingsCache.set(symbol, { at: Date.now(), info });
  return info;
}
