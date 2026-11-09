// Holdings, transactions and the realized P&L summary. (/api/stocks/xirr,
// /api/stocks/performance and /api/stocks/portfolio live in performance.js /
// twr.js / portfolio.js.)

import * as db from './db.js';
import { route } from './router.js';
import { fetchQuotes, invalidateCache, lastFetchTime } from './market.js';
import { dividendsBySymbol } from './dividends.js';
import {
  HttpError, badRequest, body, storedUSDTWDRate, twFeeDiscount, toTWD, realizedTWD, fmtLocal, round2, cmp, sellCostBasis, sellReturnPct,
} from './util.js';
import { replaySymbol, normalizeTxn, applyAutoFee, uncoveredWarnings, fmtShares } from './ledger.js';
import { estSellCost } from './lots.js';

const activeHoldings = () => db.where('stock_holdings', (h) => h.shares > 0);

const holdingJSON = (h) => ({
  id: h.id, symbol: h.symbol, market: h.market, shares: h.shares,
  avg_cost: h.avg_cost, currency: h.currency, note: h.note,
});

/** Holding row plus zeroed live-price fields. */
export function holdingDetail(h) {
  return {
    ...holdingJSON(h),
    current_price: 0, market_value: 0, unrealized_pl: 0, pl_percent: 0,
    market_value_twd: 0, cost_twd: 0, unrealized_pl_twd: 0, day_change_twd: 0, day_change_pct: 0,
  };
}

/** Transaction as the API returns it (auto_fee/manual_pl/account_id omitted when empty). */
export function txnJSON(t) {
  const out = {
    id: t.id, symbol: t.symbol, market: t.market, action: t.action,
    shares: t.shares, price: t.price, fee: t.fee, tax: t.tax,
  };
  if (t.auto_fee) out.auto_fee = true;
  if (t.manual_pl) out.manual_pl = true;
  Object.assign(out, {
    currency: t.currency, date: t.date, realized_pl: t.realized_pl,
    note: t.note ?? '', created_at: t.created_at ?? '',
  });
  if (t.account_id != null) out.account_id = t.account_id;
  return out;
}

/** Returns [twValueTWD, usValueTWD, totalValueTWD] of self holdings at live prices. */
export async function portfolioValues() {
  const rate = storedUSDTWDRate();
  const holdings = activeHoldings();
  if (!holdings.length) return [0, 0, 0];
  const quotes = await fetchQuotes(holdings.map((h) => h.symbol));
  let tw = 0;
  let us = 0;
  for (const h of holdings) {
    const price = quotes[h.symbol]?.price ?? 0;
    let mv = h.shares * price;
    if (h.currency === 'USD') mv *= rate;
    if (h.market === 'TW') tw += mv; else us += mv;
  }
  return [tw, us, tw + us];
}

/** Self holdings at live prices (TWD totals included). */
export async function listHoldings() {
  const holdings = activeHoldings();
  const quotes = await fetchQuotes(holdings.map((h) => h.symbol));
  const rate = storedUSDTWDRate();
  const discount = twFeeDiscount();

  const realizedPLTWD = realizedTWD(db.where('stock_transactions', (t) => t.action === 'SELL' && t.account_id == null), rate);

  const summary = {
    holdings: [],
    total_cost_twd: 0,
    total_value_twd: 0,
    total_pl_twd: 0,
    total_pl_percent: 0,
    total_day_twd: 0,
    total_day_percent: 0,
    total_div_twd: 0,
    total_div_return_percent: 0,
    realized_pl_twd: realizedPLTWD,
  };
  // Per market in its own currency (持倉 page's 台股 / 美股 cards), only markets held
  const markets = new Map();
  // Dividends received from what is held (same currency as the holding), for 含股利報酬
  const divs = new Map(dividendsBySymbol().map((x) => [`${x.symbol}\u0000${x.currency}`, x.total]));

  for (const h of holdings) {
    const d = holdingDetail(h);
    const q = quotes[h.symbol];
    const day = q ? q.change * h.shares : 0; // native currency
    const cost = h.avg_cost * h.shares;
    const div = divs.get(`${h.symbol}\u0000${h.currency}`) || 0;
    if (q) {
      d.current_price = q.price;
      d.exchange = q.exchange;
      d.type = q.type;
      d.day_change_twd = toTWD(day, h.currency, rate);
      d.day_change_pct = q.change_percent;
      d.market_value = q.price * h.shares;
      // Net of what selling now would cost (台股 fee + tax), like a broker app's 預估損益
      d.unrealized_pl = (q.price - h.avg_cost) * h.shares - estSellCost(h.market, h.symbol, h.shares, q.price, discount);
      if (h.avg_cost > 0) d.pl_percent = d.unrealized_pl / cost * 100;
    }
    d.cost_twd = toTWD(cost, h.currency, rate);
    d.market_value_twd = toTWD(d.market_value, h.currency, rate);
    d.unrealized_pl_twd = toTWD(d.unrealized_pl, h.currency, rate);

    summary.total_cost_twd += d.cost_twd;
    summary.total_value_twd += d.market_value_twd;
    summary.total_pl_twd += d.unrealized_pl_twd;
    summary.total_day_twd += d.day_change_twd;
    summary.total_div_twd += toTWD(div, h.currency, rate);
    summary.holdings.push(d);

    if (!markets.has(h.market)) markets.set(h.market, { market: h.market, currency: h.currency, count: 0, cost: 0, value: 0, pl: 0, day: 0, div: 0 });
    const m = markets.get(h.market);
    m.count++;
    m.cost += cost;
    m.value += d.market_value;
    m.pl += d.unrealized_pl;
    m.day += day;
    m.div += div;
  }

  const pct = (part, base) => (base > 0 ? part / base * 100 : 0);
  summary.total_pl_percent = pct(summary.total_pl_twd, summary.total_cost_twd);
  summary.total_day_percent = pct(summary.total_day_twd, summary.total_value_twd - summary.total_day_twd); // vs previous close
  summary.total_div_return_percent = pct(summary.total_pl_twd + summary.total_div_twd, summary.total_cost_twd);
  summary.markets = ['TW', 'US'].filter((k) => markets.has(k)).map((k) => {
    const m = markets.get(k);
    return { ...m, pl_percent: pct(m.pl, m.cost), day_percent: pct(m.day, m.value - m.day), div_return_percent: pct(m.pl + m.div, m.cost) };
  });

  const fetchedAt = lastFetchTime();
  return { ...summary, quote_fetched_at: fetchedAt ? fmtLocal(fetchedAt) : '' };
}

async function addHolding(req) {
  const b = body(req);
  // Importing a position is recorded as a BUY, so holdings always derive from trades.
  const txn = normalizeTxn({
    symbol: b.symbol, market: b.market, action: 'BUY',
    shares: b.shares, price: b.avg_cost, currency: b.currency,
    date: b.date, note: b.note,
  });
  return db.transaction(async () => {
    const row = db.insert('stock_transactions', {
      symbol: txn.symbol, market: txn.market, action: 'BUY', shares: txn.shares, price: txn.price,
      fee: 0, tax: 0, currency: txn.currency, date: txn.date, realized_pl: 0, note: txn.note, is_transfer: 1,
    });
    const res = replaySymbol(txn.symbol);
    if (b.note) db.updateWhere('stock_holdings', (h) => h.symbol === txn.symbol, { note: b.note });
    return {
      id: row.id,
      symbol: txn.symbol,
      shares: res.shares,
      avg_cost: res.avgCost,
      message: '持倉已匯入，同時建立買入交易紀錄',
    };
  });
}

// DeleteHolding removes the position together with its BUY records. Keeping
// the BUYs would resurrect the position on the next replay. SELL records are
// kept so realized P&L history survives.
async function deleteHolding(req) {
  return db.transaction(async () => {
    const h = db.get('stock_holdings', req.params.id);
    if (!h) throw new HttpError(404, 'holding not found');
    db.removeWhere('stock_transactions', (t) => t.symbol === h.symbol && t.action === 'BUY' && t.account_id == null);
    db.remove('stock_holdings', h.id);
    return { status: 'deleted' };
  });
}

/** Own-account transactions, newest first; ?limit=N for the latest N (the page filters and searches itself). */
function listTransactions(req) {
  const txns = db.where('stock_transactions', (t) => t.account_id == null);
  txns.sort((a, b) => cmp(b.date, a.date) || cmp(b.created_at, a.created_at));
  const limit = Number(req.query.get('limit')) || txns.length;
  return txns.slice(0, limit).map(txnJSON);
}

/** Read and normalize a transaction body (400 on failure). */
function decodeTxn(req) {
  const b = body(req);
  const txn = { ...b };
  txn.auto_fee = !!b.auto_fee;
  txn.manual_pl = !!b.manual_pl;
  return normalizeTxn(txn);
}

/** Reject a SELL that replay could not match to enough BUYs. */
function checkCovered(res, id) {
  if (res.uncovered.has(id)) {
    throw badRequest(`賣出股數超過當時持股，缺少 ${fmtShares(res.uncovered.get(id))} 股的買入紀錄`);
  }
}

async function recordTransaction(req) {
  const txn = decodeTxn(req);
  if (txn.manual_pl) return recordManualSell(txn);
  applyAutoFee(txn);

  return db.transaction(async () => {
    const row = db.insert('stock_transactions', {
      symbol: txn.symbol, market: txn.market, action: txn.action, shares: txn.shares, price: txn.price,
      fee: txn.fee, tax: txn.tax, currency: txn.currency, date: txn.date, realized_pl: 0, note: txn.note,
    });
    txn.id = row.id;
    const res = replaySymbol(txn.symbol);
    checkCovered(res, txn.id);
    txn.realized_pl = db.get('stock_transactions', txn.id).realized_pl;
    txn.created_at = '';
    delete txn.account_id;
    return txnJSON(txn);
  });
}

// A historical SELL with a caller-supplied realized_pl: consumes no lots and
// leaves stock_holdings alone.
function recordManualSell(txn) {
  if (txn.action !== 'SELL') throw badRequest('manual_pl only applies to SELL');
  const row = db.insert('stock_transactions', {
    symbol: txn.symbol, market: txn.market, action: 'SELL', shares: txn.shares, price: txn.price,
    fee: txn.fee, tax: txn.tax, currency: txn.currency, date: txn.date, realized_pl: txn.realized_pl,
    pl_manual: 1, lots_consumed: 0, note: txn.note,
  });
  txn.id = row.id;
  txn.created_at = '';
  delete txn.account_id;
  return txnJSON(txn);
}

async function updateTransaction(req) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw badRequest('invalid id');
  const txn = decodeTxn(req);
  applyAutoFee(txn);

  return db.transaction(async () => {
    const old = db.get('stock_transactions', id);
    if (!old || old.account_id != null) throw new HttpError(404, 'transaction not found');

    // Replayed SELLs get realized_pl recomputed (client value ignored). A
    // manual SELL keeps its flag and takes realized_pl from the client.
    const manual = old.pl_manual === 1 && txn.action === 'SELL';
    db.update('stock_transactions', id, {
      symbol: txn.symbol, market: txn.market, action: txn.action, shares: txn.shares, price: txn.price,
      fee: txn.fee, tax: txn.tax, currency: txn.currency, date: txn.date, note: txn.note,
      pl_manual: manual ? 1 : 0,
      realized_pl: manual ? txn.realized_pl : old.realized_pl,
    });

    const warnings = [];
    if (old.symbol !== txn.symbol) {
      // The trade left the old symbol; rebuild that position without it.
      warnings.push(...uncoveredWarnings(replaySymbol(old.symbol), old.symbol));
    }
    const res = replaySymbol(txn.symbol);
    checkCovered(res, id);
    return { status: 'updated', warnings: warnings.length ? warnings : null };
  });
}

async function deleteTransaction(req) {
  return db.transaction(async () => {
    const t = db.get('stock_transactions', req.params.id);
    if (!t || t.account_id != null) throw new HttpError(404, 'transaction not found');
    db.remove('stock_transactions', t.id);
    const w = uncoveredWarnings(replaySymbol(t.symbol), t.symbol);
    return { status: 'deleted', warnings: w.length ? w : null };
  });
}

/**
 * Trade quality from each SELL's realized P&L (TWD): win rate alone hides how big the wins and
 * losses are. profit_factor = gross profit ÷ gross loss (null: no losses); payoff = average win ÷
 * average loss; expectancy = average P&L per trade.
 */
export function tradeStats(pls) {
  const wins = pls.filter((v) => v > 0);
  const losses = pls.filter((v) => v < 0);
  const grossProfit = wins.reduce((s, v) => s + v, 0);
  const grossLoss = -losses.reduce((s, v) => s + v, 0);
  const avgWin = wins.length ? grossProfit / wins.length : 0;
  const avgLoss = losses.length ? grossLoss / losses.length : 0;
  return {
    trades: pls.length,
    wins: wins.length,
    losses: losses.length,
    flat: pls.length - wins.length - losses.length,
    win_rate: pls.length ? round2(wins.length / pls.length * 100) : 0,
    gross_profit: round2(grossProfit),
    gross_loss: round2(grossLoss),
    avg_win: round2(avgWin),
    avg_loss: round2(avgLoss),
    payoff: avgWin > 0 && avgLoss > 0 ? round2(avgWin / avgLoss) : null,
    profit_factor: grossLoss > 0 ? round2(grossProfit / grossLoss) : null,
    expectancy: pls.length ? round2((grossProfit - grossLoss) / pls.length) : 0,
  };
}

/**
 * 已實現損益 of the self account, optionally for one year ('' = all): per stock, trade stats per market
 * (tradeStats), best / worst trade, and dividends. Shared by the 已實現損益 page and the AI prompt.
 */
export function summarizeRealized(yearFilter = '') {
  const sells = db.where('stock_transactions', (t) => t.action === 'SELL' && t.account_id == null)
    .sort((a, b) => cmp(a.symbol, b.symbol) || cmp(a.date, b.date));

  const yearSet = new Set();
  const symbolOrder = [];
  const symbolTrades = new Map();

  for (const t of sells) {
    if (t.date.length >= 4) yearSet.add(t.date.slice(0, 4));
    if (yearFilter && (t.date.length < 4 || t.date.slice(0, 4) !== yearFilter)) continue;
    if (!symbolTrades.has(t.symbol)) {
      symbolOrder.push(t.symbol);
      symbolTrades.set(t.symbol, []);
    }
    symbolTrades.get(t.symbol).push(t);
  }

  const rate = storedUSDTWDRate();
  const byStock = [];
  let overallPLUSD = 0;
  let overallPLTWD = 0;
  let bestOverallPct = -Number.MAX_VALUE;
  let worstOverallPct = Number.MAX_VALUE;
  let bestTrade = { symbol: '', pl: 0, pct: 0 };
  let worstTrade = { symbol: '', pl: 0, pct: 0 };
  const tradePLs = { ALL: [], TW: [], US: [] }; // each SELL's realized P&L in TWD

  for (const sym of symbolOrder) {
    const trades = symbolTrades.get(sym);
    const meta = trades[0];
    let totalShares = 0;
    let totalRevenue = 0;
    let totalRealizedPL = 0;
    let totalCost = 0;
    const pcts = [];

    for (const t of trades) {
      const revenue = t.shares * t.price;
      const tradePct = sellReturnPct(t); // null: no real cost (配股), left out of best/worst

      totalShares += t.shares;
      totalRevenue += revenue;
      totalCost += sellCostBasis(t);
      totalRealizedPL += t.realized_pl;
      if (tradePct != null) {
        pcts.push(tradePct);
        if (tradePct > bestOverallPct) {
          bestOverallPct = tradePct;
          bestTrade = { symbol: t.symbol, pl: t.realized_pl, pct: round2(tradePct) };
        }
        if (tradePct < worstOverallPct) {
          worstOverallPct = tradePct;
          worstTrade = { symbol: t.symbol, pl: t.realized_pl, pct: round2(tradePct) };
        }
      }

      const plTWD = toTWD(t.realized_pl, t.currency, rate);
      tradePLs.ALL.push(plTWD);
      (tradePLs[t.market] || tradePLs.US).push(plTWD);
    }

    const avgReturnPct = totalCost > 0 ? (totalRealizedPL / totalCost) * 100 : 0;

    byStock.push({
      symbol: sym,
      market: meta.market,
      total_trades: trades.length,
      total_shares_sold: totalShares,
      total_revenue: round2(totalRevenue),
      total_cost: round2(totalCost),
      total_realized_pl: round2(totalRealizedPL),
      avg_return_pct: round2(avgReturnPct),
      best_trade_pct: pcts.length ? round2(Math.max(...pcts)) : null, // null: only 配股 sales
      worst_trade_pct: pcts.length ? round2(Math.min(...pcts)) : null,
      currency: meta.currency,
    });

    if (meta.currency === 'USD') {
      overallPLUSD += totalRealizedPL;
      overallPLTWD += totalRealizedPL * rate;
    } else {
      overallPLTWD += totalRealizedPL;
    }
  }

  // SUM(amount) GROUP BY symbol, market, currency ORDER BY symbol
  const groups = new Map();
  for (const d of db.where('dividends', (d) => !yearFilter || d.date.slice(0, 4) === yearFilter)) {
    const k = `${d.symbol}\u0000${d.market}\u0000${d.currency}`;
    const g = groups.get(k) || { symbol: d.symbol, market: d.market, currency: d.currency, total: 0 };
    g.total += d.amount;
    groups.set(k, g);
  }
  const dividends = [...groups.values()]
    .sort((a, b) => cmp(a.symbol, b.symbol) || cmp(a.market, b.market) || cmp(a.currency, b.currency));

  return {
    dividends,
    by_stock: byStock,
    overall: {
      total_realized_pl_usd: round2(overallPLUSD),
      total_realized_pl_twd: round2(overallPLTWD),
      usd_twd_rate: rate,
      best_trade: bestTrade,
      worst_trade: worstTrade,
    },
    // Trade counts, win rate and trade quality per market (ALL / TW / US)
    trade_stats: Object.fromEntries(Object.entries(tradePLs).map(([m, pls]) => [m, tradeStats(pls)])),
    years: [...yearSet].sort().reverse(),
  };
}

route('GET', '/api/stocks', listHoldings);
route('POST', '/api/stocks', addHolding);
route('DELETE', '/api/stocks/{id}', deleteHolding);
route('GET', '/api/transactions', listTransactions);
route('POST', '/api/transactions', recordTransaction);
route('PUT', '/api/transactions/{id}', updateTransaction);
route('DELETE', '/api/transactions/{id}', deleteTransaction);
route('GET', '/api/transactions/summary', (req) => summarizeRealized(req.query.get('year') || ''));
// Wipe the self account's trades and holdings of one market (e.g. before importing full broker
// statements). Dividends, snapshots, expenses and managed accounts stay.
// Body: { market: 'TW' | 'US' | 'ALL', dry } → { market, transactions, holdings }; dry only counts.
// The real call must send `expect` (the dry run's counts): if anything differs, nothing is deleted.
// The page checks the dry run echoes its market, so a page newer than this code can't wipe more.
route('POST', '/api/stocks/clear', async (req) => {
  const r = body(req);
  if (!['TW', 'US', 'ALL'].includes(r.market)) throw badRequest('market must be TW, US or ALL');
  const inMarket = (x) => r.market === 'ALL' || x.market === r.market;
  const txn = (t) => t.account_id == null && inMarket(t);
  const counts = { market: r.market, transactions: db.where('stock_transactions', txn).length, holdings: db.where('stock_holdings', inMarket).length };
  if (r.dry) return counts;
  if (r.expect?.transactions !== counts.transactions || r.expect?.holdings !== counts.holdings) {
    throw badRequest('資料和確認時不一樣，沒有刪除任何東西，請重新整理後再試');
  }
  await db.transaction(() => {
    db.removeWhere('stock_transactions', txn);
    db.removeWhere('stock_holdings', inMarket);
  });
  return counts;
});
route('POST', '/api/stocks/refresh', () => { invalidateCache(); return { status: 'cache_cleared' }; });
