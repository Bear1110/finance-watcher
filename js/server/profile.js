// 「關於你」: the user's own financial situation (age, income, goals, how big a drop they can take,
// large expenses ahead). Only the user knows these; they go into the AI prompt so the AI doesn't
// have to guess or ask every time, and 股市大跌時 (stressTest) compares a market drop with them.
//
// Stored as one JSON setting ('profile'); 每月生活費 stays its own setting (monthly_expense)
// because the dashboard's 現金可撐幾個月 (and the Settings page) already use it.

import * as db from './db.js';
import { route } from './router.js';
import { badRequest, body } from './util.js';
import { portfolioData } from './portfolio.js';

const KEY = 'profile';

/** Choices: key → [short label for the button, wording for the prompt]. */
export const CHOICES = {
  stability: { stable: ['穩定', '穩定，短期內不太可能失業'], normal: ['普通', '普通'], unstable: ['不穩定', '不穩定（自由業、業務、可能變動）'] },
  goal: { growth: ['長期成長', '長期累積資產、追求成長'], balanced: ['成長與穩定兼顧', '成長與穩定兼顧'], income: ['股利現金流', '穩定的股利現金流'], preserve: ['保本為主', '保本為主'] },
};

/** Fields counted in 已填 x/7, with their names. big_expenses: null = not answered, [] = none planned. */
export const LABELS = {
  birth_year: '年齡', income: '稅後月收入', monthly_expense: '每月生活費', stability: '收入穩定度',
  goal: '投資目標', max_drawdown: '可接受的最大跌幅', big_expenses: '未來大筆支出',
};

/** Large expenses this many years ahead count against the stress test's cash. */
export const BIG_EXPENSE_YEARS = 5;

const isEmpty = (v) => v === '' || v == null;

function stored() {
  try {
    const p = JSON.parse(db.getSetting(KEY) || '{}');
    return p && typeof p === 'object' && !Array.isArray(p) ? p : {};
  } catch {
    return {};
  }
}

export function getProfile() {
  const p = stored();
  return {
    birth_year: p.birth_year ?? null,
    income: p.income ?? null,
    bonus: p.bonus ?? null,
    monthly_expense: Number(db.getSetting('monthly_expense')) || null,
    stability: p.stability ?? null,
    goal: p.goal ?? null,
    max_drawdown: p.max_drawdown ?? null,
    big_expenses: Array.isArray(p.big_expenses) ? p.big_expenses : null,
    note: p.note ?? '',
    updated_at: p.updated_at ?? null,
  };
}

/** Fields still empty (keys of LABELS). */
export const missing = (p) => Object.keys(LABELS).filter((k) => isEmpty(p[k]));

/** Check one PUT body field; returns the value to store (null clears it) or throws. */
function clean(k, v) {
  const year = new Date().getFullYear();
  if (isEmpty(v)) return k === 'note' ? '' : null;
  switch (k) {
    case 'birth_year': {
      const n = Number(v);
      if (!(Number.isInteger(n) && n >= year - 110 && n <= year)) throw badRequest('出生年份不正確');
      return n;
    }
    case 'income': case 'bonus': case 'monthly_expense': {
      const n = Number(v);
      if (!(n > 0)) throw badRequest('金額要大於 0');
      return n;
    }
    case 'max_drawdown': {
      const n = Math.abs(Number(v)); // −30 and 30 mean the same
      if (!(n > 0 && n <= 100)) throw badRequest('可接受的跌幅要在 1～100% 之間');
      return n;
    }
    case 'stability': case 'goal':
      if (!(v in CHOICES[k])) throw badRequest(`${k} 選項不正確`);
      return v;
    case 'big_expenses':
      if (!Array.isArray(v)) throw badRequest('big_expenses 要是陣列');
      return v.map((e) => {
        const y = Number(e.year);
        const amt = Number(e.amount);
        if (!(Number.isInteger(y) && y >= year && y <= year + 50)) throw badRequest('大筆支出的年份不正確');
        if (!(amt > 0)) throw badRequest('大筆支出的金額要大於 0');
        return { year: y, amount: amt, what: String(e.what || '').slice(0, 40) };
      }).sort((a, b) => a.year - b.year);
    case 'note':
      return String(v).slice(0, 500);
    default:
      throw badRequest(`未知欄位 ${k}`);
  }
}

/** Merge the given fields; monthly_expense goes to its own setting. */
export function updateProfile(changes) {
  if (changes === null || typeof changes !== 'object' || Array.isArray(changes)) throw badRequest('invalid JSON: expected object');
  const p = stored();
  for (const [k, v] of Object.entries(changes)) {
    const value = clean(k, v);
    if (k === 'monthly_expense') db.setSetting('monthly_expense', value ?? '');
    else p[k] = value;
  }
  p.updated_at = db.today();
  db.setSetting(KEY, JSON.stringify(p));
  return getProfile();
}

export const STRESS_DROPS = [20, 30, 40];
/** The drop the forced-sale example in 股市大跌時 assumes. */
const SALE_DROP = 30;

/**
 * 股市大跌時: stocks fall by each drop, cash and other assets stay. Compared with the drop the user
 * said they can take and the large expenses due within BIG_EXPENSE_YEARS, which cash may not cover.
 */
export function stressTest({ stock, netWorth, cash, profile, year }) {
  if (!(stock > 0 && netWorth > 0)) return null;
  const max = profile.max_drawdown;
  const drops = STRESS_DROPS.map((drop) => {
    const loss = stock * drop / 100;
    const nwPct = loss / netWorth * 100;
    return { drop, loss, nw_pct: nwPct, remaining: netWorth - loss, over: max != null && nwPct > max };
  });
  const big = (profile.big_expenses || []).filter((e) => e.year - year <= BIG_EXPENSE_YEARS);
  // What cash can't cover has to come from selling stock, maybe right after a drop
  const shortfall = cash == null ? null : Math.max(0, big.reduce((s, e) => s + e.amount, 0) - cash);
  return {
    drops,
    max_drawdown: max,
    big,
    years: BIG_EXPENSE_YEARS,
    cash,
    shortfall,
    sale_drop: SALE_DROP,
    sale_at_drop: shortfall ? shortfall / (1 - SALE_DROP / 100) : 0, // stock to sell, at its pre-drop value
  };
}

async function stressData() {
  const p = await portfolioData();
  return p && stressTest({ stock: p.stock_value, netWorth: p.net_worth, cash: p.cash_twd, profile: getProfile(), year: new Date().getFullYear() });
}

/** The profile plus what the card needs to show (choices, what is missing) without restating the schema. */
const profileView = (p) => ({
  profile: p,
  missing: missing(p).map((k) => LABELS[k]),
  field_count: Object.keys(LABELS).length,
  choices: Object.fromEntries(Object.entries(CHOICES).map(([k, opts]) => [k, Object.entries(opts).map(([v, [short]]) => [v, short])])),
});

route('GET', '/api/profile', () => profileView(getProfile()));
route('PUT', '/api/profile', (req) => profileView(updateProfile(body(req))));
route('GET', '/api/profile/stress', stressData);
