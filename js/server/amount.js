// Reading money amounts people type or paste: "NT$ 120,000", "１２０＋３０", "1200+350.5".
// Shared by the snapshot form's typed sums (calcInfo / calcExpr: the live result on the page and the
// saved value are the same calculation) and AI 匯入 (aiimport.js normAmount).

import { EXPENSE_CURRENCIES } from './expenses.js';

const escapeRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Full-width (中文輸入法) letters, digits and signs → ASCII; the full-width space → space. */
export const toHalfWidth = (s) => String(s ?? '')
  .replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/　/g, ' ');

// Currency symbols (longest first, so US$ goes before $) and units
const CURRENCY_JUNK = new RegExp([...EXPENSE_CURRENCIES.map((c) => c.symbol).sort((a, b) => b.length - a.length), '$', '￥', '元', '円']
  .map(escapeRe).join('|'), 'gi');

/** Text without currency symbols / units, half-width: "NT$ 1,200元" → " 1,200". */
export const stripCurrency = (s) => toHalfWidth(s).replace(CURRENCY_JUNK, '');

// A number: commas only as thousands separators (350,5 is not 3505), no leading zeros (2026-01 is a
// date, not 2025), optional decimals. The whole may start with a minus (an old negative balance being
// edited); the caller decides whether a negative result is allowed.
const NUM = String.raw`(?:(?:\d{1,3}(?:,\d{3})+|0|[1-9]\d*)(?:\.\d*)?|\.\d+)`;
const CALC_RE = new RegExp(String.raw`^-?${NUM}(?:[-+*/]${NUM})*$`);
const CALC_TERM = new RegExp(String.raw`(^-?|[-+*/])(${NUM})`, 'g');
const OPEN_RE = /[-+*/]$/;

// Two numbers with only a space between them (120000 35000: a + left out) are not joined into one
const SPACED_NUMS = /[\d.]\s+[\d.]/;
const normCalc = (s) => stripCurrency(s).replace(/\s/g, '')
  .replace(/[−–]/g, '-').replace(/[×xX]/g, '*').replace(/÷/g, '/');

/**
 * A typed sum like "120,000+35000-2*500" → { value: 154000, sum: true, open: false }: + − × ÷ with
 * × ÷ first, no brackets; only the first number may have a sign. Spaces (not between two numbers),
 * full-width characters, ×÷ and currency symbols are fine. value is null when it isn't such a sum (or divides by zero); sum: it has an operator
 * (worth showing the result); open: it ends in an operator (the next term is still being typed).
 */
export function calcInfo(s) {
  const t = normCalc(s);
  const open = OPEN_RE.test(t);
  if (SPACED_NUMS.test(stripCurrency(s)) || !CALC_RE.test(t)) return { value: null, sum: false, open };
  let total = 0, term = 0, n = 0;
  for (const [, op, num] of t.matchAll(CALC_TERM)) {
    const v = Number(num.replace(/,/g, ''));
    n++;
    if (op === '*') term *= v;
    else if (op === '/') term /= v;
    else { total += term; term = op.endsWith('-') ? -v : v; }
  }
  total += term;
  const value = Number.isFinite(total) ? Math.round(total * 1e8) / 1e8 : null; // 0.1+0.2 → 0.3
  return { value, sum: n > 1, open };
}

/** calcInfo's number, or null. */
export const calcExpr = (s) => calcInfo(s).value;
