// 組合分析: concentration, USD share of net worth, dividend cash flow and TW/US rebalance.
// The math is pure (portfolioStats / rebalance) so it is tested without quotes.

import * as db from './db.js';
import { route } from './router.js';
import { storedUSDTWDRate, toTWD } from './util.js';
import { listHoldings } from './stocks.js';
import { carriedCash } from './assets.js';
import { dividendsBySymbol } from './dividends.js';

/** Concentration by market-value weight (%): '' | 'warn' (≥ 25) | 'danger' (≥ 40). */
export const concentrationLevel = (pct) => (pct >= 40 ? 'danger' : pct >= 25 ? 'warn' : '');

/**
 * How to bring TW stocks to targetPct of the stock total: buy only the under-weight side,
 * or switch money from the over-weight side. null without a valid target; in_range within 1%.
 */
export function rebalance(tw, us, targetPct) {
  const total = tw + us;
  if (!(total > 0) || targetPct == null || !(targetPct >= 0 && targetPct <= 100)) return null;
  const twTarget = targetPct / 100 * total;
  const gap = twTarget - tw; // > 0: TW under target
  if (Math.abs(gap) < total * 0.01) return { target: targetPct, in_range: true };
  const under = gap > 0 ? 'TW' : 'US';
  const underValue = under === 'TW' ? tw : us;
  const underShare = under === 'TW' ? targetPct / 100 : 1 - targetPct / 100;
  // Buy X of the under side so that (underValue + X) / (total + X) = underShare
  const buyOnly = underShare < 1 ? (underShare * total - underValue) / (1 - underShare) : null;
  return { target: targetPct, in_range: false, under, buy_only: buyOnly, switch: Math.abs(gap) };
}

/**
 * holdings: as /api/stocks returns them; ttmTWD: { symbol: trailing-12-month dividends in TWD };
 * cash: carriedCash() or null; rate: USD/TWD. TW/US split is by market, USD exposure by currency.
 */
export function portfolioStats({ holdings, ttmTWD, cash, rate, targetPct }) {
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
  const netWorth = totalValue + (cash ? cash.twd : 0) + usdCash;
  const ttm = Object.values(ttmTWD).reduce((s, v) => s + v, 0);

  return {
    rows,
    top3: rows.slice(0, 3).reduce((s, r) => s + r.weight, 0),
    effective: 1 / rows.reduce((s, r) => s + (r.weight / 100) ** 2, 0),
    usd: { stock: usdStock, cash: cash ? usdCash : null, pct: netWorth > 0 ? (usdStock + usdCash) / netWorth * 100 : null },
    dividends: { ttm, yield_cost: yieldOn(ttm, totalCost) },
    split: { tw, us: totalValue - tw },
    target_tw: targetPct,
    rebalance: rebalance(tw, totalValue - tw, targetPct),
  };
}

route('GET', '/api/stocks/portfolio', async () => {
  const rate = storedUSDTWDRate();
  const ttmTWD = {};
  for (const d of dividendsBySymbol()) {
    if (d.ttm) ttmTWD[d.symbol] = (ttmTWD[d.symbol] || 0) + toTWD(d.ttm, d.currency, rate);
  }
  const target = db.getSetting('rebalance_target_tw');
  return portfolioStats({
    holdings: (await listHoldings()).holdings,
    ttmTWD,
    cash: carriedCash(),
    rate,
    targetPct: target === '' || target == null ? null : Number(target),
  });
});
