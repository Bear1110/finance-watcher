// 總覽: how net worth grew, split into what can be measured.

import * as db from './db.js';
import { route } from './router.js';
import { storedUSDTWDRate, toTWD, daysBetween } from './util.js';
import { listSnapshots, afterSnapshot, tradeCash, carriedCash, netWorthOf } from './assets.js';
import { listHoldings } from './stocks.js';
import { otherAssetsTotal, includeOtherAssets } from './other_assets.js';
import { expenseTWD } from './expenses.js';
import { portfolioStats, ttmDividendsTWD } from './portfolio.js';

/**
 * Net worth change from base to end, split into 股價 (stock value change − net buys: cash turned
 * into stock isn't a gain), 股利 (dividends received), 其他資產 (the change in their filled-in value,
 * when counted) and 儲蓄 (the rest: money saved, plus FX on cash and anything unrecorded). 儲蓄 is
 * the remainder on purpose: trades and dividends are recorded reliably, 收支 often isn't.
 * base / end: { date, created_at?, stock_value_twd, total, other? } with total = net worth.
 */
export function growthBetween(base, end, { trades, dividends, rate }) {
  // After base, up to end; a same-day record entered after a snapshot belongs to the next period
  const inRange = (r) => afterSnapshot(r, base) && !afterSnapshot(r, end);
  // Imported positions count as buys here: their value appearing isn't a price gain.
  const netBuys = -trades.filter(inRange).reduce((s, t) => s + toTWD(tradeCash(t), t.currency, rate), 0);
  const price = end.stock_value_twd - base.stock_value_twd - netBuys;
  const div = dividends.filter(inRange).reduce((s, d) => s + toTWD(d.amount || 0, d.currency, rate), 0);
  const other = (end.other || 0) - (base.other || 0);
  const change = end.total - base.total;
  return { from: base.date, to: end.date, start: base.total, change, price, dividends: div, other, savings: change - price - div - other };
}

/**
 * growthBetween per calendar year, newest first. A year starts from the last snapshot on or
 * before Jan 1 (else its first snapshot: partial) and ends at its last snapshot; the current
 * year ends at `live` (today's net worth). snaps: newest first, each with `total`.
 */
export function yearlyGrowth(snaps, live, opts) {
  const asc = [...snaps].reverse();
  if (!asc.length) return [];
  const thisYear = Number(live.date.slice(0, 4));
  const out = [];
  for (let y = Number(asc[0].date.slice(0, 4)); y <= thisYear; y++) {
    let base = asc.findLast((s) => s.date <= `${y}-01-01`);
    const partial = !base;
    base ||= asc.find((s) => s.date.startsWith(`${y}-`));
    const end = y === thisYear ? live : asc.findLast((s) => s.date <= `${y}-12-31`);
    if (!base || !end || end === base) continue;
    out.push({ year: y, partial, current: y === thisYear, ...growthBetween(base, end, opts) });
  }
  return out.reverse();
}

const pad = (n) => String(n).padStart(2, '0');
const ymd = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
const daysInMonth = (y, m) => new Date(y, m, 0).getDate(); // m is 1-based

/**
 * This month so far vs the same days of last month, plus the top expense categories.
 * expenses: rows with { type, category, date, amount_twd }.
 */
export function monthSummary(expenses, today) {
  const [y, m, d] = today.split('-').map(Number);
  const [py, pm] = m === 1 ? [y - 1, 12] : [y, m - 1];
  const from = ymd(y, m, 1);
  const prevFrom = ymd(py, pm, 1);
  const prevTo = ymd(py, pm, Math.min(d, daysInMonth(py, pm)));
  const sum = (lo, hi, type) => expenses
    .filter((e) => e.type === type && e.date >= lo && e.date <= hi)
    .reduce((s, e) => s + e.amount_twd, 0);
  const byCat = new Map();
  for (const e of expenses) {
    if (e.type === 'expense' && e.date >= from && e.date <= today) byCat.set(e.category, (byCat.get(e.category) || 0) + e.amount_twd);
  }
  return {
    from, to: today, prev_from: prevFrom, prev_to: prevTo,
    expense: sum(from, today, 'expense'),
    income: sum(from, today, 'income'),
    prev_expense: sum(prevFrom, prevTo, 'expense'),
    top: [...byCat].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([category, amount]) => ({ category, amount })),
    count: expenses.filter((e) => e.date >= from && e.date <= today).length,
    last_record: expenses.reduce((mx, e) => (e.date > mx ? e.date : mx), ''),
  };
}

/**
 * Average monthly spending over the last `months` full months, counting only months since
 * records began (someone who started last month isn't averaged over a year). null without records.
 */
export function avgMonthlyExpense(expenses, today, months) {
  const [y, m] = today.split('-').map(Number);
  const monthIndex = (date) => Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7)) - 1;
  const cur = y * 12 + m - 1;
  const first = expenses.reduce((mn, e) => Math.min(mn, monthIndex(e.date)), Infinity);
  const start = Math.max(cur - months, first);
  if (!(start < cur)) return null;
  const total = expenses
    .filter((e) => e.type === 'expense' && monthIndex(e.date) >= start && monthIndex(e.date) < cur)
    .reduce((s, e) => s + e.amount_twd, 0);
  return total > 0 ? total / (cur - start) : null;
}

/**
 * Monthly living cost (the setting, else the recorded 12-month average) and how many months cash lasts.
 */
export function spendingStats({ cashTWD, setting, recorded }) {
  const monthly = setting > 0 ? setting : recorded;
  return {
    monthly_expense: monthly || null,
    source: setting > 0 ? 'setting' : recorded ? 'records' : null,
    recorded_monthly_expense: recorded,
    cash_months: monthly && cashTWD != null ? cashTWD / monthly : null,
  };
}

/**
 * Things worth acting on, most important first. Each: { level: 'warn'|'info', text, action }.
 * A stale snapshot is the data check's job (/api/data-check); the dashboard shows its warnings too.
 */
export function buildAlerts({ today, latestSnapshot, topHolding, spending, month, otherAssets }) {
  const out = [];
  if (!latestSnapshot) {
    out.push({ level: 'info', text: '還沒有資產快照：記一筆現金餘額，才算得出淨資產', action: 'snapshot' });
  }
  if (topHolding && topHolding.level === 'danger') {
    out.push({ level: 'warn', text: `${topHolding.symbol} 佔股票 ${topHolding.weight.toFixed(0)}%，高度集中`, action: 'portfolio' });
  }
  if (spending.cash_months != null && spending.cash_months < 3) {
    out.push({ level: 'warn', text: `現金只夠撐 ${Math.max(0, spending.cash_months).toFixed(1)} 個月生活費（一般建議 3～6 個月）`, action: 'settings' });
  }
  if (month.last_record) {
    const days = daysBetween(month.last_record, today);
    if (days > 14) out.push({ level: 'info', text: `收支已經 ${days} 天沒記`, action: 'expenses' });
  }
  for (const a of otherAssets) {
    const days = a.updated ? daysBetween(a.updated, today) : Infinity;
    if (days > 365) out.push({ level: 'info', text: `其他資產「${a.name}」的價值超過一年沒更新`, action: 'settings' });
  }
  return out;
}

route('GET', '/api/overview', async () => {
  const rate = storedUSDTWDRate();
  const today = db.today();
  const includeOther = includeOtherAssets();
  const snaps = listSnapshots().map((s) => ({ ...s, total: s.net_worth, other: includeOther ? s.other_assets : 0 }));
  const cash = carriedCash(snaps[0]);
  const stocks = await listHoldings();
  const other = includeOther ? otherAssetsTotal() : 0;
  const netWorth = cash ? netWorthOf({ cashTWD: cash.twd, cashUSD: cash.usd, rate, stocks: stocks.total_value_twd, other }) : null;
  const ttmTWD = ttmDividendsTWD(rate);
  const pf = portfolioStats({ holdings: stocks.holdings, ttmTWD, cash, rate, targetPct: null, other });

  const expenses = db.all('expenses').map((e) => ({ ...e, amount_twd: expenseTWD(e) }));
  const month = monthSummary(expenses, today);
  const spending = spendingStats({
    cashTWD: cash ? cash.twd + cash.usd * rate : null,
    setting: Number(db.getSetting('monthly_expense')) || 0,
    recorded: avgMonthlyExpense(expenses, today, 12),
  });
  const dayPL = (mkt) => stocks.holdings.filter((h) => !mkt || h.market === mkt).reduce((s, h) => s + h.day_change_twd, 0);
  const pl = dayPL();

  return {
    today,
    net_worth: netWorth,
    cash,
    parts: { cash_twd: cash ? cash.twd : 0, cash_usd: cash ? cash.usd * rate : 0, tw: pf ? pf.split.tw : 0, us: pf ? pf.split.us : 0, other },
    day: stocks.holdings.length ? { pl, tw: dayPL('TW'), us: dayPL('US'), prev_value: stocks.total_value_twd - pl } : null,
    years: cash ? yearlyGrowth(snaps, { date: today, stock_value_twd: stocks.total_value_twd, total: netWorth, other }, {
      trades: db.where('stock_transactions', (t) => t.account_id == null),
      dividends: db.all('dividends'),
      rate,
    }) : [],
    month,
    spending,
    alerts: buildAlerts({ today, latestSnapshot: snaps[0], topHolding: pf && pf.rows[0], spending, month, otherAssets: includeOther ? db.all('other_assets') : [] }),
  };
});
