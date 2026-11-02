// AI 匯入：使用者把別處的資料（記帳 App 截圖、券商對帳單、筆記）連同本網站產生的提示詞交給
// ChatGPT / Claude，AI 回一段 JSON，貼回來解析、預覽後匯入。
//
// 提示詞只有格式說明，不含使用者資料；資料是使用者自己貼給 AI 的，本網站不會送出。
// 解析刻意寬鬆：允許 ```json 圍欄、前後說明文字、中文的類型、幣別與買賣寫法。
//
// 每種可匯入的資料是 KINDS 裡的一項：
//   label, example, prompt()          提示詞裡的說明與範例
//   context()                         每次解析算一次的共用資料（選用）
//   normalize(raw, ctx)               一筆 → { row } 或 { error }
//   prepare(res)  (async，選用)        判斷重複之前的整批處理（例如股票分割換算）
//   key(row) / existing()             判斷重複
//   review(res)   (選用)               判斷重複之後的整批檢查（例如賣出時持股夠不夠）
//   insertAll(records) (async)        寫入（在 db.transaction 裡）
// 之後加股利、資產快照只要再登記一項。

import * as db from './db.js';
import { route } from './router.js';
import { badRequest, body, isCounted, round4 } from './util.js';
import { EXPENSE_CATEGORIES, normalizeExpense } from './expenses.js';
import { normalizeTxn, applyAutoFee, replaySymbol, ledgerOrder, fmtShares } from './ledger.js';
import { fetchDailyCloses, hasProxy } from './market.js';

export const IMPORT_FORMAT = 'finance-watcher-import';
export const IMPORT_VERSION = 1;

const str = (v) => String(v ?? '').trim();

/** "2026-10-05", "2026/10/5", "20261005", "2026-10" (→ the 1st) → "YYYY-MM-DD", or null. */
function normDate(v) {
  const m = str(v).match(/^(\d{4})[-/.]?(\d{1,2})(?:[-/.]?(\d{1,2}))?(?!\d)/);
  if (!m) return null;
  const [, y, mo, d = '1'] = m;
  if (+mo < 1 || +mo > 12 || +d < 1 || +d > 31) return null;
  return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

/** "1,200", "NT$ 1200", "-350元" → number (sign kept), or NaN. */
const normAmount = (v) => (typeof v === 'number' ? v : Number(str(v).replace(/[,\s]|NT\$|US\$|\$|元|＄|股/gi, '')));

/** null / "" / undefined stay null; anything else is a number (NaN if unreadable). */
const optAmount = (v) => (v == null || str(v) === '' ? null : normAmount(v));

const CURRENCY_WORDS = { twd: 'TWD', ntd: 'TWD', 'nt$': 'TWD', 台幣: 'TWD', 新台幣: 'TWD', 元: 'TWD', usd: 'USD', 'us$': 'USD', 美金: 'USD', 美元: 'USD' };

// ---------------------------------------------------------------- 收支

const TYPE_WORDS = { expense: 'expense', 支出: 'expense', income: 'income', 收入: 'income' };

/** Preset categories plus every category already used, per type. */
function expenseCategories() {
  const out = { expense: new Set(EXPENSE_CATEGORIES.expense), income: new Set(EXPENSE_CATEGORIES.income) };
  for (const e of db.all('expenses')) if (e.category) out[e.type === 'income' ? 'income' : 'expense'].add(e.category);
  return { expense: [...out.expense], income: [...out.income] };
}

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
  context: expenseCategories,
  normalize(raw, cats) {
    const date = normDate(raw.date);
    if (!date) return { error: `日期看不懂：${str(raw.date) || '（空白）'}` };
    const signed = normAmount(raw.amount);
    if (!Number.isFinite(signed) || signed === 0) return { error: `金額看不懂：${str(raw.amount) || '（空白）'}` };
    const type = TYPE_WORDS[str(raw.type).toLowerCase()] ?? 'expense'; // no type: expense (sign is dropped below)
    const currency = CURRENCY_WORDS[str(raw.currency).toLowerCase()] ?? 'TWD';

    const other = type === 'income' ? '其他收入' : '其他支出';
    let category = str(raw.category);
    const notes = [str(raw.note)];
    if (!category) category = other;
    else if (!cats[type].includes(category)) {
      notes.unshift(`原分類：${category}`);
      category = other;
    }
    return { row: normalizeExpense({ type, amount: Math.abs(signed), currency, category, date, note: notes.filter(Boolean).join('；') }) };
  },
  key: (r) => [r.date, r.type, r.category, Math.round(r.amount * 100), r.currency].join('|'),
  existing: () => db.all('expenses'),
  async insertAll(records) {
    for (const r of records) db.insert('expenses', r);
  },
};

// ---------------------------------------------------------------- 股票交易

const ACTION_WORDS = {
  buy: 'BUY', b: 'BUY', 買: 'BUY', 買進: 'BUY', 買入: 'BUY', 現買: 'BUY', 普買: 'BUY',
  sell: 'SELL', s: 'SELL', 賣: 'SELL', 賣出: 'SELL', 現賣: 'SELL', 普賣: 'SELL',
};

/** "0050" → "0050.TW" (".TWO" when that symbol is the one already in use); US tickers upper-cased. */
function normSymbol(v, market) {
  const s = str(v).toUpperCase().replace(/\s+/g, '');
  if (!s || /\.(TW|TWO)$/.test(s)) return s;
  if (market === 'TW' || /^\d{4,6}[A-Z]?$/.test(s)) {
    const two = `${s}.TWO`;
    const used = db.findBy('stock_holdings', 'symbol', two) || db.where('stock_transactions', (t) => t.symbol === two).length;
    return used ? two : `${s}.TW`;
  }
  return s;
}

// Daily closes per symbol for the split check; parse and commit read the same text twice.
const closesCache = new Map(); // symbol -> { since, at, closes }
async function closesSince(symbol, since) {
  const c = closesCache.get(symbol);
  if (c && c.since <= since && Date.now() - c.at < 10 * 60 * 1000) return c.closes;
  const closes = await fetchDailyCloses(symbol, new Date(`${since}T00:00:00Z`));
  closesCache.set(symbol, { since, at: Date.now(), closes });
  return closes;
}

const transactions = {
  label: '股票交易',
  example: [
    { date: '2025-10-13', symbol: '0050', market: 'TW', action: 'BUY', shares: 1000, price: 60.6, fee: 86, tax: 0, currency: 'TWD', realized_pl: null, note: '委託書號 FG995' },
    { date: '2026-01-15', symbol: 'NVDA', market: 'US', action: 'SELL', shares: 10, price: 200, fee: 1, tax: 0, currency: 'USD', realized_pl: 350, note: '' },
  ],
  prompt() {
    return `股票交易（transactions）規則：
- 每筆成交一筆；「合計」「小計」列不要。不要輸出帳號、姓名。
- date：成交日 YYYY-MM-DD。
- symbol：台股只寫代號（例如 "0050"、"2330"、"00881"），美股寫 ticker（例如 "NVDA"）。
- market："TW" 或 "US"；currency：台股 "TWD"、美股 "USD"。
- action："BUY"（買進、現買）或 "SELL"（賣出、現賣）。融資、融券、當沖也轉成 BUY / SELL，並在 note 註明。
- shares：股數（「張」要換成股數，1 張 = 1000 股）；price：成交價。
- fee：手續費；tax：交易稅（買進通常是 0）。資料沒寫就給 null，App 會估算台股的費用。
- realized_pl：資料有列出這筆賣出的損益就照抄（虧損用負數），沒有就 null；買進一律 null。
- note：委託書號等補充，沒有就 ""。
- 股票分割前的交易照資料上的股數、價格寫，不要自己換算（App 會比對歷史股價換算）。`;
  },
  normalize(raw) {
    const date = normDate(raw.date);
    if (!date) return { error: `日期看不懂：${str(raw.date) || '（空白）'}` };
    const action = ACTION_WORDS[str(raw.action).toLowerCase()];
    if (!action) return { error: `看不出是買進還是賣出：${str(raw.action) || '（空白）'}` };
    const market = str(raw.market).toUpperCase();
    const symbol = normSymbol(raw.symbol, market);
    if (!symbol) return { error: '缺少股票代號' };
    const fee = optAmount(raw.fee);
    const tax = optAmount(raw.tax);
    const pl = optAmount(raw.realized_pl);
    if ([fee, tax, pl].some((v) => v != null && !Number.isFinite(v))) return { error: '手續費、稅或損益看不懂' };

    const txn = normalizeTxn({
      symbol, market: market === 'TW' || market === 'US' ? market : '', action, date,
      shares: Math.abs(normAmount(raw.shares)), price: Math.abs(normAmount(raw.price)),
      fee: Math.abs(fee ?? 0), tax: Math.abs(tax ?? 0),
      currency: CURRENCY_WORDS[str(raw.currency).toLowerCase()] ?? '', note: str(raw.note),
    });
    txn.flags = [];
    if (fee == null && tax == null && txn.market === 'TW') {
      txn.auto_fee = true;
      applyAutoFee(txn);
      txn.flags.push('費用為估算');
    }
    txn.realized_pl = action === 'SELL' ? pl : null; // null = not given
    return { row: txn };
  },

  /**
   * Trades priced at a whole multiple of that day's (split-adjusted) close happened before a split:
   * convert to today's units (shares × k, price ÷ k), the units Yahoo's history and the ledger use.
   */
  async prepare(res) {
    const symbols = [...new Set(res.records.map((r) => r.symbol))];
    if (!symbols.length) return;
    if (!hasProxy()) {
      res.warnings.push('沒有行情代理，無法檢查股票分割：分割前的交易請自行換算成分割後的股數與價格。');
      return;
    }
    for (const sym of symbols) {
      const rows = res.records.filter((r) => r.symbol === sym);
      let closes;
      try {
        closes = await closesSince(sym, rows.reduce((m, r) => (r.date < m ? r.date : m), rows[0].date));
      } catch {
        res.warnings.push(`${sym} 抓不到歷史股價，無法檢查股票分割。`);
        continue;
      }
      for (const r of rows) {
        const bar = closes.filter((c) => c.date <= r.date).pop();
        if (!bar) continue;
        const ratio = r.price / bar.close;
        const k = Math.round(ratio >= 1 ? ratio : 1 / ratio);
        if (k < 2 || Math.abs((ratio >= 1 ? ratio : 1 / ratio) / k - 1) > 0.08) continue;
        if (ratio >= 1) {
          r.shares *= k;
          r.price = round4(r.price / k);
          r.flags.push(`分割前交易，已換算 1→${k}（原 ${fmtShares(r.shares / k)} 股 @ ${round4(r.price * k)}）`);
        } else {
          r.shares /= k;
          r.price = round4(r.price * k);
          r.flags.push(`合併前交易，已換算 ${k}→1`);
        }
      }
    }
  },

  key: (r) => [r.date, r.symbol, r.action, round4(r.shares), round4(r.price)].join('|'),
  existing: () => db.where('stock_transactions', (t) => t.account_id == null),

  /**
   * A SELL needs enough shares held on its date (existing trades + earlier rows of this import).
   * Without them it can only be imported as a history sell (fixed realized_pl, no shares taken),
   * which needs the statement's P&L; otherwise it is reported as an error.
   */
  review(res) {
    const bySymbol = new Map();
    for (const r of res.records) bySymbol.set(r.symbol, [...(bySymbol.get(r.symbol) || []), r]);
    const drop = new Set();
    for (const [sym, rows] of bySymbol) {
      const old = db.where('stock_transactions', (t) => t.symbol === sym && isCounted(t));
      const transfer = old.find((t) => t.is_transfer === 1 && t.action === 'BUY');
      if (transfer && rows.some((r) => r.action === 'BUY')) {
        res.warnings.push(`${sym} 已有「匯入持倉」建立的 ${fmtShares(transfer.shares)} 股（${transfer.date}）。` +
          '如果這次匯入的買進已包含這些持股，持股會重複計算：請先到交易紀錄刪掉那筆匯入持倉再匯入。');
      }
      // Existing rows first on the same date, then this import in order (ids only break ties)
      const all = [...old, ...rows.map((r, i) => ({ ...r, id: Number.MAX_SAFE_INTEGER - rows.length + i, ref: r }))].sort(ledgerOrder);
      let held = 0;
      for (const t of all) {
        if (t.action === 'BUY') { held += t.shares; continue; }
        if (!t.ref) { held = Math.max(0, held - t.shares); continue; }
        if (held + 1e-9 >= t.shares) { held -= t.shares; continue; }
        if (t.realized_pl != null) {
          t.ref.history = true;
          t.ref.flags.push(`當時持股不足（${fmtShares(held)} 股），以歷史損益匯入：不扣持股`);
        } else {
          drop.add(t.ref);
          res.errors.push({ index: t.ref.index, error: `${t.date} ${sym} 賣出 ${fmtShares(t.shares)} 股，但當時持股只有 ${fmtShares(held)} 股，資料也沒有這筆的損益金額` });
        }
      }
    }
    res.records = res.records.filter((r) => !drop.has(r));
  },

  async insertAll(records) {
    const ids = new Set();
    for (const r of records) {
      const row = db.insert('stock_transactions', {
        symbol: r.symbol, market: r.market, action: r.action, shares: r.shares, price: r.price,
        fee: r.fee, tax: r.tax, currency: r.currency, date: r.date, note: r.note,
        ...(r.history ? { realized_pl: r.realized_pl, pl_manual: 1, lots_consumed: 0 } : { realized_pl: 0 }),
      });
      if (!r.history) ids.add(row.id);
    }
    for (const sym of new Set(records.map((r) => r.symbol))) {
      for (const [id, sh] of replaySymbol(sym).uncovered) {
        if (ids.has(id)) throw badRequest(`${sym} 有一筆賣出缺少 ${fmtShares(sh)} 股的買入紀錄`);
      }
    }
  },
};

export const KINDS = { expenses, transactions };

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
 * Per kind: { records, duplicates, errors: [{ index, error }], warnings }. Rows equal to an
 * existing record (or an earlier row in the same paste) are skipped as duplicates.
 * A bare array is read as the first requested kind.
 */
export async function parseImport(text, kinds = Object.keys(KINDS)) {
  const data = extractJson(text);
  const sections = Array.isArray(data) ? { [kinds[0]]: data } : data;
  const out = {};
  for (const k of Object.keys(KINDS)) {
    if (!Array.isArray(sections?.[k])) continue;
    const kind = KINDS[k];
    const ctx = kind.context?.();
    const res = { records: [], duplicates: 0, errors: [], warnings: [] };
    sections[k].forEach((raw, index) => {
      if (!raw || typeof raw !== 'object') return res.errors.push({ index, error: '不是一筆物件' });
      try {
        const { row, error } = kind.normalize(raw, ctx);
        if (error) return res.errors.push({ index, error });
        row.index = index;
        res.records.push(row);
      } catch (e) {
        res.errors.push({ index, error: e.message });
      }
    });
    await kind.prepare?.(res);
    const seen = new Set(kind.existing().map(kind.key));
    res.records = res.records.filter((r) => {
      const key = kind.key(r);
      if (seen.has(key)) { res.duplicates++; return false; }
      seen.add(key);
      return true;
    });
    kind.review?.(res);
    res.errors.sort((a, b) => a.index - b.index);
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
  const parsed = await parseImport(r.text, r.kinds);
  const counts = {};
  await db.transaction(async () => {
    for (const [k, res] of Object.entries(parsed)) {
      await KINDS[k].insertAll(res.records);
      counts[k] = res.records.length;
    }
  });
  return counts;
});
