// Stock names shown next to symbols ("2330 台積電", "AAPL Apple Inc."), on the pages and in the AI prompt.
// 台股: Chinese names from TWSE open data (the proxy's /tw-names); others: Yahoo's short name.
// Cached in the local stock_names table (not synced); a symbol with no name found is retried after a day.

import * as db from './db.js';
import { route } from './router.js';
import { fetchQuotes, fetchTWNames, hasProxy } from './market.js';

const DAY_MS = 24 * 3600 * 1000;
const NAME_TTL_MS = 30 * DAY_MS;

/** '2330' for 2330.TW / 2330.TWO, null for other markets. */
export const twCode = (symbol) => symbol.match(/^([0-9A-Z]+)\.TWO?$/i)?.[1].toUpperCase() ?? null;

/** Every cached name: { symbol: name } (the pages and the AI prompt use the same table). */
export function allNames() {
  return Object.fromEntries(db.all('stock_names').filter((r) => r.name).map((r) => [r.symbol, r.name]));
}

function stale(symbol, now) {
  const r = db.findBy('stock_names', 'symbol', symbol);
  if (!r) return true;
  return now - Date.parse(r.fetched_at) > (r.name ? NAME_TTL_MS : DAY_MS);
}

/** Look up the symbols whose name is missing or old; failures just leave them for next time. */
export async function refreshNames(symbols) {
  if (!hasProxy()) return;
  const now = Date.now();
  const todo = [...new Set(symbols)].filter((s) => s && stale(s, now));
  if (!todo.length) return;
  const fetchedAt = new Date(now).toISOString();
  const save = (symbol, name) => db.upsert('stock_names', { symbol, name: name || '', fetched_at: fetchedAt });

  const tw = todo.filter(twCode);
  const other = todo.filter((s) => !twCode(s));
  await Promise.all([
    tw.length && fetchTWNames(tw.map(twCode))
      .then((names) => tw.forEach((s) => save(s, names[twCode(s)])))
      .catch((e) => console.warn('tw names', e.message)),
    other.length && fetchQuotes(other)
      .then((quotes) => other.forEach((s) => { if (quotes[s]) save(s, quotes[s].name); }))
      .catch((e) => console.warn('names', e.message)),
  ]);
}

/**
 * GET /api/stocks/names[?symbols=A,B]: every cached name { symbol: name }; with symbols, those are
 * looked up first when missing (the page asks for the ones it is about to show).
 */
route('GET', '/api/stocks/names', async (req) => {
  const symbols = (req.query.get('symbols') || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  if (symbols.length) await refreshNames(symbols);
  return allNames();
});
