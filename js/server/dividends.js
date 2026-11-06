// Cash dividends, Yahoo-based suggestions and
// per-symbol totals. (/api/dividends/export lives in export.js.)

import * as db from './db.js';
import { route } from './router.js';
import { fetchDividendHistory, MarketUnavailableError } from './market.js';
import {
  HttpError, badRequest, body, cmp, isCounted, normalizeSymbolMarket, settingFloat, storedUSDTWDRate,
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

// All-or-nothing import (used by the Yahoo suggestions list).
route('POST', '/api/dividends/batch', async (req) => {
  const list = body(req);
  if (!Array.isArray(list)) throw badRequest('invalid JSON: expected an array');
  const items = list.map((raw) => {
    const d = { ...raw };
    try {
      return normalizeDividend(d);
    } catch (e) {
      throw badRequest(`${d.symbol}: ${e.message}`);
    }
  });
  await db.transaction(async () => {
    for (const d of items) insertDividend(d);
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

function localDate(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Dividends received per symbol in its own currency: all-time and trailing 12 months. */
export function dividendsBySymbol() {
  const c = new Date();
  c.setFullYear(c.getFullYear() - 1);
  const cutoff = localDate(c);
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

/**
 * Matches an imported record by ex_date, or a manually entered one (no ex_date)
 * paid between 3 days before and 60 days after the ex-date.
 */
export function dividendAlreadyRecorded(existing, symbol, exDate) {
  const ex = Date.parse(exDate);
  if (Number.isNaN(ex)) return false;
  for (const d of existing) {
    if (d.symbol !== symbol) continue;
    if (d.ex_date === exDate) return true;
    if (d.ex_date === '') {
      const paid = Date.parse(d.date);
      if (!Number.isNaN(paid)) {
        const days = (paid - ex) / 86400000;
        if (days >= -3 && days <= 60) return true;
      }
    }
  }
  return false;
}

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
 * Estimates unrecorded dividends from Yahoo ex-dividend events × shares held
 * before each ex-date, newest first. Returns { suggestions, errors } where
 * errors lists symbols Yahoo failed for. Throws MarketUnavailableError when no
 * market source is configured.
 *
 * opts.fetchHistory(symbol, sinceDate) and opts.today ('YYYY-MM-DD') are
 * injectable for tests.
 */
export async function dividendSuggestions(opts = {}) {
  const fetchHistory = opts.fetchHistory || fetchDividendHistory;
  const today = opts.today || db.today();

  const events = new Map(); // symbol -> [{date, action, shares}]
  const meta = new Map(); // symbol -> [market, currency]
  const firstBuy = new Map();
  for (const t of db.where('stock_transactions', isCounted)) {
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
        return { symbol: sym, evs: (await fetchHistory(sym, since)) || [] };
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
    for (const ev of res.evs) {
      if (ev.ex_date > today) continue;
      // Entitled shares = bought before the ex-date and not sold before it.
      let shares = 0;
      for (const he of events.get(res.symbol)) {
        if (he.date >= ev.ex_date) continue;
        shares += he.action === 'BUY' ? he.shares : -he.shares;
      }
      if (shares <= 1e-9) continue;
      if (dividendAlreadyRecorded(existing, res.symbol, ev.ex_date)) continue;
      const est = estimateDividend(market, currency, shares * ev.per_share, usWithholding);
      suggestions.push({
        symbol: res.symbol, market, currency, ex_date: ev.ex_date,
        per_share: ev.per_share, shares,
        gross: est.gross, amount: est.amount, withheld: est.withheld,
      });
    }
  }
  suggestions.sort((a, b) => cmp(b.ex_date, a.ex_date) || cmp(a.symbol, b.symbol));
  errors.sort(cmp);
  return { suggestions, errors };
}

route('GET', '/api/dividends/suggestions', async () => {
  try {
    return await dividendSuggestions();
  } catch (e) {
    if (e instanceof MarketUnavailableError) {
      throw new HttpError(503, '無法取得除息資料：請先在「設定 → 行情來源」設定 Yahoo 行情代理，才能估算股利。');
    }
    throw e;
  }
});
