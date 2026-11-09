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
//   plan(res, summary)  (選用)         「以對帳單取代」：要刪哪些、匯入持倉改成什麼、合計對不對得上
//   review(res, plan)   (選用)         判斷重複之後的整批檢查（例如賣出時持股夠不夠）
//   insertAll(records, plan) (async)  寫入（在 db.transaction 裡；plan 只在取代模式時給）
// 之後加股利只要再登記一項。
//
// 模式：add（預設）只新增、略過重複；replace（有 plan() 的種類才有）把對帳單期間內這幾檔股票的
// 舊交易換成這份對帳單，期間開始前的持股用「匯入持倉」補上（股數由目前持股倒推）。

import * as db from './db.js';
import { route } from './router.js';
import { badRequest, body, isCounted, isDate, round4 } from './util.js';
import { EXPENSE_CATEGORIES, EXPENSE_CURRENCIES, expenseTWD, normalizeExpense, withFxRate } from './expenses.js';
import { normalizeTxn, applyAutoFee, replaySymbol, ledgerOrder, fmtShares } from './ledger.js';
import { hasProxy } from './market.js';
import { syncPriceHistory, performance } from './twr.js';
import { autoFill, insertSnapshot } from './assets.js';
import { addDays } from './twr_calc.js';
import { stripCurrency } from './amount.js';

const IMPORT_FORMAT = 'finance-watcher-import';
const IMPORT_VERSION = 1;

const str = (v) => String(v ?? '').trim();

/** "2026-10-05", "2026/10/5", "20261005", "2026-10" (→ the 1st) → "YYYY-MM-DD", or null. */
function normDate(v) {
  const m = str(v).match(/^(\d{4})[-/.]?(\d{1,2})(?:[-/.]?(\d{1,2}))?(?!\d)/);
  if (!m) return null;
  const [, y, mo, d = '1'] = m;
  const out = `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
  return isDate(out) ? out : null;
}

/** "1,200", "NT$ 1200", "-350元", "100股" → number (sign kept), or NaN. Currency symbols: amount.js, shared with the snapshot form. */
const normAmount = (v) => (typeof v === 'number' ? v : Number(stripCurrency(v).replace(/股|[,\s]/g, '')));

/** null / "" / undefined stay null; anything else is a number (NaN if unreadable). */
const optAmount = (v) => (v == null || str(v) === '' ? null : normAmount(v));

const CURRENCY_WORDS = { twd: 'TWD', ntd: 'TWD', 'nt$': 'TWD', 台幣: 'TWD', 新台幣: 'TWD', 元: 'TWD', usd: 'USD', 'us$': 'USD', 美金: 'USD', 美元: 'USD' };

// ---------------------------------------------------------------- 收支

const TYPE_WORDS = { expense: 'expense', 支出: 'expense', income: 'income', 收入: 'income' };

/** 收支 also take the travel currencies: code, symbol, name and aliases (lowercase keys). */
const EXPENSE_CURRENCY_WORDS = {
  ...CURRENCY_WORDS,
  ...Object.fromEntries(EXPENSE_CURRENCIES.flatMap((c) =>
    [c.code, c.symbol, c.name, ...c.aliases].map((w) => [w.toLowerCase(), c.code]))),
};

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
- currency：${EXPENSE_CURRENCIES.map((c) => `"${c.code}"（${c.name}）`).join('、')}，沒寫就用 "TWD"。amount 填原幣金額，不要自己換算台幣。
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
    const currency = str(raw.currency) ? EXPENSE_CURRENCY_WORDS[str(raw.currency).toLowerCase()] : 'TWD';
    if (!currency) return { error: `不支援的幣別：${str(raw.currency)}` };

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
  // Foreign rows get their date's market rate (one lookup per currency and date, all at once);
  // a row whose rate can't be fetched can't be imported. amount_twd is for the preview.
  async prepare(res) {
    const lookups = new Map();
    const rated = (r) => {
      const k = `${r.currency}|${r.date}`;
      if (!lookups.has(k)) lookups.set(k, withFxRate(r).then((x) => x.fx_rate));
      return lookups.get(k);
    };
    const done = await Promise.allSettled(res.records.map(rated));
    const kept = [];
    res.records.forEach((r, i) => {
      if (done[i].status === 'rejected') {
        res.errors.push({ index: r.index, error: `${r.currency} 匯率：${done[i].reason.message}` });
        return;
      }
      const row = { ...r, fx_rate: done[i].value };
      kept.push({ ...row, amount_twd: expenseTWD(row) });
    });
    res.records = kept;
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

/** Rows grouped by symbol: Map(symbol → rows), in input order. */
function bySymbol(rows) {
  const out = new Map();
  for (const r of rows) {
    if (!out.has(r.symbol)) out.set(r.symbol, []);
    out.get(r.symbol).push(r);
  }
  return out;
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
- 股票分割前的交易照資料上的股數、價格寫，不要自己換算（App 會比對歷史股價換算）。
- transactions_summary：對帳單上印的查詢期間（period_start / period_end）與「合計」列的
  股數（total_shares）、價金（total_amount）照抄；資料上沒有的欄位給 null。`;
  },
  summaryExample: { period_start: '2024-10-01', period_end: '2025-10-31', total_shares: 58000, total_amount: 1783620 },
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
    txn.stmt_shares = txn.shares; // as printed (before split conversion), for the 合計 check
    return { row: txn };
  },

  /**
   * Trades priced at a whole multiple of that day's (split-adjusted) close happened before a split:
   * convert to today's units (shares × k, price ÷ k), the units Yahoo's history and the ledger use.
   */
  async prepare(res) {
    const groups = bySymbol(res.records);
    if (!groups.size) return;
    if (!hasProxy()) {
      res.warnings.push('沒有行情代理，無法檢查股票分割：分割前的交易請自行換算成分割後的股數與價格。');
      return;
    }
    const firstDate = (rows) => rows.reduce((m, r) => (r.date < m ? r.date : m), rows[0].date);
    // All symbols in one go (fetched in parallel, kept in price_history for performance / data check)
    const closes = await syncPriceHistory(Object.fromEntries([...groups].map(([sym, rows]) => [sym, firstDate(rows)])));
    // A bare TW code was guessed as .TW (上市); if Yahoo only knows .TWO (上櫃), use that
    const missing = [...groups.keys()].filter((sym) => !closes[sym]?.length && sym.endsWith('.TW'));
    if (missing.length) {
      const alt = await syncPriceHistory(Object.fromEntries(missing.map((sym) => [`${sym}O`, firstDate(groups.get(sym))])));
      for (const sym of missing) {
        const two = `${sym}O`;
        if (!alt[two]?.length) continue;
        for (const r of groups.get(sym)) r.symbol = two;
        res.warnings.push(`${sym.slice(0, -3)} 是上櫃股票，代號改為 ${two}。`);
        closes[sym] = alt[two];
      }
    }
    for (const [sym, rows] of groups) {
      const list = closes[sym];
      if (!list?.length) {
        res.warnings.push(`${rows[0].symbol} 抓不到歷史股價，無法檢查股票分割。`);
        continue;
      }
      for (const r of rows) {
        const bar = list.filter((c) => c.date <= r.date).pop();
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
   * 「以對帳單取代」: for every symbol in the statement, the self-account trades inside the
   * statement period are removed and the statement's rows go in instead. Holdings before the
   * period can't be read from the statement, so they are worked back from today's holdings:
   *   shares before = current holdings − net of the statement − net of the trades that stay
   * and kept as one 匯入持倉 (transfer BUY) at its old date, or the day before the period,
   * at the old transfer's cost (today's average cost if there was none).
   * Without a printed 查詢期間 the statement's coverage is unknown, so each symbol only
   * replaces its own first..last trade dates (a 2022 statement start must not drag a stock's
   * 匯入持倉 back before it was even listed).
   * `problems` block the replace; `checks` are shown as information.
   */
  plan(res, summary) {
    const rows = res.records;
    if (!rows.length) return null;
    const dates = rows.map((r) => r.date).sort();
    const pStart = normDate(summary?.period_start);
    const pEnd = normDate(summary?.period_end);
    const start = pStart || dates[0];
    const end = pEnd || dates[dates.length - 1]; // only checks rows against a printed period
    const problems = [];
    const checks = [];

    if (dates[0] < start || dates[dates.length - 1] > end) problems.push(`有交易不在查詢期間 ${start} ~ ${end} 內，期間可能抄錯`);
    const totShares = optAmount(summary?.total_shares);
    const totAmount = optAmount(summary?.total_amount);
    const sumShares = rows.reduce((n, r) => n + r.stmt_shares, 0);
    const sumAmount = Math.round(rows.reduce((n, r) => n + r.shares * r.price, 0)); // unchanged by split conversion
    if (totShares == null && totAmount == null) {
      checks.push('對帳單沒有合計列，無法核對 AI 有沒有漏抓：請自己對一下筆數');
    }
    if (totShares != null) {
      if (Math.abs(sumShares - totShares) < 1e-6) checks.push(`股數合計 ${fmtShares(sumShares)} 與對帳單相符`);
      else problems.push(`股數合計 ${fmtShares(sumShares)} 與對帳單的 ${fmtShares(totShares)} 不符，AI 可能漏抓或多抓`);
    }
    if (totAmount != null) {
      // Each row's 價金 is rounded on the statement: allow 1 per row
      if (Math.abs(sumAmount - totAmount) <= rows.length) checks.push(`價金合計 ${sumAmount.toLocaleString('en-US')} 與對帳單相符`);
      else problems.push(`價金合計 ${sumAmount.toLocaleString('en-US')} 與對帳單的 ${totAmount.toLocaleString('en-US')} 不符，AI 可能漏抓或多抓`);
    }

    const net = (list) => list.reduce((n, t) => n + (t.action === 'BUY' ? t.shares : -t.shares), 0);
    const slim = (t) => ({ id: t.id, date: t.date, action: t.action, shares: t.shares, price: t.price, note: t.note, history: !isCounted(t) });
    const out = [...bySymbol(rows)].sort(([a], [b]) => (a < b ? -1 : 1)).map(([sym, mineRows]) => {
      const own = mineRows.map((r) => r.date).sort();
      const sStart = pStart || own[0];
      const sEnd = pEnd || own[own.length - 1];
      const mine = db.where('stock_transactions', (t) => t.symbol === sym && t.account_id == null);
      const transfers = mine.filter((t) => t.is_transfer === 1 && t.action === 'BUY');
      const remove = mine.filter((t) => !transfers.includes(t) && t.date >= sStart && t.date <= sEnd);
      const kept = mine.filter((t) => !transfers.includes(t) && !remove.includes(t) && isCounted(t));
      const holding = db.findBy('stock_holdings', 'symbol', sym);
      const current = holding?.shares || 0;
      const before = round4(current - net(mineRows) - net(kept));

      let transfer = null;
      if (!mine.length && !holding) {
        // Not tracked in the app yet: nothing to replace or work back, the statement is all there is
        checks.push(`${sym}：App 裡原本沒有這檔，直接新增對帳單的交易`);
      } else if (before < -1e-6) {
        problems.push(`${sym}：倒推期間開始前要有 ${fmtShares(before)} 股（負數），資料兜不起來（漏抓、分割沒換算，或目前持股本來就不對）`);
      } else if (before > 1e-6) {
        const tShares = transfers.reduce((n, t) => n + t.shares, 0);
        const price = tShares > 0 ? round4(transfers.reduce((n, t) => n + t.shares * t.price, 0) / tShares) : holding?.avg_cost || 0;
        const oldest = transfers.map((t) => t.date).sort()[0];
        transfer = { date: oldest && oldest < sStart ? oldest : addDays(sStart, -1), shares: before, price };
        if (!transfers.length) checks.push(`${sym}：期間開始前的 ${fmtShares(before)} 股原本沒有匯入持倉，會以目前均價建立一筆`);
        if (!(price > 0)) problems.push(`${sym}：期間開始前有 ${fmtShares(before)} 股，但沒有成本可以沿用`);
      }
      return { symbol: sym, market: mineRows[0].market, currency: mineRows[0].currency, start: sStart, end: sEnd, current, remove: remove.map(slim), transfers: transfers.map(slim), transfer };
    });
    if (!pStart || !pEnd) checks.push('資料沒有查詢期間：每檔股票只取代它在資料裡第一筆到最後一筆之間的交易');
    return { problems, checks, symbols: out, ok: problems.length === 0 };
  },

  /**
   * A SELL needs enough shares held on its date (existing trades + earlier rows of this import).
   * Without them it can only be imported as a history sell (fixed realized_pl, no shares taken),
   * which needs the statement's P&L; otherwise it is reported as an error.
   * With a replace plan the existing trades are the ones that stay plus the new 匯入持倉.
   */
  review(res, plan) {
    const drop = new Set();
    for (const [sym, rows] of bySymbol(res.records)) {
      let old = db.where('stock_transactions', (t) => t.symbol === sym && isCounted(t));
      if (plan) {
        const p = plan.symbols.find((s) => s.symbol === sym);
        const gone = new Set([...p.remove, ...p.transfers].map((t) => t.id));
        old = old.filter((t) => !gone.has(t.id));
        if (p.transfer) old.push({ ...p.transfer, id: 0, action: 'BUY' });
      } else {
        const transfer = old.find((t) => t.is_transfer === 1 && t.action === 'BUY');
        if (transfer && rows.some((r) => r.action === 'BUY')) {
          res.warnings.push(`${sym} 已有「匯入持倉」建立的 ${fmtShares(transfer.shares)} 股（${transfer.date}）。` +
            '如果這次匯入的買進已包含這些持股，持股會重複計算：可以勾選「以對帳單取代」，或先到交易紀錄刪掉那筆匯入持倉。');
        }
      }
      // Existing rows first on the same date, then this import in order (ids only break ties)
      const all = [...old, ...rows.map((r) => ({ ...r, id: Number.MAX_SAFE_INTEGER, ref: r }))].sort(ledgerOrder);
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

  async insertAll(records, plan) {
    if (plan) {
      for (const p of plan.symbols) {
        for (const t of [...p.remove, ...p.transfers]) db.remove('stock_transactions', t.id);
        if (p.transfer) {
          db.insert('stock_transactions', {
            symbol: p.symbol, action: 'BUY', shares: p.transfer.shares, price: p.transfer.price, fee: 0, tax: 0,
            date: p.transfer.date, realized_pl: 0, is_transfer: 1, note: '匯入持倉（以對帳單取代時由目前持股倒推）',
            market: p.market, currency: p.currency,
          });
        }
      }
    }
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

// ---------------------------------------------------------------- 資產快照

const snapshots = {
  label: '資產快照',
  example: [
    { date: '2026-10-31', cash_twd: 519921, cash_usd: 325.5, note: '台新 300,000；國泰 219,921；Firstrade 美金 325.5' },
  ],
  prompt() {
    return `資產快照（asset_snapshots）規則：
- 記的是某一天「現金」的餘額（銀行存款、券商交割戶裡的現金），不含股票；股票市值 App 會用當天的股價自己算。
- 每個日期一筆：同一天有好幾個帳戶，就把台幣加總成 cash_twd、美金加總成 cash_usd，各帳戶金額寫進 note。
- date：餘額的日期 YYYY-MM-DD（對帳單或截圖上的日期）。資料沒寫日期或年份時先問我，不要猜。
- cash_twd：台幣現金合計；cash_usd：美金現金合計（填美金原幣，不要換算台幣）。沒有就填 0。
- 台幣、美金以外的幣別先問我要怎麼處理。
- note：各帳戶名稱與金額，沒有就 ""。`;
  },
  normalize(raw) {
    const date = normDate(raw.date);
    if (!date) return { error: `日期看不懂：${str(raw.date) || '（空白）'}` };
    const twd = optAmount(raw.cash_twd);
    const usd = optAmount(raw.cash_usd);
    if (Number.isNaN(twd) || Number.isNaN(usd)) return { error: `金額看不懂：${str(raw.cash_twd)} / ${str(raw.cash_usd)}` };
    if (twd == null && usd == null) return { error: '沒有現金金額' };
    if ((twd || 0) < 0 || (usd || 0) < 0) return { error: '現金不能是負數' };
    // Stock values, rate and total left at 0 for assets.js autoFill
    return { row: { date, cash_twd: twd || 0, cash_usd: usd || 0, note: str(raw.note), stock_tw_value: 0, stock_us_value: 0, stock_value_twd: 0, usd_twd_rate: 0, total_asset: 0 } };
  },
  // Each snapshot gets its date's stock value and rate (assets.js autoFill); the series is built once.
  // A past date without the series is that row's error, never today's prices.
  async prepare(res) {
    const today = db.today();
    const perf = res.records.some((r) => r.date < today) ? await performance().catch(() => null) : null;
    const kept = [];
    for (const r of res.records) {
      try {
        await autoFill(r, perf);
        kept.push(r);
      } catch (err) {
        res.errors.push({ index: r.index, error: err.message });
      }
    }
    res.records = kept;
  },
  key: (r) => [r.date, Math.round(r.cash_twd), Math.round(r.cash_usd * 100)].join('|'),
  existing: () => db.all('asset_snapshots'),
  async insertAll(records) {
    for (const { index, ...r } of records) insertSnapshot(r);
  },
};

const KINDS = { expenses, transactions, asset_snapshots: snapshots };

// ---------------------------------------------------------------- prompt

/** The prompt for the chosen kinds: format and rules only, never the user's data. */
export function buildPrompt(kinds) {
  const chosen = kinds.filter((k) => KINDS[k]);
  if (!chosen.length) throw badRequest('請至少選一種資料');
  const example = { format: IMPORT_FORMAT, version: IMPORT_VERSION };
  for (const k of chosen) {
    example[k] = KINDS[k].example;
    if (KINDS[k].summaryExample) example[`${k}_summary`] = KINDS[k].summaryExample;
  }
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

/** Rows an AI put in the wrong array (a trade among the expenses, or the reverse) go where they belong. */
function rerouteRows(sections) {
  const obj = (r) => r && typeof r === 'object';
  const isTrade = (r) => obj(r) && 'symbol' in r && 'action' in r;
  const isExpense = (r) => obj(r) && 'amount' in r && !('symbol' in r);
  const out = { ...sections };
  const move = (from, to, pred) => {
    if (!Array.isArray(out[from]) || !out[from].some(pred)) return;
    out[to] = [...(Array.isArray(out[to]) ? out[to] : []), ...out[from].filter(pred)];
    out[from] = out[from].filter((r) => !pred(r));
  };
  move('expenses', 'transactions', isTrade);
  move('transactions', 'expenses', isExpense);
  return out;
}

/**
 * Per kind: { records, duplicates, errors: [{ index, error }], warnings, plan }.
 * add mode: rows equal to an existing record (or an earlier row in the same paste) are skipped.
 * replace mode (kinds with plan()): nothing is skipped as a duplicate (the statement is the
 * record of what happened), and `plan` says what gets replaced. `plan` is filled in add mode
 * too, so the preview can offer the replace option. A bare array is read as the first kind.
 */
export async function parseImport(text, kinds = Object.keys(KINDS), mode = 'add') {
  const data = extractJson(text);
  const sections = rerouteRows(Array.isArray(data) ? { [kinds[0]]: data } : { ...data });
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
    res.plan = kind.plan?.(res, sections[`${k}_summary`]) ?? null;
    const replace = mode === 'replace' && res.plan;
    if (!replace) {
      // Counted, not a set: two identical coffees on the same day are two records. Each existing
      // record cancels one equal row of the paste, so re-importing the same file adds nothing.
      const left = new Map();
      for (const e of kind.existing()) left.set(kind.key(e), (left.get(kind.key(e)) || 0) + 1);
      res.records = res.records.filter((r) => {
        const key = kind.key(r);
        if (!left.get(key)) return true;
        left.set(key, left.get(key) - 1);
        res.duplicates++;
        return false;
      });
    }
    kind.review?.(res, replace ? res.plan : null);
    if (res.plan && res.errors.length) {
      // Replacing needs every row of the statement in
      res.plan.problems.unshift(`有 ${res.errors.length} 筆無法匯入，取代會讓這段期間的紀錄不完整`);
      res.plan.ok = false;
    }
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
  return parseImport(r.text, r.kinds, r.mode);
});

// Re-parses the same text so only validated rows are written, in one transaction.
route('POST', '/api/ai-import/commit', async (req) => {
  const r = body(req);
  const parsed = await parseImport(r.text, r.kinds, r.mode);
  const replace = r.mode === 'replace';
  for (const res of Object.values(parsed)) {
    if (replace && res.plan && !res.plan.ok) throw badRequest('無法以對帳單取代：' + res.plan.problems.join('；'));
  }
  const counts = {};
  await db.transaction(async () => {
    for (const [k, res] of Object.entries(parsed)) {
      await KINDS[k].insertAll(res.records, replace ? res.plan : null);
      counts[k] = res.records.length;
    }
  });
  return counts;
});
