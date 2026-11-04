// CSV downloads (UTF-8 BOM so Excel opens Chinese text).

import * as db from './db.js';
import { route } from './router.js';
import { download, cmp } from './util.js';
import { expenseTWD } from './expenses.js';
import { queryDividends } from './dividends.js';

/** encoding/csv quoting rules */
function csvField(s) {
  s = String(s ?? '');
  if (s === '') return s;
  if (/[",\r\n]/.test(s) || s[0] === ' ' || s[0] === '\t') return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function writeCSV(name, header, rows) {
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const lines = [header, ...rows].map((r) => r.map(csvField).join(',') + '\n').join('');
  return download(`${name}-${stamp}.csv`, '﻿' + lines);
}

/** strconv.FormatFloat(v, 'f', -1, 64): shortest repr, never exponent form. */
export function ftoa(v) {
  const s = String(v);
  if (!/e/i.test(s)) return s;
  return Math.abs(v) >= 1 ? BigInt(Math.round(v)).toString() : v.toFixed(20).replace(/0+$/, '');
}

const yearMatch = (year) => (r) => !year || r.date.slice(0, 4) === year;

// GET /api/transactions/export?year=YYYY
function exportTransactions(req) {
  const year = req.query.get('year') || '';
  const rows = db.where('stock_transactions', (t) => t.account_id == null && yearMatch(year)(t))
    .sort((a, b) => cmp(a.date, b.date) || a.id - b.id)
    .map((t) => [t.date, t.symbol, t.market, t.action, ftoa(t.shares), ftoa(t.price), ftoa(t.fee), ftoa(t.tax), t.currency, ftoa(t.realized_pl), t.note]);
  return writeCSV('transactions', ['日期', '代號', '市場', '買賣', '股數', '價格', '手續費', '證交稅', '幣別', '已實現損益', '備註'], rows);
}

// GET /api/expenses/export?year=YYYY
function exportExpenses(req) {
  const year = req.query.get('year') || '';
  const rows = db.where('expenses', yearMatch(year))
    .sort((a, b) => cmp(a.date, b.date) || a.id - b.id)
    .map((e) => [e.date, e.type, e.category, ftoa(e.amount), e.currency, e.currency === 'TWD' ? '' : ftoa(e.fx_rate), ftoa(Math.round(expenseTWD(e))), e.note]);
  return writeCSV('expenses', ['日期', '類型', '類別', '金額', '幣別', '匯率', '台幣金額', '備註'], rows);
}

// GET /api/dividends/export?year=YYYY
async function exportDividends(req) {
  const list = await queryDividends(req.query.get('year') || '');
  const rows = list.map((d) => [d.date, d.symbol, d.market, ftoa(d.amount), ftoa(d.withheld), d.currency, d.note]);
  return writeCSV('dividends', ['日期', '代號', '市場', '實收金額', '已扣稅費', '幣別', '備註'], rows);
}

route('GET', '/api/transactions/export', exportTransactions);
route('GET', '/api/expenses/export', exportExpenses);
route('GET', '/api/dividends/export', exportDividends);
