// 代管帳戶 (accounts managed for someone else).
// Their trades live in stock_transactions with account_id set; holdings are
// derived from those trades and never touch stock_holdings.

import * as db from './db.js';
import { route } from './router.js';
import { fetchQuotes } from './market.js';
import { HttpError, badRequest, body, cmp, refreshAndPersistRate, round2, round4, storedUSDTWDRate, toTWD, realizedTWD } from './util.js';
import { lotFromBuy, takeLots, lotsTotal } from './lots.js';

// USD/TWD rate: stored rate, 32 when missing or 0.
function parseID(s) {
  if (!/^-?\d+$/.test(String(s))) throw badRequest('invalid id');
  return Number(s);
}

const accountJSON = (a) => ({ id: a.id, name: a.name, cash_twd: a.cash_twd, cash_usd: a.cash_usd, note: a.note, created_at: a.created_at });

function getAccount(id) {
  const a = db.get('managed_accounts', id);
  if (!a) throw new HttpError(404, 'account not found');
  return a;
}

function adjustCash(accountID, currency, delta) {
  const col = currency === 'TWD' ? 'cash_twd' : 'cash_usd';
  const a = db.get('managed_accounts', accountID);
  if (a) db.update('managed_accounts', accountID, { [col]: a[col] + delta });
}

// ---------------------------------------------------------------- accounts

function listAccounts() {
  return db.all('managed_accounts').sort((a, b) => a.id - b.id).map(accountJSON);
}

function createAccount(req) {
  const a = body(req);
  if (!a.name) throw badRequest('name is required');
  const row = db.insert('managed_accounts', { name: a.name, cash_twd: a.cash_twd, cash_usd: a.cash_usd, note: a.note });
  // Echo the decoded request plus the new id (created_at stays empty)
  return { id: row.id, name: a.name, cash_twd: Number(a.cash_twd) || 0, cash_usd: Number(a.cash_usd) || 0, note: a.note || '', created_at: a.created_at || '' };
}

function updateAccount(req) {
  const a = body(req);
  if (!a.name) throw badRequest('name is required');
  db.update('managed_accounts', req.params.id, { name: a.name, cash_twd: a.cash_twd, cash_usd: a.cash_usd, note: a.note });
  return { status: 'updated' };
}

async function deleteAccount(req) {
  const id = parseID(req.params.id);
  const force = req.query.get('force') === '1';
  const count = db.where('stock_transactions', (t) => t.account_id === id).length;
  if (count > 0 && !force) {
    throw new HttpError(409, `account has ${count} transactions; pass ?force=1 to delete with transactions`);
  }
  await db.transaction(async () => {
    if (force && count > 0) db.removeWhere('stock_transactions', (t) => t.account_id === id);
    db.removeWhere('managed_cash_movements', (m) => m.account_id === id);
    db.removeWhere('managed_snapshots', (s) => s.account_id === id);
    db.remove('managed_accounts', id);
  });
  return { status: 'deleted' };
}

// ---------------------------------------------------------------- holdings

/**
 * Replay an account's trades per symbol, oldest first, with the main ledger's FIFO rule (lots.js:
 * a lot's cost includes its buy fee). Writes each SELL's realized_pl when it changed, so a
 * backdated or deleted trade fixes the later sells too. Returns { symbol: { lots, market, currency } }.
 */
export function replayAccount(accountID) {
  const txns = db.where('stock_transactions', (t) => t.account_id === accountID)
    .sort((a, b) => cmp(a.date, b.date) || a.id - b.id);
  const bySymbol = new Map();
  for (const t of txns) {
    let st = bySymbol.get(t.symbol);
    if (!st) { st = { lots: [] }; bySymbol.set(t.symbol, st); }
    st.market = t.market; // the most recent record's
    st.currency = t.currency;
    if (t.action === 'BUY') {
      if (t.shares > 0) st.lots.push(lotFromBuy({ ...t, fee: t.fee || 0 }));
      continue;
    }
    const { cost, left } = takeLots(st.lots, t.shares);
    if (left >= t.shares - 1e-9) continue; // no lot covers it: keep the stored realized_pl
    const pl = round4((t.shares - left) * t.price - cost - (t.fee || 0) - (t.tax || 0));
    if (Math.abs(pl - (t.realized_pl || 0)) > 1e-6) db.update('stock_transactions', t.id, { realized_pl: pl });
  }
  return bySymbol;
}

/** Current holdings of a managed account at live prices. */
export async function computeHoldings(accountID) {
  const pendings = [];
  for (const [sym, st] of replayAccount(accountID)) {
    const { shares, cost } = lotsTotal(st.lots);
    if (shares > 1e-9) pendings.push({ sym, market: st.market, currency: st.currency, shares, costBasis: cost });
  }

  const quotes = await fetchQuotes(pendings.map((p) => p.sym));
  const rate = storedUSDTWDRate();

  return pendings.map((p) => {
    const avgCost = p.shares > 0 ? p.costBasis / p.shares : 0;
    const price = quotes[p.sym]?.price || 0;
    const mv = p.shares * price;
    const upl = mv - p.costBasis;
    const plPct = p.costBasis > 0 ? upl / p.costBasis * 100 : 0;
    const twd = (v) => toTWD(v, p.currency, rate);
    return {
      symbol: p.sym,
      market: p.market,
      currency: p.currency,
      shares: p.shares,
      avg_cost: avgCost,
      current_price: price,
      market_value: mv,
      market_value_twd: twd(mv),
      cost_twd: twd(p.costBasis),
      unrealized_pl: upl,
      unrealized_pl_twd: twd(upl),
      pl_percent: plPct,
    };
  });
}

const accountRealizedTWD = (accountID, rate) =>
  round2(realizedTWD(db.where('stock_transactions', (x) => x.action === 'SELL' && x.account_id === accountID), rate));

function txnJSON(t) {
  return {
    id: t.id, symbol: t.symbol, market: t.market, action: t.action, shares: t.shares, price: t.price,
    fee: t.fee, tax: 0, currency: t.currency, date: t.date, realized_pl: t.realized_pl, note: t.note,
    created_at: t.created_at, ...(t.account_id != null ? { account_id: t.account_id } : {}),
  };
}

function fetchTransactions(accountID) {
  return db.where('stock_transactions', (t) => t.account_id === accountID)
    .sort((a, b) => cmp(b.date, a.date) || b.id - a.id)
    .map(txnJSON);
}

function fetchCashMovements(accountID) {
  return db.where('managed_cash_movements', (m) => m.account_id === accountID)
    .sort((a, b) => cmp(b.date, a.date) || b.id - a.id);
}

async function getSummary(req) {
  const id = parseID(req.params.id);
  const acc = getAccount(id);
  const holdings = await computeHoldings(id);
  const rate = storedUSDTWDRate();

  const s = {
    account: accountJSON(acc),
    holdings,
    transactions: [],
    cash_movements: [],
    cash_total_twd: 0,
    stock_tw_value_twd: 0,
    stock_us_value_twd: 0,
    stock_value_twd: 0,
    total_value_twd: 0,
    cost_twd: 0,
    unrealized_pl_twd: 0,
    realized_pl_twd: 0,
    usd_twd_rate: rate,
  };
  for (const h of holdings) {
    s.stock_value_twd += h.market_value_twd;
    s.unrealized_pl_twd += h.unrealized_pl_twd;
    s.cost_twd += h.cost_twd;
    if (h.market === 'TW') s.stock_tw_value_twd += h.market_value_twd;
    else s.stock_us_value_twd += h.market_value_twd;
  }
  s.cash_total_twd = acc.cash_twd + acc.cash_usd * rate;
  s.total_value_twd = s.cash_total_twd + s.stock_value_twd;
  s.realized_pl_twd = accountRealizedTWD(id, rate);
  s.transactions = fetchTransactions(id);
  s.cash_movements = fetchCashMovements(id);
  return s;
}

// ---------------------------------------------------------------- cash movements

async function recordCashMovement(req) {
  const id = parseID(req.params.id);
  const m = body(req);
  if (m.type !== 'deposit' && m.type !== 'withdraw') throw badRequest('type must be deposit or withdraw');
  if (m.currency !== 'TWD' && m.currency !== 'USD') throw badRequest('currency must be TWD or USD');
  const amount = Number(m.amount) || 0;
  if (amount <= 0) throw badRequest('amount must be positive');
  const date = m.date || db.today();
  getAccount(id);

  return db.transaction(async () => {
    adjustCash(id, m.currency, m.type === 'withdraw' ? -amount : amount);
    const row = db.insert('managed_cash_movements', { account_id: id, type: m.type, currency: m.currency, amount, date, note: m.note });
    return { id: row.id, account_id: id, type: m.type, currency: m.currency, amount, date, note: m.note || '', created_at: m.created_at || '' };
  });
}

async function deleteCashMovement(req) {
  const id = parseID(req.params.id);
  const m = db.get('managed_cash_movements', id);
  if (!m) throw new HttpError(404, 'movement not found');
  await db.transaction(async () => {
    // Reverse: deposit added → subtract; withdraw subtracted → add
    adjustCash(m.account_id, m.currency, m.type === 'withdraw' ? m.amount : -m.amount);
    db.remove('managed_cash_movements', id);
  });
  return { status: 'deleted' };
}

// ---------------------------------------------------------------- snapshots

async function takeSnapshot(req) {
  const id = parseID(req.params.id);
  const acc = getAccount(id);

  // Freeze the live rate so computeHoldings reads the same value
  const rate = await refreshAndPersistRate();
  const holdings = await computeHoldings(id);

  const snap = {
    account_id: id, date: '', cash_twd: acc.cash_twd, cash_usd: acc.cash_usd, cash_total_twd: 0,
    stock_tw_value_twd: 0, stock_us_value_twd: 0, stock_value_twd: 0, cost_twd: 0,
    unrealized_pl_twd: 0, realized_pl_twd: 0, total_value_twd: 0, usd_twd_rate: rate,
    detail_json: '[]', note: '',
  };
  const details = holdings.map((h) => {
    snap.stock_value_twd += h.market_value_twd;
    snap.cost_twd += h.cost_twd;
    snap.unrealized_pl_twd += h.unrealized_pl_twd;
    if (h.market === 'TW') snap.stock_tw_value_twd += h.market_value_twd;
    else snap.stock_us_value_twd += h.market_value_twd;
    return {
      symbol: h.symbol, market: h.market, currency: h.currency, shares: h.shares, avg_cost: h.avg_cost,
      current_price: h.current_price, market_value: h.market_value, value_twd: h.market_value_twd,
      cost_twd: h.cost_twd, pl_twd: h.unrealized_pl_twd,
    };
  });
  snap.cash_total_twd = acc.cash_twd + acc.cash_usd * rate;
  snap.total_value_twd = snap.cash_total_twd + snap.stock_value_twd;
  snap.realized_pl_twd = accountRealizedTWD(id, rate);
  snap.detail_json = JSON.stringify(details);
  snap.date = req.query.get('date') || db.today();
  snap.note = req.query.get('note') || '';

  const row = db.insert('managed_snapshots', snap);
  return { id: row.id, ...snap, created_at: '' };
}

function listSnapshots(req) {
  const id = parseID(req.params.id);
  return db.where('managed_snapshots', (s) => s.account_id === id)
    .sort((a, b) => cmp(b.date, a.date) || b.id - a.id);
}

function deleteSnapshot(req) {
  db.remove('managed_snapshots', req.params.id);
  return { status: 'deleted' };
}

// ---------------------------------------------------------------- transactions

/**
 * Record a BUY/SELL for the managed account. Adjusts the account's cash
 * (BUY deducts shares*price+fee, SELL adds shares*price-fee); realized P&L
 * comes from replayAccount (same FIFO rule as the main ledger).
 */
async function recordTransaction(req) {
  const id = parseID(req.params.id);
  getAccount(id);
  const txn = body(req);
  if (txn.action !== 'BUY' && txn.action !== 'SELL') throw badRequest('action must be BUY or SELL');
  if (!txn.symbol) throw badRequest('symbol is required');
  if (!txn.date) txn.date = db.today();
  if (!txn.currency) txn.currency = txn.market === 'TW' ? 'TWD' : 'USD';
  const shares = Number(txn.shares) || 0;
  const price = Number(txn.price) || 0;
  const fee = Number(txn.fee) || 0;

  return db.transaction(async () => {
    const row = db.insert('stock_transactions', {
      symbol: txn.symbol, market: txn.market, action: txn.action, shares, price, fee,
      currency: txn.currency, date: txn.date, realized_pl: 0, note: txn.note, account_id: id,
    });
    const gross = shares * price;
    adjustCash(id, txn.currency, txn.action === 'BUY' ? -(gross + fee) : gross - fee);
    replayAccount(id); // the SELL's realized_pl (and any later one a backdated trade moves)
    return {
      id: row.id, symbol: txn.symbol, market: txn.market || '', action: txn.action, shares, price, fee,
      tax: Number(txn.tax) || 0, currency: txn.currency, date: txn.date, realized_pl: db.get('stock_transactions', row.id).realized_pl,
      note: txn.note || '', created_at: txn.created_at || '', account_id: id,
    };
  });
}

async function deleteTransaction(req) {
  const id = parseID(req.params.id);
  const t = db.get('stock_transactions', id);
  if (!t) throw new HttpError(404, 'transaction not found');
  if (t.account_id == null) throw badRequest('transaction is not a managed transaction');
  await db.transaction(async () => {
    const gross = t.shares * t.price;
    // BUY: refund what was deducted; SELL: remove what was added
    adjustCash(t.account_id, t.currency, t.action === 'BUY' ? gross + t.fee : -(gross - t.fee));
    db.remove('stock_transactions', id);
    replayAccount(t.account_id); // later sells of that symbol may have used this lot
  });
  return { status: 'deleted' };
}

route('GET', '/api/managed/accounts', listAccounts);
route('POST', '/api/managed/accounts', createAccount);
route('PUT', '/api/managed/accounts/{id}', updateAccount);
route('DELETE', '/api/managed/accounts/{id}', deleteAccount);
route('GET', '/api/managed/accounts/{id}/summary', getSummary);
route('POST', '/api/managed/accounts/{id}/transactions', recordTransaction);
route('DELETE', '/api/managed/transactions/{id}', deleteTransaction);
route('POST', '/api/managed/accounts/{id}/snapshot', takeSnapshot);
route('GET', '/api/managed/accounts/{id}/snapshots', listSnapshots);
route('DELETE', '/api/managed/snapshots/{id}', deleteSnapshot);
route('POST', '/api/managed/accounts/{id}/cash', recordCashMovement);
route('DELETE', '/api/managed/cash/{id}', deleteCashMovement);
