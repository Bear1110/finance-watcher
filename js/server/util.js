// Shared helpers for the route handlers.

import { getSetting, setSetting, today } from './db.js';
import { fetchUSDTWDRate } from './market.js';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const badRequest = (msg) => new HttpError(400, msg);

/** Self trades that are real ledger activity. */
export const isCounted = (t) => t.account_id == null && !isHistorySell(t);

/** Imported-history SELLs: fixed realized_pl, no lots. */
export const isHistorySell = (t) => t.action === 'SELL' && t.pl_manual === 1 && t.lots_consumed === 0;

/** Self-account history SELLs (the ones performance estimates as a round trip). */
export const isSelfHistorySell = (t) => t.account_id == null && isHistorySell(t);

/** What the shares of a SELL cost to buy (buy fee included): proceeds − sell fee − tax − realized P&L. */
export const sellCostBasis = (t) => t.shares * t.price - (t.fee || 0) - (t.tax || 0) - t.realized_pl;

/**
 * % return of one SELL, or null when the shares cost (next to) nothing — e.g. bonus shares from a
 * stock dividend (配股), where P&L ≈ proceeds and a percentage would be meaningless (+23900%).
 */
export function sellReturnPct(t) {
  const cost = sellCostBasis(t);
  return cost > t.shares * t.price * 0.01 ? (t.realized_pl / cost) * 100 : null;
}

/** Numeric setting: def when missing, unparsable or rejected by valid. */
export function settingFloat(key, def, valid = () => true) {
  const s = getSetting(key);
  if (s === '') return def;
  const v = Number(s);
  return Number.isFinite(v) && valid(v) ? v : def;
}

export const storedUSDTWDRate = () => settingFloat('usd_twd_rate', 32.0, (v) => v > 0);

/** The user's Taiwan brokerage fee discount (設定), 1 = no discount. */
export const twFeeDiscount = () => settingFloat('tw_fee_discount', 1.0, (v) => v > 0 && v <= 1);

export const toTWD = (v, currency, rate) => (currency === 'USD' ? v * rate : v);

/** Sum of realized P&L of SELLs, in TWD. */
export const realizedTWD = (sells, rate) => sells.reduce((s, t) => s + toTWD(t.realized_pl, t.currency, rate), 0);

/** Yahoo's .TW / .TWO suffixes mean Taiwan, anything else US. */
export const marketForSymbol = (symbol) => (symbol.endsWith('.TW') || symbol.endsWith('.TWO') ? 'TW' : 'US');

export const currencyForMarket = (market) => (market === 'TW' ? 'TWD' : 'USD');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const isDate = (s) => DATE_RE.test(s) && !Number.isNaN(Date.parse(s));

/**
 * Upper-cases the symbol, defaults market from the symbol and currency from the
 * market, and checks the date (empty = today). Mutates obj; throws 400.
 */
export function normalizeSymbolMarket(obj) {
  obj.symbol = String(obj.symbol || '').trim().toUpperCase();
  if (!obj.symbol) throw badRequest('股票代號不可為空');
  if (!obj.market) obj.market = marketForSymbol(obj.symbol);
  if (obj.market !== 'US' && obj.market !== 'TW') throw badRequest('market must be US or TW');
  if (!obj.currency) obj.currency = currencyForMarket(obj.market);
  if (!obj.date) obj.date = today();
  else if (!isDate(obj.date)) throw badRequest('日期格式需為 YYYY-MM-DD');
  return obj;
}

/** 'YYYY-MM-DD HH:MM:SS' in local time. */
export function fmtLocal(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${today(d)} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Store a fetched USD/TWD rate; returns the timestamp string. */
export function persistRate(rate, at) {
  const ts = fmtLocal(at);
  setSetting('usd_twd_rate', rate.toFixed(4));
  setSetting('usd_twd_rate_updated_at', ts);
  return ts;
}

/**
 * Fetch the live USD/TWD rate, persist it to settings and return it. Falls back
 * to the stored rate on failure.
 */
export async function refreshAndPersistRate() {
  try {
    const { rate, at } = await fetchUSDTWDRate();
    persistRate(rate, at);
    return rate;
  } catch (e) {
    console.warn('[forex] refresh failed, using stored rate:', e.message);
    return storedUSDTWDRate();
  }
}

/**
 * A typed sum like "120,000+35000-2*500" → 154000: + − × ÷ with × ÷ first, no brackets. Commas,
 * spaces, full-width characters (中文輸入法) and ×÷ are fine. null when it isn't such a sum
 * (or divides by zero); '' is null too.
 */
const CALC_NUM = String.raw`(?:\d+\.?\d*|\.\d+)`;
const CALC_RE = new RegExp(String.raw`^-?${CALC_NUM}(?:[-+*/]${CALC_NUM})*$`);
const CALC_TERM = new RegExp(String.raw`(^-?|[-+*/])(${CALC_NUM})`, 'g');
export function calcExpr(s) {
  const t = String(s ?? '')
    .replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)) // full-width → ASCII
    .replace(/[,\s]/g, '').replace(/[−–]/g, '-').replace(/[×xX]/g, '*').replace(/÷/g, '/');
  if (!CALC_RE.test(t)) return null;
  let total = 0, term = 0;
  for (const [, op, n] of t.matchAll(CALC_TERM)) {
    const v = Number(n);
    if (op === '*') term *= v;
    else if (op === '/') term /= v;
    else { total += term; term = op === '-' ? -v : v; }
  }
  total += term;
  return Number.isFinite(total) ? Math.round(total * 1e8) / 1e8 : null; // 0.1+0.2 → 0.3
}

/** Round half away from zero (Math.round(-2.5) is -2). */
export const goRound = (v) => (v < 0 ? -Math.round(-v) : Math.round(v));
export const round4 = (v) => goRound(v * 1e4) / 1e4;
export const round2 = (v) => goRound(v * 100) / 100;

/** Whole days between two YYYY-MM-DD dates. */
export const daysBetween = (from, to) => Math.round((Date.parse(to) - Date.parse(from)) / 86400000);

/** Compare helpers for ORDER BY */
export const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Parse a JSON request body ('invalid JSON' → 400). */
export function body(req) {
  if (req.body == null || req.body === '') return {};
  if (typeof req.body === 'object') return req.body;
  try {
    return JSON.parse(req.body);
  } catch (e) {
    throw badRequest('invalid JSON: ' + e.message);
  }
}

/** A JSON file to hand to the browser (backups). */
export function download(filename, content) {
  return { __download: true, filename, content, type: 'application/json' };
}
