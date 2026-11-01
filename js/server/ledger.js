// The single source of truth for self-account
// positions. replaySymbol rebuilds FIFO lots from stock_transactions and
// rewrites each SELL's realized_pl plus the stock_holdings row. Record/Update/
// Delete all go through it, so backdated or edited trades can never leave
// holdings stale.

import * as db from './db.js';
import { isCounted, normalizeSymbolMarket, settingFloat, round4, badRequest, cmp } from './util.js';

const actionOrder = (a) => (a === 'BUY' ? 0 : 1);

/** ORDER BY date ASC, BUY before SELL, id ASC */
export const ledgerOrder = (a, b) => cmp(a.date, b.date) || actionOrder(a.action) - actionOrder(b.action) || a.id - b.id;

/**
 * Replay one symbol. Must run inside db.transaction. Only counted txns take part.
 *
 * Cost basis per lot includes the BUY fee. A SELL's realized_pl is
 * sum((price - lotCost) * consumed) - fee - tax.
 *
 * pl_manual SELLs (that are counted, i.e. lots_consumed=1) consume lots so
 * holdings stay right but keep their stored realized_pl. A SELL that no lot
 * covers at all keeps its stored realized_pl. If the symbol has no BUY at all,
 * stock_holdings is not touched.
 *
 * Returns { shares, avgCost, hasBuys, uncovered: Map(sellId -> shares) }.
 */
export function replaySymbol(symbol) {
  const txns = db.where('stock_transactions', (t) => t.symbol === symbol && isCounted(t)).sort(ledgerOrder);
  const lots = [];
  const updates = [];
  const res = { shares: 0, avgCost: 0, hasBuys: false, uncovered: new Map() };
  let market = '';
  let currency = '';

  for (const t of txns) {
    if (t.action === 'BUY') {
      res.hasBuys = true;
      market = t.market;
      currency = t.currency;
      if (t.shares > 0) lots.push({ shares: t.shares, cost: (t.price * t.shares + t.fee) / t.shares });
      continue;
    }

    let remaining = t.shares;
    let pl = 0;
    for (const l of lots) {
      if (remaining <= 0) break;
      if (l.shares <= 0) continue;
      const take = Math.min(l.shares, remaining);
      pl += (t.price - l.cost) * take;
      l.shares -= take;
      remaining -= take;
    }
    if (t.pl_manual === 1) continue; // consumed what it could; realized_pl is fixed
    if (remaining > 1e-9) res.uncovered.set(t.id, remaining);
    if (remaining >= t.shares - 1e-9) continue; // nothing consumed: legacy import, keep stored realized_pl
    const newPL = round4(pl - t.fee - t.tax);
    if (Math.abs(newPL - t.realized_pl) > 1e-6) updates.push({ id: t.id, pl: newPL });
  }

  for (const u of updates) db.update('stock_transactions', u.id, { realized_pl: u.pl });

  if (!res.hasBuys) return res;

  let totalShares = 0;
  let totalCost = 0;
  for (const l of lots) {
    totalShares += l.shares;
    totalCost += l.shares * l.cost;
  }
  if (totalShares < 1e-9) totalShares = 0;
  res.shares = totalShares;
  if (totalShares > 0) res.avgCost = totalCost / totalShares;

  const existing = db.findBy('stock_holdings', 'symbol', symbol);
  if (existing) {
    db.update('stock_holdings', existing.id, {
      shares: res.shares,
      avg_cost: res.shares > 0 ? res.avgCost : existing.avg_cost,
      market,
      currency,
    });
  } else {
    db.insert('stock_holdings', { symbol, market, shares: res.shares, avg_cost: res.avgCost, currency, note: '' });
  }
  return res;
}

/** Validate and fill defaults (mutates txn). Throws 400 with a user-facing message. */
export function normalizeTxn(txn) {
  normalizeSymbolMarket(txn);
  if (txn.action !== 'BUY' && txn.action !== 'SELL') throw badRequest('action must be BUY or SELL');
  txn.shares = Number(txn.shares) || 0;
  txn.price = Number(txn.price) || 0;
  txn.fee = Number(txn.fee) || 0;
  txn.tax = Number(txn.tax) || 0;
  txn.realized_pl = Number(txn.realized_pl) || 0;
  txn.note = txn.note == null ? '' : String(txn.note);
  if (!(txn.shares > 0)) throw badRequest('股數必須大於 0');
  if (!(txn.price > 0)) throw badRequest('價格必須大於 0');
  if (txn.fee < 0 || txn.tax < 0) throw badRequest('手續費與稅金不可為負');
  return txn;
}

/**
 * Estimate Taiwan brokerage fee (0.1425% x discount) and, on SELL, securities
 * transaction tax (0.3%, ETFs whose code starts with 00: 0.1%). Only when
 * requested, market is TW and neither fee nor tax was entered.
 */
export function applyAutoFee(txn) {
  if (!txn.auto_fee || txn.market !== 'TW' || txn.fee !== 0 || txn.tax !== 0) return;
  const discount = settingFloat('tw_fee_discount', 1.0, (v) => v > 0 && v <= 1);
  const amount = txn.shares * txn.price;
  const minFee = txn.shares >= 1000 ? 20 : 1;
  txn.fee = Math.max(minFee, Math.floor(amount * 0.001425 * discount));
  if (txn.action === 'SELL') {
    const rate = txn.symbol.startsWith('00') ? 0.001 : 0.003;
    txn.tax = Math.floor(amount * rate);
  }
}

/** %.4g-style formatting for share counts. */
export function fmtShares(v) {
  return String(Number(v.toPrecision(4)));
}

/**
 * SELLs left without BUY records after a change. Only symbols with BUYs warn:
 * a symbol made purely of imported SELLs is expected.
 */
export function uncoveredWarnings(res, symbol) {
  const w = [];
  if (!res || !res.hasBuys) return w;
  for (const [id, sh] of res.uncovered) w.push(`${symbol} 的賣出 #${id} 有 ${fmtShares(sh)} 股沒有對應的買入紀錄`);
  return w;
}
