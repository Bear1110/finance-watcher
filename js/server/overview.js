// 總覽: how net worth grew, split into what can be measured.

import * as db from './db.js';
import { route } from './router.js';
import { storedUSDTWDRate, toTWD, daysBetween } from './util.js';
import { listSnapshots, afterSnapshot, tradeCash, carriedCash, netWorthOf } from './assets.js';
import { listHoldings } from './stocks.js';
import { countedOtherAssets, countedRows, includeOtherAssets } from './other_assets.js';
import { expenseTWD } from './expenses.js';
import { portfolioStats, ttmDividendsTWD } from './portfolio.js';

/**
 * Net worth change from base to end, split into 股價 (stock value change − net buys: cash turned
 * into stock isn't a gain), 股利 (dividends received), 其他資產 (the change in their filled-in value,
 * when counted) and 存入與其他 (the rest: money saved or given, FX on cash, anything unrecorded). It is
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
/** The month i months before today's: [y, m (1-based), 'YYYY-MM']. */
function monthBack(today, i) {
  const [y, m] = today.split('-').map(Number);
  const d = new Date(y, m - 1 - i, 1);
  const [my, mm] = [d.getFullYear(), d.getMonth() + 1];
  return [my, mm, `${my}-${pad(mm)}`];
}

/**
 * The whole calendar month, including entries recorded ahead of time (planned), plus the top
 * expense categories. The comparison with last month uses only the days so far against the same
 * days of last month, so early in the month it isn't "spending is way down".
 * expenses: rows with { type, category, date, amount_twd }.
 */
export function monthSummary(expenses, today) {
  const [y, m, d] = today.split('-').map(Number);
  const [py, pm] = m === 1 ? [y - 1, 12] : [y, m - 1];
  const from = ymd(y, m, 1);
  const to = ymd(y, m, daysInMonth(y, m));
  const prevFrom = ymd(py, pm, 1);
  const prevTo = ymd(py, pm, Math.min(d, daysInMonth(py, pm)));
  const sum = (lo, hi, type, list = expenses) => list
    .filter((e) => e.type === type && e.date >= lo && e.date <= hi)
    .reduce((s, e) => s + e.amount_twd, 0);
  const month = expenses.filter((e) => e.date >= from && e.date <= to);
  const byCat = new Map();
  for (const e of month) {
    if (e.type === 'expense') byCat.set(e.category, (byCat.get(e.category) || 0) + e.amount_twd);
  }
  // the latest one up to today: a planned record dated next year doesn't mean 收支 is still kept
  const lastRecord = expenses.reduce((mx, e) => (e.date <= today && e.date > mx ? e.date : mx), '');
  return {
    from, to, today, prev_from: prevFrom, prev_to: prevTo,
    expense: sum(from, to, 'expense', month),
    income: sum(from, to, 'income', month),
    expense_to_date: sum(from, today, 'expense', month),
    prev_expense: sum(prevFrom, prevTo, 'expense'),
    top: [...byCat].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([category, amount]) => ({ category, amount })),
    count: month.length,
    last_record: lastRecord,
    // 收支 is in use: something this month or last. Otherwise 總覽 leaves the card out (early in the
    // month it stays, so the card doesn't vanish on the 1st for someone who records every month)
    in_use: lastRecord >= prevFrom || month.length > 0,
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
 * The 資產快照 strip on 總覽 (a snapshot a month is the habit): each month from the first snapshot's
 * month to this one (the last), at most `max`, with that month's latest snapshot { id, date } or null,
 * and `date` to record a missing one on: today for this month, else the month's last day.
 * No snapshots: no months.
 */
export function snapshotMonths(snaps, today, max = 12) {
  const byMonth = new Map();
  for (const s of snaps) {
    const ym = s.date.slice(0, 7);
    if (!(byMonth.get(ym)?.date >= s.date)) byMonth.set(ym, { id: s.id, date: s.date });
  }
  const first = [...byMonth.keys()].sort()[0];
  const months = [];
  for (let i = 0; first && i < max; i++) {
    const [my, mm, ym] = monthBack(today, i);
    if (ym < first) break;
    months.unshift({ ym, date: i === 0 ? today : ymd(my, mm, daysInMonth(my, mm)), snapshot: byMonth.get(ym) || null });
  }
  return months;
}

/**
 * Months in a row with a snapshot, counting back from this month (or last month while this one
 * isn't recorded yet, so the streak isn't broken before the month is over).
 */
export function snapshotStreak(snaps, today) {
  const have = new Set(snaps.map((s) => s.date.slice(0, 7)));
  const ym = (i) => monthBack(today, i)[2];
  let i = have.has(ym(0)) ? 0 : 1;
  const start = i;
  while (have.has(ym(i))) i++;
  return i - start;
}

/**
 * Things worth acting on, most important first. Each: { level: 'warn'|'info', text, action }.
 * Snapshots have their own strip on 總覽 (snapshotMonths), so none here.
 */
export function buildAlerts({ today, topHolding, spending, month, otherAssets }) {
  const out = [];
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

/**
 * Everything 總覽 shows, for the current data (live quotes), plus the holdings and 組合分析 it was
 * built from (the AI prompt reuses them): { overview, stocks, portfolio }.
 */
export async function buildOverview() {
  const rate = storedUSDTWDRate();
  const today = db.today();
  const includeOther = includeOtherAssets();
  const snaps = listSnapshots().map((s) => ({ ...s, total: s.net_worth, other: includeOther ? s.other_assets : 0 }));
  const cash = carriedCash(snaps[0]);
  const stocks = await listHoldings();
  const other = countedOtherAssets();
  const netWorth = cash ? netWorthOf({ cashTWD: cash.twd, cashUSD: cash.usd, rate, stocks: stocks.total_value_twd, other }) : null;
  const ttmTWD = ttmDividendsTWD(rate);
  const pf = portfolioStats({ holdings: stocks.holdings, ttmTWD, cash, rate, other });

  const expenses = db.all('expenses').map((e) => ({ ...e, amount_twd: expenseTWD(e) }));
  const month = monthSummary(expenses, today);
  const spending = spendingStats({
    cashTWD: cash ? cash.twd + cash.usd * rate : null,
    setting: Number(db.getSetting('monthly_expense')) || 0,
    recorded: avgMonthlyExpense(expenses, today, 12),
  });
  const dayPL = (mkt) => stocks.holdings.filter((h) => !mkt || h.market === mkt).reduce((s, h) => s + h.day_change_twd, 0);
  const pl = dayPL();

  const overview = {
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
    snapshot_months: snapshotMonths(snaps, today),
    snapshot_streak: snapshotStreak(snaps, today),
    alerts: buildAlerts({ today, topHolding: pf && pf.rows[0], spending, month, otherAssets: includeOther ? countedRows() : [] }),
  };
  return { overview, stocks, portfolio: pf };
}

route('GET', '/api/overview', async () => (await buildOverview()).overview);
