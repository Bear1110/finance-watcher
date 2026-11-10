// Stock names shown next to symbols ("2330 台積電", "AAPL Apple Inc."), on the pages and in the AI prompt.
// 台股: Chinese names from TWSE open data (the proxy's /tw-names); others: Yahoo's short name.
// Cached in the local stock_names table (not synced); a symbol with no name found is retried after a day.

import * as db from './db.js';
import { route } from './router.js';
import { fetchQuotes, fetchTWNames, hasProxy } from './market.js';
import { marketForSymbol } from './util.js';

const DAY_MS = 24 * 3600 * 1000;
const NAME_TTL_MS = 30 * DAY_MS;

/** '2330' for 2330.TW / 2330.TWO, null for other markets. */
export const twCode = (symbol) => (marketForSymbol(symbol) === 'TW' ? symbol.replace(/\.TWO?$/, '') : null);

/** Every cached name: { symbol: name } (the pages and the AI prompt use the same table). */
export function allNames() {
  return Object.fromEntries(db.all('stock_names').filter((r) => r.name).map((r) => [r.symbol, r.name]));
}

/** Every symbol the user has records of (holdings, transactions incl. managed accounts, dividends). */
export const ownSymbols = () =>
  [...new Set(['stock_holdings', 'stock_transactions', 'dividends'].flatMap((t) => db.all(t).map((r) => r.symbol)))];

function stale(symbol, now) {
  const r = db.findBy('stock_names', 'symbol', symbol);
  if (!r) return true;
  return now - Date.parse(r.fetched_at) > (r.name ? NAME_TTL_MS : DAY_MS);
}

/**
 * Look up the symbols whose name is missing or old. One with no name found is saved as '' (tried
 * again after a day); a failed request saves nothing, so the next call tries again. 台股: only codes in
 * the Worker's reply are saved — it leaves out the ones it didn't get to (too many at once) or
 * couldn't read, and '' means "no such code".
 */
export async function refreshNames(symbols) {
  if (!hasProxy()) return;
  const now = Date.now();
  const fetchedAt = new Date(now).toISOString();
  const save = (symbol, name) => db.upsert('stock_names', { symbol, name: name || '', fetched_at: fetchedAt });
  const tw = new Map(); // code -> symbol
  const other = [];
  for (const s of new Set(symbols)) {
    if (!s || !stale(s, now)) continue;
    const code = twCode(s);
    if (code) tw.set(code, s); else other.push(s);
  }
  await Promise.all([
    tw.size && fetchTWNames([...tw.keys()])
      .then((names) => tw.forEach((s, code) => { if (code in names) save(s, names[code]); }))
      .catch((e) => console.warn('tw names', e.message)),
    other.length && fetchQuotes(other)
      .then((quotes) => other.forEach((s) => save(s, quotes[s]?.name)))
      .catch((e) => console.warn('names', e.message)),
  ]);
}

/**
 * GET /api/stocks/names: every cached name { symbol: name }. ?refresh=1 first looks up the user's own
 * symbols that are missing or old; ?symbols=A,B those symbols (ETF holdings and others shown on a page).
 */
route('GET', '/api/stocks/names', async (req) => {
  const symbols = (req.query.get('symbols') || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  if (symbols.length) await refreshNames(symbols);
  else if (req.query.has('refresh')) await refreshNames(ownSymbols());
  return allNames();
});
