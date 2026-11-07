// 穿透持股: split each ETF's market value over its top holdings (Yahoo topHoldings) and
// add it to what is held directly, keeping where every dollar came from. The math is pure
// (lookThrough) so it is tested without quotes.

import { route } from './router.js';
import { listHoldings } from './stocks.js';
import { fetchFundHoldings } from './market.js';
import { concentrationLevel, effectiveCount } from './portfolio.js';
import { marketForSymbol } from './util.js';

/** Listings of the same company merged into one row (ADR → Taiwan share, share classes). */
export const SAME_COMPANY = { TSM: '2330.TW', UMC: '2303.TW', ASX: '3711.TW', CHT: '2412.TW', GOOG: 'GOOGL' };

/** What is left of an ETF after its listed holdings: the rest of a stock fund, or a bond fund. */
export const REST = '__rest__';
export const BOND = '__bond__';

/**
 * holdings: as /api/stocks returns them (symbol, market, market_value_twd).
 * funds: { symbol: fetchFundHoldings() result, or null when it could not be fetched };
 * a symbol missing from funds (or is_fund false) is a plain stock.
 *
 * Each row: { key, name, market, kind: 'stock' | 'unresolved' | 'rest' | 'bond', lumped,
 *   value, direct, from_etf, via: { etf: value }, held_as: [direct symbols], weight, etf_weight, level }.
 * weight is the share of all stocks, etf_weight the share of ETF money only. Lumped rows
 * (rest / bond: many small positions) sort last and are left out of the concentration figures.
 */
export function lookThrough({ holdings, funds }) {
  const rows = new Map();
  const row = (key, init) => {
    if (!rows.has(key)) rows.set(key, { key, name: '', market: marketForSymbol(key), kind: 'stock', direct: 0, from_etf: 0, via: {}, held_as: [], ...init });
    return rows.get(key);
  };
  const addVia = (r, etf, v) => {
    r.from_etf += v;
    r.via[etf] = (r.via[etf] || 0) + v;
  };
  const etfs = [];
  const unresolved = [];
  const values = [];
  let top = null;
  let total = 0;
  let etfTotal = 0;

  for (const h of holdings) {
    const mv = h.market_value_twd;
    if (!(mv > 0)) continue;
    total += mv;
    values.push(mv);
    if (!top || mv > top.market_value_twd) top = h;
    const f = funds[h.symbol];

    if (!f || !f.is_fund) {
      if (f === null) unresolved.push(h.symbol);
      const r = row(SAME_COMPANY[h.symbol] || h.symbol, f === null ? { kind: 'unresolved', market: h.market } : {});
      r.direct += mv;
      if (!r.held_as.includes(h.symbol)) r.held_as.push(h.symbol);
      continue;
    }

    etfTotal += mv;
    let listed = 0;
    for (const c of f.holdings) {
      const r = row(SAME_COMPANY[c.symbol] || c.symbol);
      if (!r.name) r.name = c.name;
      addVia(r, h.symbol, mv * c.weight);
      listed += mv * c.weight;
    }
    if (mv > listed) {
      addVia(f.bond >= 0.5
        ? row(BOND, { kind: 'bond', name: '債券', market: '' })
        : row(REST, { kind: 'rest', name: '其他成分股', market: '' }), h.symbol, mv - listed);
    }
    etfs.push({ symbol: h.symbol, value: mv, listed: listed / mv });
  }
  if (!(total > 0)) return null;

  const out = [...rows.values()].map((r) => {
    const lumped = r.kind === 'rest' || r.kind === 'bond';
    const value = r.direct + r.from_etf;
    const weight = value / total * 100;
    return {
      ...r, lumped, value, weight,
      etf_weight: etfTotal > 0 ? r.from_etf / etfTotal * 100 : 0,
      level: lumped ? '' : concentrationLevel(weight),
    };
  });
  out.sort((a, b) => (a.lumped - b.lumped) || (b.value - a.value));

  const named = out.filter((r) => !r.lumped);
  const beforeTop = top.market_value_twd / total * 100;
  return {
    rows: out,
    total,
    etf_total: etfTotal,
    direct_total: total - etfTotal,
    etfs: etfs.sort((a, b) => b.value - a.value),
    unresolved,
    // Concentration before (an ETF counted as one holding) and after looking through
    before: { top: { symbol: top.symbol, weight: beforeTop, level: concentrationLevel(beforeTop) }, effective: effectiveCount(values.map((v) => v / total * 100)) },
    after: named.length
      ? { top: { symbol: named[0].key, weight: named[0].weight, level: named[0].level }, effective: effectiveCount(named.map((r) => r.weight)) }
      : null,
  };
}

// Only funds have holdings; the quote's instrument type (unknown without a proxy) saves a lookup per stock.
const mayBeFund = (h) => !h.type || h.type === 'ETF' || h.type === 'MUTUALFUND';

async function lookThroughData() {
  const holdings = (await listHoldings()).holdings;
  const funds = {};
  await Promise.all(holdings.filter(mayBeFund).map(async (h) => {
    try {
      funds[h.symbol] = await fetchFundHoldings(h.symbol);
    } catch (e) {
      funds[h.symbol] = null;
    }
  }));
  return lookThrough({ holdings, funds });
}

route('GET', '/api/stocks/lookthrough', lookThroughData);
