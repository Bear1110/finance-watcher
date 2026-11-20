// Cash dividends, Yahoo-based suggestions (cash and 台股配股) and per-symbol totals.

import * as db from './db.js';
import { route } from './router.js';
import { fetchDividendHistory, MarketUnavailableError } from './market.js';
import { normalizeTxn, replaySymbol } from './ledger.js';
import {
  HttpError, badRequest, body, cmp, daysBetween, isBonusShares, isCounted, normalizeSymbolMarket, round4, settingFloat,
  storedUSDTWDRate, toTWD,
} from './util.js';

function normalizeDividend(d) {
  normalizeSymbolMarket(d);
  d.amount = Number(d.amount) || 0;
  d.withheld = Number(d.withheld) || 0;
  if (!(d.amount > 0)) throw badRequest('股利金額必須大於 0');
  if (d.withheld < 0) throw badRequest('已扣稅額不可為負');
  return d;
}

function insertDividend(d) {
  return db.insert('dividends', {
    symbol: d.symbol, market: d.market, currency: d.currency, amount: d.amount,
    withheld: d.withheld, date: d.date, ex_date: d.ex_date || '', note: d.note || '',
  });
}

/** Dividends, optionally limited to one year ('' = all), date DESC, id DESC. */
export function queryDividends(year = '') {
  return db.where('dividends', (d) => year === '' || d.date.slice(0, 4) === year)
    .sort((a, b) => cmp(b.date, a.date) || b.id - a.id);
}

route('GET', '/api/dividends', ({ query }) => queryDividends(query.get('year') || ''));

route('POST', '/api/dividends', (req) => {
  const d = normalizeDividend({ ...body(req) });
  return insertDividend(d);
});

/** A 配股 suggestion as a zero-cost BUY dated the ex-date (Yahoo's prices are adjusted from then on). */
function stockDividendTxn(d) {
  const t = normalizeTxn({
    symbol: d.symbol, market: d.market, currency: d.currency, action: 'BUY', shares: d.shares, price: 0,
    date: d.ex_date, note: d.note || '配股',
  });
  if (!Number.isInteger(t.shares)) throw badRequest('配股股數必須是整數');
  return { ...t, kind: 'stock' };
}

// All-or-nothing import (used by the Yahoo suggestions list): cash rows become dividends,
// kind 'stock' rows (配股) zero-cost BUYs.
route('POST', '/api/dividends/batch', async (req) => {
  const list = body(req);
  if (!Array.isArray(list)) throw badRequest('invalid JSON: expected an array');
  const items = list.map((raw) => {
    const d = { ...raw };
    try {
      return d.kind === 'stock' ? stockDividendTxn(d) : normalizeDividend(d);
    } catch (e) {
      throw badRequest(`${d.symbol}: ${e.message}`);
    }
  });
  await db.transaction(async () => {
    for (const d of items) {
      if (d.kind !== 'stock') insertDividend(d);
      else {
        db.insert('stock_transactions', {
          symbol: d.symbol, market: d.market, action: 'BUY', shares: d.shares, price: 0, fee: 0, tax: 0,
          currency: d.currency, date: d.date, realized_pl: 0, note: d.note,
        });
      }
    }
    for (const sym of new Set(items.filter((d) => d.kind === 'stock').map((d) => d.symbol))) replaySymbol(sym);
  });
  return { created: items.length };
});

route('PUT', '/api/dividends/{id}', (req) => {
  const d = normalizeDividend({ ...body(req) });
  const updated = db.update('dividends', req.params.id, {
    symbol: d.symbol, market: d.market, currency: d.currency, amount: d.amount,
    withheld: d.withheld, date: d.date, note: d.note || '',
  });
  if (!updated) throw new HttpError(404, 'dividend not found');
  return { status: 'updated' };
});

route('DELETE', '/api/dividends/{id}', ({ params }) => {
  db.remove('dividends', params.id);
  return { status: 'deleted' };
});

/** The date a year before today ('YYYY-MM-DD'): the start of 近 12 個月. */
function yearAgo(today) {
  const c = new Date(today + 'T00:00:00');
  c.setFullYear(c.getFullYear() - 1);
  return db.today(c);
}

/** Dividends received per symbol in its own currency: all-time and trailing 12 months. */
export function dividendsBySymbol() {
  const cutoff = yearAgo(db.today());
  const groups = new Map();
  for (const d of db.all('dividends')) {
    const k = `${d.symbol}\u0000${d.currency}`;
    const it = groups.get(k) || { symbol: d.symbol, currency: d.currency, total: 0, ttm: 0 };
    it.total += d.amount;
    if (d.date >= cutoff) it.ttm += d.amount;
    groups.set(k, it);
  }
  return [...groups.values()].sort((a, b) => cmp(a.symbol, b.symbol) || cmp(a.currency, b.currency));
}

/** Symbols shown on their own in 股利來源; the rest are lumped into 其他. */
const SOURCE_TOP = 5;
export const OTHER_SOURCE = '其他';

/**
 * 股利來源: each year's dividends (TWD at rate) split by stock, how much each stock added or lost
 * against the year before, and how concentrated the last 12 months are. The biggest payers overall
 * keep their own color across years; the rest are 其他.
 */
export function dividendSources(rows, rate, today) {
  const twd = (d) => toTWD(d.amount, d.currency, rate);
  const sumBy = (list, key) => {
    const m = new Map();
    for (const d of list) m.set(key(d), (m.get(key(d)) || 0) + twd(d));
    return m;
  };
  const total = (m) => [...m.values()].reduce((a, b) => a + b, 0);
  const parts = (m) => [...m].sort((a, b) => b[1] - a[1]).map(([symbol, amount]) => ({ symbol, amount }));

  const symbols = parts(sumBy(rows, (d) => d.symbol)).slice(0, SOURCE_TOP).map((p) => p.symbol);
  const label = (d) => (symbols.includes(d.symbol) ? d.symbol : OTHER_SOURCE);

  const byYear = new Map();
  for (const d of rows) byYear.set(d.date.slice(0, 4), [...(byYear.get(d.date.slice(0, 4)) || []), d]);
  const yearsAsc = [...byYear].sort((a, b) => cmp(a[0], b[0]));
  let prev = null; // the year before, per real symbol: what moved the total
  const years = yearsAsc.map(([year, list]) => {
    const exact = sumBy(list, (d) => d.symbol);
    const y = {
      year,
      total: total(exact),
      parts: parts(sumBy(list, label)),
      change: prev ? total(exact) - total(prev) : null,
      drivers: prev ? [...new Set([...exact.keys(), ...prev.keys()])]
        .map((symbol) => ({ symbol, delta: (exact.get(symbol) || 0) - (prev.get(symbol) || 0) }))
        .filter((x) => Math.abs(x.delta) >= 1)
        .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
        .slice(0, 3) : [],
    };
    prev = exact;
    return y;
  });

  const cutoff = yearAgo(today);
  const ttm = parts(sumBy(rows.filter((d) => d.date >= cutoff && d.date <= today), (d) => d.symbol));
  const ttmTotal = ttm.reduce((a, p) => a + p.amount, 0);
  return {
    years: years.reverse(),
    symbols,
    has_other: years.some((y) => y.parts.some((p) => p.symbol === OTHER_SOURCE)),
    ttm: { total: ttmTotal, parts: ttm, top_share: ttmTotal > 0 ? ttm[0].amount / ttmTotal * 100 : null },
  };
}

route('GET', '/api/dividends/sources', () => dividendSources(db.all('dividends'), storedUSDTWDRate(), db.today()));

route('GET', '/api/dividends/by-symbol', () => ({ items: dividendsBySymbol(), usd_twd_rate: storedUSDTWDRate() }));

/**
 * Estimated withholding on one payout: US uses the configured withholding rate,
 * TW deducts the 2.11% NHI supplementary premium on a single payout ≥ NT$20,000.
 * Returns rounded { gross, amount, withheld } (TWD to whole dollars, else cents).
 */
export function estimateDividend(market, currency, gross, usWithholding) {
  let net = gross;
  let withheld = 0;
  if (market === 'US') {
    withheld = gross * usWithholding;
    net = gross - withheld;
  } else if (gross >= 20000) {
    withheld = gross * 0.0211;
    net = gross - withheld;
  }
  const p = currency === 'TWD' ? 1 : 100;
  const rnd = (v) => Math.round(v * p) / p;
  return { gross: rnd(gross), amount: rnd(net), withheld: rnd(withheld) };
}

/** A payout recorded by hand counts for an ex-date when dated 3 days before to 60 days after it. */
const nearExDate = (exDate, date) => {
  const days = daysBetween(exDate, date);
  return days >= -3 && days <= 60;
};

/**
 * Matches an imported record by ex_date, or a manually entered one (no ex_date)
 * paid between 3 days before and 60 days after the ex-date.
 */
export function dividendAlreadyRecorded(existing, symbol, exDate) {
  return existing.some((d) => d.symbol === symbol && (d.ex_date === exDate || (d.ex_date === '' && nearExDate(exDate, d.date))));
}

/** A zero-cost BUY of the symbol (an imported or hand-entered 配股) dated -3..60 days from the ex-date. */
export function stockDividendRecorded(txns, symbol, exDate) {
  return txns.some((t) => t.symbol === symbol && isBonusShares(t) && nearExDate(exDate, t.date));
}

/**
 * 台股配股 as Yahoo reports it: a split whose ratio is under 2 (a real split, e.g. 0050's 1→4,
 * is ≥ 2 and left alone; AI 匯入 already converts trades across those).
 */
export const isStockDividend = (market, ratio) => market === 'TW' && ratio > 1 && ratio < 2;

/** Run fns with at most n in flight. */
async function pool(fns, n) {
  const out = new Array(fns.length);
  let i = 0;
  const worker = async () => {
    while (i < fns.length) {
      const k = i++;
      out[k] = await fns[k]();
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, fns.length) }, worker));
  return out;
}

/**
 * Estimates unrecorded dividends from Yahoo events × shares held before each ex-date, newest first.
 * 台股 also gets 配股 rows (kind 'stock': whole new shares, fractions are paid in cash) and cash amounts
 * restored from Yahoo's split-adjusted figures; a suggested 配股 counts toward later ex-dates even before
 * it is imported. Returns { suggestions, errors } where errors lists symbols Yahoo failed for. Throws
 * MarketUnavailableError when no market source is configured.
 *
 * opts.fetchHistory(symbol, sinceDate) → { cash, splits } and opts.today ('YYYY-MM-DD') are
 * injectable for tests.
 */
export async function dividendSuggestions(opts = {}) {
  const fetchHistory = opts.fetchHistory || fetchDividendHistory;
  const today = opts.today || db.today();

  const counted = db.where('stock_transactions', isCounted);
  const events = new Map(); // symbol -> [{date, action, shares}]
  const meta = new Map(); // symbol -> [market, currency]
  const firstBuy = new Map();
  for (const t of counted) {
    if (!events.has(t.symbol)) events.set(t.symbol, []);
    events.get(t.symbol).push({ date: t.date, action: t.action, shares: t.shares });
    meta.set(t.symbol, [t.market, t.currency]);
    if (t.action === 'BUY' && (!firstBuy.get(t.symbol) || t.date < firstBuy.get(t.symbol))) {
      firstBuy.set(t.symbol, t.date);
    }
  }

  const existing = queryDividends('');
  const usWithholding = settingFloat('us_div_withholding', 0.30, (v) => v >= 0 && v < 1);

  const jobs = [];
  for (const [sym, fb] of firstBuy) {
    const since = new Date(fb + 'T00:00:00Z');
    if (Number.isNaN(since.getTime())) continue;
    jobs.push(async () => {
      try {
        return { symbol: sym, evs: (await fetchHistory(sym, since)) || {} };
      } catch (err) {
        return { symbol: sym, err };
      }
    });
  }
  const results = await pool(jobs, 4); // be polite to Yahoo

  const unavailable = results.find((r) => r.err instanceof MarketUnavailableError);
  if (unavailable) throw unavailable.err;

  const suggestions = [];
  const errors = [];
  for (const res of results) {
    if (res.err) {
      errors.push(`${res.symbol}: ${res.err.message || res.err}`);
      continue;
    }
    const [market, currency] = meta.get(res.symbol);
    const splits = (res.evs.splits || []).filter((sp) => isStockDividend(market, sp.ratio));
    // Entitled shares = bought before the ex-date and not sold before it; suggested 配股 join the history.
    const hist = [...events.get(res.symbol)];
    const sharesBefore = (exDate) => hist.reduce((n, he) => (he.date < exDate ? n + (he.action === 'BUY' ? he.shares : -he.shares) : n), 0);
    const timeline = [
      ...(res.evs.cash || []).map((ev) => ({ ...ev, kind: 'cash' })),
      ...splits.map((ev) => ({ ...ev, kind: 'stock' })),
    ].filter((ev) => ev.ex_date <= today).sort((a, b) => cmp(a.ex_date, b.ex_date));
    for (const ev of timeline) {
      const shares = sharesBefore(ev.ex_date);
      if (shares <= 1e-9) continue;
      if (ev.kind === 'stock') {
        const add = Math.floor(shares * (ev.ratio - 1) + 1e-6);
        if (add < 1 || stockDividendRecorded(counted, res.symbol, ev.ex_date)) continue;
        hist.push({ date: ev.ex_date, action: 'BUY', shares: add });
        suggestions.push({
          kind: 'stock', symbol: res.symbol, market, currency, ex_date: ev.ex_date,
          per_thousand: round4((ev.ratio - 1) * 1000), shares, new_shares: add,
        });
        continue;
      }
      if (dividendAlreadyRecorded(existing, res.symbol, ev.ex_date)) continue;
      // Yahoo divides a dividend by every later split; undo that for the 配股 we count as shares.
      let perShare = ev.per_share;
      for (const sp of splits) if (sp.ex_date > ev.ex_date) perShare *= sp.ratio;
      perShare = Math.round(perShare * 1e6) / 1e6;
      const est = estimateDividend(market, currency, shares * perShare, usWithholding);
      suggestions.push({
        kind: 'cash', symbol: res.symbol, market, currency, ex_date: ev.ex_date,
        per_share: perShare, shares,
        gross: est.gross, amount: est.amount, withheld: est.withheld,
      });
    }
  }
  suggestions.sort((a, b) => cmp(b.ex_date, a.ex_date) || cmp(a.symbol, b.symbol) || cmp(a.kind, b.kind));
  errors.sort(cmp);
  return { suggestions, errors };
}

route('GET', '/api/dividends/suggestions', async () => {
  try {
    return await dividendSuggestions();
  } catch (e) {
    if (e instanceof MarketUnavailableError) {
      throw new HttpError(503, '無法取得除息資料：這個網站沒有設定 Yahoo 行情代理（js/config.js 的 DEFAULT_YAHOO_PROXY），無法估算股利。');
    }
    throw e;
  }
});
