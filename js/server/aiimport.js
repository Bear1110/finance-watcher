// AI 匯入：使用者把別處的資料（記帳 App 截圖、對帳單、筆記）連同本網站產生的提示詞交給
// ChatGPT / Claude，AI 回一段 JSON，貼回來解析、預覽後匯入。
//
// 提示詞只有格式說明，不含使用者資料；資料是使用者自己貼給 AI 的，本網站不會送出。
// 解析刻意寬鬆：允許 ```json 圍欄、前後說明文字、中文的類型與幣別寫法。
//
// 每種可匯入的資料是 KINDS 裡的一項（prompt / normalize / key / existing / insert），
// 之後加股票交易、股利、資產快照只要再登記一項。

import * as db from './db.js';
import { route } from './router.js';
import { badRequest, body } from './util.js';
import { EXPENSE_CATEGORIES, normalizeExpense } from './expenses.js';

export const IMPORT_FORMAT = 'finance-watcher-import';
export const IMPORT_VERSION = 1;

const str = (v) => String(v ?? '').trim();

// ---------------------------------------------------------------- 收支

/** Preset categories plus every category already used, per type. */
function expenseCategories() {
  const out = { expense: new Set(EXPENSE_CATEGORIES.expense), income: new Set(EXPENSE_CATEGORIES.income) };
  for (const e of db.all('expenses')) if (e.category) out[e.type === 'income' ? 'income' : 'expense'].add(e.category);
  return { expense: [...out.expense], income: [...out.income] };
}

/** "2026-10-05", "2026/10/5", "2026-10" (→ the 1st) → "YYYY-MM-DD", or null. */
function normDate(v) {
  const m = str(v).match(/^(\d{4})[-/.](\d{1,2})(?:[-/.](\d{1,2}))?/);
  if (!m) return null;
  const [, y, mo, d = '1'] = m;
  if (+mo < 1 || +mo > 12 || +d < 1 || +d > 31) return null;
  return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

/** "1,200", "NT$ 1200", "-350元" → number (sign kept), or NaN. */
const normAmount = (v) => (typeof v === 'number' ? v : Number(str(v).replace(/[,\s]|NT\$|US\$|\$|元|＄/gi, '')));

const TYPE_WORDS = { expense: 'expense', 支出: 'expense', income: 'income', 收入: 'income' };
const CURRENCY_WORDS = { twd: 'TWD', ntd: 'TWD', 'nt$': 'TWD', 台幣: 'TWD', 新台幣: 'TWD', 元: 'TWD', usd: 'USD', 'us$': 'USD', 美金: 'USD', 美元: 'USD' };

const expenses = {
  label: '收支',
  example: [
    { date: '2026-10-05', type: 'expense', category: '飲食', amount: 1200, currency: 'TWD', note: '' },
    { date: '2026-10-05', type: 'income', category: '薪資', amount: 118000, currency: 'TWD', note: '' },
  ],
  prompt() {
    const cats = expenseCategories();
    return `收支（expenses）規則：
- 每筆收入或支出一筆。如果資料是月報表（每個分類一個月的總額），就每個分類每個月一筆，date 用該月 1 號。
- date：YYYY-MM-DD。資料沒寫年份時先問我，不要猜。
- type："expense"（支出）或 "income"（收入）。
- amount：正數，不含貨幣符號與千分位。
- currency："TWD" 或 "USD"，沒寫就用 "TWD"。
- category：用下面的分類，對不上的用「其他支出」或「其他收入」，原本的名稱寫進 note。
  支出：${cats.expense.join('、')}
  收入：${cats.income.join('、')}
- note：品項、店家等補充，沒有就 ""。`;
  },
  normalize(raw) {
    if (!raw || typeof raw !== 'object') return { error: '不是一筆物件' };
    const date = normDate(raw.date);
    if (!date) return { error: `日期看不懂：${str(raw.date) || '（空白）'}` };
    const signed = normAmount(raw.amount);
    if (!Number.isFinite(signed) || signed === 0) return { error: `金額看不懂：${str(raw.amount) || '（空白）'}` };
    const type = TYPE_WORDS[str(raw.type).toLowerCase()] ?? 'expense'; // no type: expense (sign is dropped below)
    const currency = CURRENCY_WORDS[str(raw.currency).toLowerCase()] ?? 'TWD';

    const known = expenseCategories()[type];
    const other = type === 'income' ? '其他收入' : '其他支出';
    let category = str(raw.category);
    const notes = [str(raw.note)];
    if (!category) category = other;
    else if (!known.includes(category)) {
      notes.unshift(`原分類：${category}`);
      category = other;
    }
    try {
      return { row: normalizeExpense({ type, amount: Math.abs(signed), currency, category, date, note: notes.filter(Boolean).join('；') }) };
    } catch (e) {
      return { error: e.message };
    }
  },
  key: (r) => [r.date, r.type, r.category, Math.round(r.amount * 100), r.currency].join('|'),
  existing: () => db.all('expenses'),
  insert: (r) => db.insert('expenses', r),
};

export const KINDS = { expenses };

// ---------------------------------------------------------------- prompt

/** The prompt for the chosen kinds: format and rules only, never the user's data. */
export function buildPrompt(kinds) {
  const chosen = kinds.filter((k) => KINDS[k]);
  if (!chosen.length) throw badRequest('請至少選一種資料');
  const example = { format: IMPORT_FORMAT, version: IMPORT_VERSION };
  for (const k of chosen) example[k] = KINDS[k].example;
  return `你是幫我把資料匯入理財 App「Finance Watcher」的助手。
接下來我會貼上資料（文字、表格或截圖）。請把其中每一筆轉成下面格式的 JSON，只回覆一個 JSON code block，不要其他說明：

${JSON.stringify(example, null, 2)}

${chosen.map((k) => KINDS[k].prompt()).join('\n\n')}

共通規則：
- 不要編造資料裡沒有的內容；看不清楚或不確定的地方先問我。
- 資料裡沒有的種類就給空陣列。

我的資料：
`;
}

// ---------------------------------------------------------------- parse

/** The JSON object in a pasted reply (``` fences and text around it are fine). */
export function extractJson(text) {
  const fenced = str(text).match(/```(?:json)?\s*([\s\S]*?)```/i);
  const src = (fenced ? fenced[1] : str(text)).trim();
  try { return JSON.parse(src); } catch { /* fall through */ }
  const start = src.search(/[[{]/);
  const end = Math.max(src.lastIndexOf('}'), src.lastIndexOf(']'));
  if (start < 0 || end <= start) throw badRequest('找不到 JSON：請貼上 AI 回覆的整段內容');
  try {
    return JSON.parse(src.slice(start, end + 1));
  } catch {
    throw badRequest('JSON 格式有誤：請確認貼上的是完整的回覆');
  }
}

/**
 * Per kind: { records, duplicates, errors: [{ index, error }] }. Rows equal to an existing
 * record (or an earlier row in the same paste) are skipped as duplicates.
 * A bare array is read as the first requested kind.
 */
export function parseImport(text, kinds = Object.keys(KINDS)) {
  const data = extractJson(text);
  const sections = Array.isArray(data) ? { [kinds[0]]: data } : data;
  const out = {};
  for (const k of Object.keys(KINDS)) {
    if (!Array.isArray(sections?.[k])) continue;
    const kind = KINDS[k];
    const seen = new Set(kind.existing().map(kind.key));
    const res = { records: [], duplicates: 0, errors: [] };
    sections[k].forEach((raw, index) => {
      const { row, error } = kind.normalize(raw);
      if (error) return res.errors.push({ index, error });
      const key = kind.key(row);
      if (seen.has(key)) return res.duplicates++;
      seen.add(key);
      res.records.push(row);
    });
    out[k] = res;
  }
  if (!Object.keys(out).length) throw badRequest('回覆裡沒有可匯入的資料');
  return out;
}

// ---------------------------------------------------------------- routes

route('GET', '/api/ai-import/kinds', () => Object.entries(KINDS).map(([id, k]) => ({ id, label: k.label })));

route('POST', '/api/ai-import/prompt', (req) => ({ prompt: buildPrompt(body(req).kinds || []) }));

route('POST', '/api/ai-import/parse', (req) => {
  const r = body(req);
  return parseImport(r.text, r.kinds);
});

// Re-parses the same text so only validated, de-duplicated rows are written, in one transaction.
route('POST', '/api/ai-import/commit', async (req) => {
  const r = body(req);
  const parsed = parseImport(r.text, r.kinds);
  const counts = {};
  await db.transaction(() => {
    for (const [k, res] of Object.entries(parsed)) {
      res.records.forEach(KINDS[k].insert);
      counts[k] = res.records.length;
    }
  });
  return counts;
});
