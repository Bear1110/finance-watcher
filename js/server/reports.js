// Weekly report: GET /api/reports/weekly

import * as db from './db.js';
import { route } from './router.js';
import { badRequest, cmp, isDate, storedUSDTWDRate } from './util.js';
import { holdingDetail } from './stocks.js';
import { expenseJSON } from './expenses.js';

const iso = (d) => d.toISOString().slice(0, 10);

export function txnJSON(t) {
  const out = {
    id: t.id, symbol: t.symbol, market: t.market, action: t.action, shares: t.shares,
    price: t.price, fee: t.fee, tax: t.tax, currency: t.currency, date: t.date,
    realized_pl: t.realized_pl, note: t.note, created_at: t.created_at,
  };
  if (t.account_id != null) out.account_id = t.account_id;
  return out;
}

// Simplified: holdings without live prices.
function buildPortfolioSummary() {
  const rate = storedUSDTWDRate();
  const summary = { holdings: [], total_cost_twd: 0, total_value_twd: 0, total_pl_twd: 0, total_pl_percent: 0, realized_pl_twd: 0 };
  for (const h of db.where('stock_holdings', (x) => x.shares > 0)) {
    summary.total_cost_twd += h.avg_cost * h.shares * (h.currency === 'USD' ? rate : 1);
    summary.holdings.push(holdingDetail(h));
  }
  return summary;
}

route('GET', '/api/reports/weekly', ({ query }) => {
  const dateStr = query.get('date') || db.today();
  if (!isDate(dateStr)) throw badRequest('invalid date format, use YYYY-MM-DD');
  const t = new Date(dateStr + 'T00:00:00Z');
  const weekday = t.getUTCDay() || 7; // Sunday → 7
  const monday = new Date(t.getTime() - (weekday - 1) * 86400000);
  const sunday = new Date(monday.getTime() + 6 * 86400000);
  const weekStart = iso(monday);
  const weekEnd = iso(sunday);

  const transactions = db.where('stock_transactions',
    (x) => x.date >= weekStart && x.date <= weekEnd && x.account_id == null)
    .sort((a, b) => cmp(b.date, a.date) || a.id - b.id)
    .map(txnJSON);

  const expenses = db.where('expenses', (x) => x.date >= weekStart && x.date <= weekEnd)
    .sort((a, b) => cmp(b.date, a.date) || a.id - b.id)
    .map(expenseJSON);
  const totalExpense = expenses.reduce((s, e) => s + e.amount_twd, 0);

  return {
    week_start: weekStart,
    week_end: weekEnd,
    portfolio: buildPortfolioSummary(),
    transactions,
    expenses,
    total_expense: totalExpense,
  };
});
