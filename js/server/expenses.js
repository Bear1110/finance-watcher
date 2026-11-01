// Income/expense entries and the annual budget.

import * as db from './db.js';
import { route } from './router.js';
import { badRequest, body, cmp, isDate, storedUSDTWDRate } from './util.js';

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
function normalizeExpense(e) {
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

/** Sum in TWD (USD entries converted at the stored rate) */
function sumTWD(rows, rate) {
  return rows.reduce((s, e) => s + (e.currency === 'USD' ? e.amount * rate : e.amount), 0);
}

function getBudgets(req) {
  let year = new Date().getFullYear();
  const ys = req.query.get('year');
  if (ys && /^-?\d+$/.test(ys)) year = Number(ys);

  const budgetMap = new Map();
  for (const b of db.where('budgets', (b) => b.year === year)) budgetMap.set(b.month, b);

  const rate = storedUSDTWDRate();
  const prefix = `${year}-`;
  const actual = new Map(); // month -> [income, expense]
  for (const e of db.where('expenses', (e) => e.date.startsWith(prefix))) {
    const m = Number(e.date.slice(5, 7));
    if (!(m >= 1 && m <= 12)) continue;
    const pair = actual.get(m) || [0, 0];
    const v = e.currency === 'USD' ? e.amount * rate : e.amount;
    // Grouped by type: anything not 'income' lands in the expense slot
    if (e.type === 'income') pair[0] += v; else pair[1] += v;
    actual.set(m, pair);
  }

  const resp = {
    year, months: [],
    total_planned_income: 0, total_planned_expense: 0,
    total_actual_income: 0, total_actual_expense: 0, total_net_savings: 0,
  };
  for (let m = 1; m <= 12; m++) {
    const b = budgetMap.get(m);
    const a = actual.get(m) || [0, 0];
    const d = {
      month: m,
      planned_income: b ? b.planned_income : 0,
      planned_expense: b ? b.planned_expense : 0,
      actual_income: a[0],
      actual_expense: a[1],
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

function monthlySummary(req) {
  let month = req.query.get('month');
  if (!month) {
    const d = new Date();
    month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }
  const rate = storedUSDTWDRate();
  const inMonth = db.where('expenses', (e) => e.date.startsWith(month));
  const totalIncome = sumTWD(inMonth.filter((e) => e.type === 'income'), rate);
  const totalExpense = sumTWD(inMonth.filter((e) => e.type === 'expense'), rate);
  return { month, total_income: totalIncome, total_expense: totalExpense, net_savings: totalIncome - totalExpense };
}

route('GET', '/api/budgets', getBudgets);
route('PUT', '/api/budgets', saveBudget);
route('GET', '/api/expenses', list);
route('POST', '/api/expenses', create);
route('PUT', '/api/expenses/{id}', updateExpense);
route('DELETE', '/api/expenses/{id}', remove);
route('GET', '/api/expenses/summary', monthlySummary);
route('GET', '/api/expenses/categories', categories);
