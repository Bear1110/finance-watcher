// 組合分析: concentration, USD share of net worth and dividend cash flow.
// The math is pure (portfolioStats) so it is tested without quotes.

import { route } from './router.js';
import { storedUSDTWDRate, toTWD } from './util.js';
import { listHoldings } from './stocks.js';
import { carriedCash, netWorthOf } from './assets.js';
import { countedOtherAssets } from './other_assets.js';
import { dividendsBySymbol } from './dividends.js';

/** Concentration by market-value weight (%): '' | 'warn' (≥ 25) | 'danger' (≥ 40). */
export const concentrationLevel = (pct) => (pct >= 40 ? 'danger' : pct >= 25 ? 'warn' : '');


/**
 * holdings: as /api/stocks returns them; ttmTWD: { symbol: trailing-12-month dividends in TWD };
 * cash: carriedCash() or null; rate: USD/TWD; other: 其他資產 counted in net worth (TWD). TW/US split is by market, USD exposure by currency.
 */
export function portfolioStats({ holdings, ttmTWD, cash, rate, other = 0 }) {
  const totalValue = holdings.reduce((s, h) => s + h.market_value_twd, 0);
  if (!(totalValue > 0)) return null;
  const totalCost = holdings.reduce((s, h) => s + h.cost_twd, 0);
  const yieldOn = (div, cost) => (cost > 0 && div > 0 ? div / cost * 100 : null);

  const rows = holdings.map((h) => {
    const weight = h.market_value_twd / totalValue * 100;
    return {
      symbol: h.symbol,
      market: h.market,
      weight,
      cost_weight: totalCost > 0 ? h.cost_twd / totalCost * 100 : 0,
      pl: h.unrealized_pl_twd,
      pl_percent: h.pl_percent,
      yield_cost: yieldOn(ttmTWD[h.symbol], h.cost_twd),
      level: concentrationLevel(weight),
    };
  }).sort((a, b) => b.weight - a.weight);

  const sumBy = (pred) => holdings.filter(pred).reduce((s, h) => s + h.market_value_twd, 0);
  const tw = sumBy((h) => h.market === 'TW');
  const usdStock = sumBy((h) => h.currency === 'USD');
  const usdCash = cash ? cash.usd * rate : 0;
  const netWorth = netWorthOf({ cashTWD: cash ? cash.twd : 0, cashUSD: cash ? cash.usd : 0, rate, stocks: totalValue, other });
  const ttm = Object.values(ttmTWD).reduce((s, v) => s + v, 0);

  return {
    rows,
    top3: rows.slice(0, 3).reduce((s, r) => s + r.weight, 0),
    effective: 1 / rows.reduce((s, r) => s + (r.weight / 100) ** 2, 0),
    usd: { stock: usdStock, cash: cash ? usdCash : null, pct: netWorth > 0 ? (usdStock + usdCash) / netWorth * 100 : null },
    dividends: { ttm, yield_cost: yieldOn(ttm, totalCost) },
    split: { tw, us: totalValue - tw },
  };
}

/** Trailing-12-month dividends per symbol, in TWD. */
export function ttmDividendsTWD(rate) {
  const out = {};
  for (const d of dividendsBySymbol()) {
    if (d.ttm) out[d.symbol] = (out[d.symbol] || 0) + toTWD(d.ttm, d.currency, rate);
  }
  return out;
}

route('GET', '/api/stocks/portfolio', async () => {
  const rate = storedUSDTWDRate();
  const ttmTWD = ttmDividendsTWD(rate);
  return portfolioStats({
    holdings: (await listHoldings()).holdings,
    ttmTWD,
    cash: carriedCash(),
    rate,
    other: countedOtherAssets(),
  });
});
