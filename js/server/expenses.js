// Income/expense entries, their TWD values and the 收支 page statistics.

import * as db from './db.js';
import { route } from './router.js';
import { badRequest, body, cmp, isDate, storedUSDTWDRate, toTWD } from './util.js';
import { fetchFxRate } from './market.js';

/** Preset categories (add/edit dialog and AI import prompt); the first of each list is that type's default. */
export const EXPENSE_CATEGORIES = {
  expense: ['飲食', '飲料', '交通', '住房', '娛樂', '醫療', '日用品', '購物', '送禮', '其他支出'],
  income: ['薪資', '股利', '獎金', '其他收入'],
};

/**
 * Currencies a record can be in (the add/edit dialog lists them in this order; TWD first = default).
 * aliases: other ways people write it, for AI import.
 */
export const EXPENSE_CURRENCIES = [
  { code: 'TWD', flag: '🇹🇼', symbol: 'NT$', name: '台幣', decimals: 0, aliases: ['新台幣', 'ntd', '元'] },
  { code: 'JPY', flag: '🇯🇵', symbol: '¥', name: '日圓', decimals: 0, aliases: ['日幣', '日元', '円'] },
  { code: 'USD', flag: '🇺🇸', symbol: 'US$', name: '美金', decimals: 2, aliases: ['美元'] },
  { code: 'KRW', flag: '🇰🇷', symbol: '₩', name: '韓元', decimals: 0, aliases: ['韓幣', '韓圜'] },
  { code: 'EUR', flag: '🇪🇺', symbol: '€', name: '歐元', decimals: 2, aliases: [] },
  { code: 'HKD', flag: '🇭🇰', symbol: 'HK$', name: '港幣', decimals: 2, aliases: ['港元'] },
  { code: 'THB', flag: '🇹🇭', symbol: '฿', name: '泰銖', decimals: 2, aliases: ['泰幣'] },
  { code: 'CNY', flag: '🇨🇳', symbol: 'CN¥', name: '人民幣', decimals: 2, aliases: ['rmb'] },
];
const CURRENCY_CODES = new Set(EXPENSE_CURRENCIES.map((c) => c.code));

/**
 * A record in TWD: amount × the rate saved with it (1 for TWD). Records from before fx_rate
 * existed have none: TWD as is, USD at the current USD/TWD setting.
 */
export function expenseTWD(e) {
  if (e.fx_rate > 0) return e.amount * e.fx_rate;
  return e.currency === 'USD' ? toTWD(e.amount, 'USD', storedUSDTWDRate()) : e.amount;
}

/**
 * Totals of a list of 收支 the page shows (search results, one day): count, income / expense in TWD,
 * the date range, and the top 3 expense categories (only when there are 2+ categories). The page
 * filters; the adding up is here, like every other number.
 */
export function expenseListSummary(records) {
  let income = 0, expense = 0, first = '', last = '';
  const byCat = new Map();
  for (const e of records) {
    if (e.type === 'income') income += e.amount_twd;
    else {
      expense += e.amount_twd;
      byCat.set(e.category || '', (byCat.get(e.category || '') || 0) + e.amount_twd);
    }
    if (e.date && (!first || e.date < first)) first = e.date;
    if (e.date > last) last = e.date;
  }
  const top = byCat.size > 1 ? [...byCat].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([category, amount]) => ({ category, amount })) : [];
  return { count: records.length, income, expense, first, last, top };
}

export const expenseJSON = (e) => ({
  id: e.id, type: e.type, amount: e.amount, currency: e.currency, fx_rate: e.fx_rate, fx_pending: e.fx_pending,
  amount_twd: expenseTWD(e), category: e.category, note: e.note, date: e.date, created_at: e.created_at,
});

function list(req) {
  const q = req.query;
  const cat = q.get('category');
  const month = q.get('month');
  const from = q.get('from');
  const to = q.get('to');
  return db.where('expenses', (e) =>
    (!cat || e.category === cat) &&
    (!month || e.date.startsWith(month)) &&
    (!from || e.date >= from) &&
    (!to || e.date <= to))
    .sort((a, b) => cmp(b.date, a.date) || cmp(b.created_at, a.created_at))
    .map(expenseJSON);
}

/**
 * Validates input and fills defaults (type=expense, currency=TWD). fx_rate is 1 for TWD and 0
 * (= not known yet, see withFxRate) for a foreign record that didn't bring one. fx_pending = 1:
 * the rate is an offline estimate, replaced by the market rate once online (refreshPendingRates).
 */
export function normalizeExpense(e) {
  const currency = e.currency || 'TWD';
  const out = {
    type: e.type || 'expense',
    amount: Number(e.amount) || 0,
    currency,
    fx_rate: currency === 'TWD' ? 1 : Number(e.fx_rate) > 0 ? Number(e.fx_rate) : 0,
    fx_pending: currency !== 'TWD' && Number(e.fx_rate) > 0 && e.fx_pending ? 1 : 0,
    category: e.category || '',
    note: e.note || '',
    date: e.date || '',
  };
  if (out.type !== 'income' && out.type !== 'expense') throw badRequest('type must be income or expense');
  if (!(out.amount > 0)) throw badRequest('金額必須大於 0');
  if (!CURRENCY_CODES.has(out.currency)) throw badRequest(`不支援的幣別：${out.currency}`);
  if (!isDate(out.date)) throw badRequest('日期格式需為 YYYY-MM-DD');
  return out;
}

/** The newest market rate already saved for `currency` (USD: the settings rate if none): { rate, date } or null. */
function lastKnownRate(currency) {
  let best = null;
  for (const e of db.all('expenses')) {
    if (e.currency === currency && e.fx_rate > 0 && !e.fx_pending && (!best || e.date > best.date)) best = { rate: e.fx_rate, date: e.date };
  }
  return best || (currency === 'USD' ? { rate: storedUSDTWDRate(), date: '' } : null);
}

/**
 * Market rate of `currency` on `date`: { rate, date, estimated? }. Offline (no market data) it is
 * the last known rate, marked estimated; with no rate ever saved the user has to type one.
 */
export async function rateFor(currency, date) {
  try {
    return await fetchFxRate(currency, date);
  } catch (err) {
    const known = lastKnownRate(currency);
    if (!known) throw badRequest(`${err.message}（第一次記 ${currency} 需要連網，或手動填寫匯率）`);
    return { ...known, estimated: true };
  }
}

/** A foreign record without a rate gets its date's market rate, or an estimate to fix later when offline. */
export async function withFxRate(e) {
  if (e.fx_rate > 0) return e;
  const r = await rateFor(e.currency, e.date);
  return { ...e, fx_rate: r.rate, fx_pending: r.estimated ? 1 : 0 };
}

/** Estimated rates → market rates, once there is market data again (stops at the first failure: still offline). */
async function refreshPendingRates() {
  let updated = 0;
  for (const e of db.where('expenses', (x) => x.fx_pending)) {
    let r;
    try {
      r = await fetchFxRate(e.currency, e.date);
    } catch {
      break;
    }
    db.update('expenses', e.id, { fx_rate: r.rate, fx_pending: 0 });
    updated++;
  }
  return { updated };
}

async function create(req) {
  const e = await withFxRate(normalizeExpense(body(req)));
  const row = db.insert('expenses', e);
  return { id: row.id, ...e, created_at: '' };
}

async function updateExpense(req) {
  const e = await withFxRate(normalizeExpense(body(req)));
  db.update('expenses', req.params.id, e);
  return { status: 'updated' };
}

function remove(req) {
  db.remove('expenses', req.params.id);
  return { status: 'deleted' };
}

function yearParam(req) {
  const ys = req.query.get('year');
  return ys && /^-?\d+$/.test(ys) ? Number(ys) : new Date().getFullYear();
}

/**
 * Actual totals of one year in TWD (expenseTWD), index 0 = January:
 * { income, expense, byCategory: { income: {cat: amt}, expense: {cat: amt} } }.
 * Anything not 'income' counts as expense; an empty category stays '' (the UI labels it).
 */
function monthlyActuals(year) {
  const months = Array.from({ length: 12 }, () => ({ income: 0, expense: 0, byCategory: { income: {}, expense: {} } }));
  for (const e of db.where('expenses', (e) => e.date.startsWith(`${year}-`))) {
    const m = Number(e.date.slice(5, 7));
    if (!(m >= 1 && m <= 12)) continue;
    const type = e.type === 'income' ? 'income' : 'expense';
    const v = expenseTWD(e);
    const slot = months[m - 1];
    const cat = e.category;
    slot[type] += v;
    slot.byCategory[type][cat] = (slot.byCategory[type][cat] || 0) + v;
  }
  return months;
}

/** Year of the oldest record (null when there are none), so the year pickers reach it. */
function firstYear() {
  let first = '';
  for (const e of db.all('expenses')) if (e.date && (!first || e.date < first)) first = e.date;
  return first ? Number(first.slice(0, 4)) : null;
}

/** Per-month income/expense and category sums for the 收支 page charts. */
function getStats(req) {
  const year = yearParam(req);
  const months = monthlyActuals(year).map((a, i) => ({
    month: i + 1,
    income: a.income,
    expense: a.expense,
    by_category: a.byCategory,
  }));
  const dec = monthlyActuals(year - 1)[11];
  return { year, months, prev_december: { income: dec.income, expense: dec.expense }, first_year: firstYear() };
}

route('GET', '/api/expenses', list);
route('POST', '/api/expenses', create);
route('PUT', '/api/expenses/{id}', updateExpense);
route('DELETE', '/api/expenses/{id}', remove);
route('GET', '/api/expenses/stats', getStats);
// Market rate for the add/edit dialog: ?currency=JPY&date=YYYY-MM-DD -> { rate, date }
route('GET', '/api/expenses/fx', (req) => {
  const currency = req.query.get('currency');
  const date = req.query.get('date');
  if (!CURRENCY_CODES.has(currency) || currency === 'TWD') throw badRequest('不支援的幣別');
  if (!isDate(date)) throw badRequest('日期格式需為 YYYY-MM-DD');
  return rateFor(currency, date);
});
route('POST', '/api/expenses/refresh-fx', refreshPendingRates);
