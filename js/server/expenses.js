// Income/expense entries and the annual budget.

import * as db from './db.js';
import { route } from './router.js';
import { badRequest, body, cmp, isDate, storedUSDTWDRate } from './util.js';

/** Preset categories (add/edit dialog and AI import prompt); the first of each list is that type's default. */
export const EXPENSE_CATEGORIES = {
  expense: ['飲食', '飲料', '交通', '住房', '娛樂', '醫療', '日用品', '購物', '送禮', '其他支出'],
  income: ['薪資', '股利', '獎金', '其他收入'],
};

export const expenseJSON = (e) => ({ id: e.id, type: e.type, amount: e.amount, currency: e.currency, category: e.category, note: e.note, date: e.date, created_at: e.created_at });

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

/** Validates input and fills defaults (type=expense, currency=TWD). */
export function normalizeExpense(e) {
  const out = {
    type: e.type || 'expense',
    amount: Number(e.amount) || 0,
    currency: e.currency || 'TWD',
    category: e.category || '',
    note: e.note || '',
    date: e.date || '',
  };
  if (out.type !== 'income' && out.type !== 'expense') throw badRequest('type must be income or expense');
  if (!(out.amount > 0)) throw badRequest('金額必須大於 0');
  if (out.currency !== 'TWD' && out.currency !== 'USD') throw badRequest('currency must be TWD or USD');
  if (!isDate(out.date)) throw badRequest('日期格式需為 YYYY-MM-DD');
  return out;
}

function create(req) {
  const e = normalizeExpense(body(req));
  const row = db.insert('expenses', e);
  return { id: row.id, ...e, created_at: '' };
}

function updateExpense(req) {
  const e = normalizeExpense(body(req));
  db.update('expenses', req.params.id, e);
  return { status: 'updated' };
}

function remove(req) {
  db.remove('expenses', req.params.id);
  return { status: 'deleted' };
}

function categories() {
  const set = new Set();
  for (const e of db.all('expenses')) if (e.category !== '') set.add(e.category);
  return [...set].sort(cmp);
}

function yearParam(req) {
  const ys = req.query.get('year');
  return ys && /^-?\d+$/.test(ys) ? Number(ys) : new Date().getFullYear();
}

/**
 * Actual totals of one year in TWD (USD at the stored rate), index 0 = January:
 * { income, expense, byCategory: { income: {cat: amt}, expense: {cat: amt} } }.
 * Anything not 'income' counts as expense; an empty category stays '' (the UI labels it).
 */
function monthlyActuals(year) {
  const rate = storedUSDTWDRate();
  const months = Array.from({ length: 12 }, () => ({ income: 0, expense: 0, byCategory: { income: {}, expense: {} } }));
  for (const e of db.where('expenses', (e) => e.date.startsWith(`${year}-`))) {
    const m = Number(e.date.slice(5, 7));
    if (!(m >= 1 && m <= 12)) continue;
    const type = e.type === 'income' ? 'income' : 'expense';
    const v = e.currency === 'USD' ? e.amount * rate : e.amount;
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

/** Per-month income/expense, category sums and planned expense for the 收支 page charts. */
function getStats(req) {
  const year = yearParam(req);
  const planned = new Map(db.where('budgets', (b) => b.year === year).map((b) => [b.month, b.planned_expense]));
  const months = monthlyActuals(year).map((a, i) => ({
    month: i + 1,
    income: a.income,
    expense: a.expense,
    planned_expense: planned.get(i + 1) || 0,
    by_category: a.byCategory,
  }));
  const dec = monthlyActuals(year - 1)[11];
  return { year, months, prev_december: { income: dec.income, expense: dec.expense }, first_year: firstYear() };
}

function getBudgets(req) {
  const year = yearParam(req);

  const budgetMap = new Map();
  for (const b of db.where('budgets', (b) => b.year === year)) budgetMap.set(b.month, b);

  const actual = monthlyActuals(year);

  const resp = {
    year, months: [],
    total_planned_income: 0, total_planned_expense: 0,
    total_actual_income: 0, total_actual_expense: 0, total_net_savings: 0,
  };
  for (let m = 1; m <= 12; m++) {
    const b = budgetMap.get(m);
    const a = actual[m - 1];
    const d = {
      month: m,
      planned_income: b ? b.planned_income : 0,
      planned_expense: b ? b.planned_expense : 0,
      actual_income: a.income,
      actual_expense: a.expense,
    };
    d.income_diff = d.actual_income - d.planned_income;
    d.expense_diff = d.actual_expense - d.planned_expense;
    d.net_savings = d.actual_income - d.actual_expense;
    resp.total_planned_income += d.planned_income;
    resp.total_planned_expense += d.planned_expense;
    resp.total_actual_income += d.actual_income;
    resp.total_actual_expense += d.actual_expense;
    resp.months.push(d);
  }
  resp.total_net_savings = resp.total_actual_income - resp.total_actual_expense;
  return resp;
}

function saveBudget(req) {
  const b = body(req);
  db.upsert('budgets', {
    year: b.year, month: b.month,
    planned_income: b.planned_income, planned_expense: b.planned_expense,
  });
  return { status: 'saved' };
}

route('GET', '/api/budgets', getBudgets);
route('PUT', '/api/budgets', saveBudget);
route('GET', '/api/expenses', list);
route('POST', '/api/expenses', create);
route('PUT', '/api/expenses/{id}', updateExpense);
route('DELETE', '/api/expenses/{id}', remove);
route('GET', '/api/expenses/categories', categories);
route('GET', '/api/expenses/stats', getStats);
