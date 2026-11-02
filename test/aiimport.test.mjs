// AI import: lenient JSON extraction, 收支 and 股票交易 normalization, split conversion,
// sells without enough holdings, duplicate detection, commit.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const mem = new Map();
globalThis.window = {
  localStorage: {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
    removeItem: (k) => mem.delete(k),
  },
};

// Split-adjusted daily closes, answered like the Yahoo proxy (config.js has DEFAULT_YAHOO_PROXY).
const CLOSES = {
  '0050.TW': { '2024-10-24': 48.7, '2025-10-13': 60.0 },
  '00881.TW': { '2024-10-18': 25.0, '2024-11-14': 24.3 },
  '4128.TWO': { '2023-08-22': 48.0, '2023-09-05': 49.0 }, // 上櫃: only .TWO exists
};
globalThis.fetch = async (url) => {
  const sym = decodeURIComponent((String(url).match(/\/chart\/([^?]+)/) || [])[1] || '');
  const bars = Object.entries(CLOSES[sym] || {});
  if (!bars.length) return new Response('not found', { status: 404 });
  const ts = bars.map(([d]) => Date.parse(`${d}T01:00:00Z`) / 1000);
  return Response.json({ chart: { result: [{ meta: { gmtoffset: 28800 }, timestamp: ts, indicators: { quote: [{ close: bars.map(([, c]) => c) }] } }], error: null } });
};

const db = await import('../js/server/db.js');
const { handle } = await import('../js/server/router.js');
const { extractJson, parseImport, buildPrompt } = await import('../js/server/aiimport.js');
await import('../js/server/stocks.js'); // /api/stocks/clear

const post = (url, body) => handle(url, { method: 'POST', body: JSON.stringify(body) });

beforeEach(() => {
  mem.clear();
  db._reset({
    settings: [{ id: 1, key: 'usd_twd_rate', value: '30' }],
    expenses: [{ id: 1, date: '2026-10-01', type: 'expense', amount: 1200, currency: 'TWD', category: '飲食', note: '', created_at: '' },
               { id: 2, date: '2026-09-01', type: 'expense', amount: 500, currency: 'TWD', category: '保險', note: '', created_at: '' }],
  });
});

test('extractJson: fenced, surrounded by text, or bare', () => {
  assert.deepEqual(extractJson('好的：\n```json\n{"a":1}\n```\n以上'), { a: 1 });
  assert.deepEqual(extractJson('結果如下 {"a":[1,2]} 謝謝'), { a: [1, 2] });
  assert.deepEqual(extractJson('[{"x":1}]'), [{ x: 1 }]);
  assert.throws(() => extractJson('沒有 JSON'), /找不到 JSON/);
});

test('prompt: format only, lists preset and used categories', () => {
  const p = buildPrompt(['expenses', 'transactions']);
  assert.match(p, /"format": "finance-watcher-import"/);
  assert.match(p, /飲料/);
  assert.match(p, /保險/); // used before, so the AI may map to it
  assert.match(p, /股票交易（transactions）規則/);
  assert.throws(() => buildPrompt([]), /至少/);
});

test('expenses: lenient values, unknown category -> 其他 with note, existing duplicate skipped', async () => {
  const text = JSON.stringify({
    format: 'finance-watcher-import',
    expenses: [
      { date: '2026-10-01', type: 'expense', category: '飲食', amount: 1200 },          // duplicate of id 1
      { date: '2026/10/3', type: '支出', category: '飲料', amount: 'NT$ 1,350', note: '手搖' },
      { date: '2026-10', type: '收入', category: '薪資', amount: 118000, currency: '台幣' }, // month only -> 1st
      { date: '2026-10-04', category: '寵物', amount: -800 },                              // no type, negative
      { date: '2026/10/4', category: '寵物', amount: -800 },                               // same row again: a second record
      { date: '十月', amount: 10 },
      { date: '2026-10-05', amount: 'abc' },
      { date: '2026-10-06', category: '交通', amount: 20, currency: 'USD' },
    ],
  });
  const r = (await parseImport(text)).expenses;
  assert.equal(r.duplicates, 1);
  assert.deepEqual(r.errors.map((e) => e.index), [5, 6]);
  assert.deepEqual(r.records.map((e) => [e.date, e.type, e.category, e.amount, e.currency, e.note]), [
    ['2026-10-03', 'expense', '飲料', 1350, 'TWD', '手搖'],
    ['2026-10-01', 'income', '薪資', 118000, 'TWD', ''],
    ['2026-10-04', 'expense', '其他支出', 800, 'TWD', '原分類：寵物'],
    ['2026-10-04', 'expense', '其他支出', 800, 'TWD', '原分類：寵物'],
    ['2026-10-06', 'expense', '交通', 20, 'USD', ''],
  ]);
});

test('a bare array is read as the requested kind', async () => {
  const r = await parseImport('[{"date":"2026-10-08","type":"expense","category":"飲食","amount":90}]', ['expenses']);
  assert.equal(r.expenses.records.length, 1);
});

test('expense commit writes only new rows; a second commit adds nothing', async () => {
  const text = '```json\n{"expenses":[{"date":"2026-10-01","type":"expense","category":"飲食","amount":1200},{"date":"2026-10-02","type":"expense","category":"飲料","amount":60}]}\n```';
  assert.deepEqual(await post('/api/ai-import/commit', { text, kinds: ['expenses'] }), { expenses: 1 });
  assert.equal(db.all('expenses').length, 3);
  assert.deepEqual(await post('/api/ai-import/commit', { text, kinds: ['expenses'] }), { expenses: 0 });
});

// Shaped like the broker statement the user pasted (現買 / 現賣, YYYYMMDD, 損益金額 on the sell)
const STATEMENT = JSON.stringify({ transactions: [
  { date: '20251013', symbol: '0050', market: 'TW', action: '現買', shares: '1,000', price: 60.6, fee: 86, tax: 0, realized_pl: null, note: 'FG995' },
  { date: '2024-10-24', symbol: '0050', market: 'TW', action: 'BUY', shares: 1000, price: 195.5, fee: 278, tax: 0, note: 'FE883' },
  { date: '2024-11-14', symbol: '00881', market: 'TW', action: 'BUY', shares: 2000, price: 24.34, fee: 69, tax: 0, note: 'FF261' },
  { date: '2024-10-18', symbol: '00881', market: 'TW', action: '現賣', shares: 5000, price: 25.1, fee: 178, tax: 125, realized_pl: 42340, note: 'FB426' },
  { date: '2024-11-20', symbol: '00881', market: 'TW', action: 'SELL', shares: 9000, price: 24.5 },
  { date: '2024-11-21', symbol: '00881', market: 'TW', action: 'BUY', shares: 1000, price: 24.4 },
  { date: '2024-11-14', symbol: '00881', action: 'hold', shares: 1, price: 1 },
] });

test('transactions: symbols, YYYYMMDD, pre-split conversion, history sell, estimated fee, errors', async () => {
  const r = (await parseImport(STATEMENT)).transactions;
  const by = (note) => r.records.find((x) => x.note === note);

  assert.equal(by('FG995').symbol, '0050.TW');
  assert.equal(by('FG995').date, '2025-10-13');
  assert.equal(by('FG995').shares, 1000);
  assert.equal(by('FG995').flags.length, 0);

  // 195.5 vs a split-adjusted close of 48.7 -> 1:4 split
  assert.equal(by('FE883').shares, 4000);
  assert.equal(by('FE883').price, 48.875);
  assert.match(by('FE883').flags[0], /1→4/);

  // Sold before any buy in this import, with the statement's P&L -> history sell
  assert.equal(by('FB426').history, true);
  assert.equal(by('FB426').realized_pl, 42340);

  // No fee/tax given -> estimated (0.1425%, min 20)
  const est = r.records.find((x) => x.date === '2024-11-21');
  assert.equal(est.fee, 34);
  assert.ok(est.flags.includes('費用為估算'));

  // 9000 sold with only 2000 held and no P&L; an unknown action
  assert.deepEqual(r.errors.map((e) => e.index), [4, 6]);
  assert.match(r.errors[0].error, /持股只有 2000 股/);
  assert.equal(r.records.length, 5);
});

test('transactions commit: holdings from the ledger, history sell kept out of FIFO, re-import is all duplicates', async () => {
  assert.deepEqual(await post('/api/ai-import/commit', { text: STATEMENT, kinds: ['transactions'] }), { transactions: 5 });
  assert.equal(db.findBy('stock_holdings', 'symbol', '0050.TW').shares, 5000);
  assert.equal(db.findBy('stock_holdings', 'symbol', '00881.TW').shares, 3000);
  const sell = db.where('stock_transactions', (t) => t.note === 'FB426')[0];
  assert.equal(sell.pl_manual, 1);
  assert.equal(sell.lots_consumed, 0);
  assert.equal(sell.realized_pl, 42340);

  const again = (await parseImport(STATEMENT)).transactions;
  assert.equal(again.records.length, 0);
  assert.equal(again.duplicates, 5);
});

test('transactions: warns when a 匯入持倉 transfer BUY already holds the symbol', async () => {
  db.insert('stock_transactions', { symbol: '0050.TW', market: 'TW', action: 'BUY', shares: 3000, price: 50, currency: 'TWD', date: '2025-01-01', is_transfer: 1, note: '' });
  const r = (await parseImport(STATEMENT)).transactions;
  assert.ok(r.warnings.some((w) => w.includes('0050.TW 已有「匯入持倉」')));
});

// ---------------------------------------------------------------- 以對帳單取代

const tx = (o) => ({ market: 'TW', currency: 'TWD', fee: 0, tax: 0, realized_pl: 0, pl_manual: 0, lots_consumed: 1, is_transfer: 0, note: '', ...o });

function seedReplace() {
  db._reset({
    settings: [{ id: 1, key: 'usd_twd_rate', value: '30' }],
    stock_transactions: [
      tx({ id: 1, symbol: '00881.TW', action: 'BUY', shares: 30000, price: 22, date: '2025-01-01', is_transfer: 1, note: '匯入持倉' }),
      tx({ id: 2, symbol: '00881.TW', action: 'BUY', shares: 2000, price: 24.34, date: '2024-11-14', note: '手動記的' }),   // in the period
      tx({ id: 3, symbol: '00881.TW', action: 'BUY', shares: 1000, price: 27, date: '2025-11-05' }),                      // after it: stays
      tx({ id: 4, symbol: '2330.TW', action: 'BUY', shares: 100, price: 900, date: '2024-12-01' }),                       // other stock
    ],
    stock_holdings: [{ id: 1, symbol: '00881.TW', market: 'TW', shares: 33000, avg_cost: 22.2, currency: 'TWD', note: '' },
                     { id: 2, symbol: '2330.TW', market: 'TW', shares: 100, avg_cost: 900, currency: 'TWD', note: '' }],
  });
}

const replaceText = (summary) => JSON.stringify({
  transactions: [
    { date: '2024-10-18', symbol: '00881', market: 'TW', action: 'SELL', shares: 5000, price: 25.1, fee: 178, tax: 125, realized_pl: 42340, note: 'FB426' },
    { date: '2024-11-14', symbol: '00881', market: 'TW', action: 'BUY', shares: 2000, price: 24.34, fee: 69, tax: 0, note: 'FF261' },
    { date: '2025-09-02', symbol: '00881', market: 'TW', action: 'BUY', shares: 3000, price: 26.4, fee: 112, tax: 0, note: 'FD760' },
  ],
  transactions_summary: summary,
});
const GOOD = { period_start: '2024-10-01', period_end: '2025-10-31', total_shares: 10000, total_amount: 253380 };

test('replace plan: period, totals, rows to remove, 匯入持倉 worked back from current holdings', async () => {
  seedReplace();
  const r = (await parseImport(replaceText(GOOD), ['transactions'], 'replace')).transactions;
  const p = r.plan;
  assert.equal(p.ok, true, p.problems.join());
  assert.equal(p.start, '2024-10-01');
  assert.ok(p.checks.some((c) => c.includes('股數合計 10000 與對帳單相符')));
  assert.ok(p.checks.some((c) => c.includes('價金合計 253,380 與對帳單相符')));
  const s = p.symbols[0];
  assert.equal(s.symbol, '00881.TW');
  assert.deepEqual(s.remove.map((t) => t.id), [2]);
  assert.deepEqual(s.transfers.map((t) => t.id), [1]);
  // 33000 now − 0 net in the statement − 1000 bought after the period
  assert.deepEqual(s.transfer, { date: '2024-09-30', shares: 32000, price: 22 });
  // In replace mode nothing is a duplicate, and the 10/18 sell is covered by the new 匯入持倉
  assert.equal(r.duplicates, 0);
  assert.equal(r.records.length, 3);
  assert.equal(r.records.find((x) => x.note === 'FB426').history, undefined);
});

test('replace commit: holdings unchanged, old in-period rows gone, other stocks untouched', async () => {
  seedReplace();
  assert.deepEqual(await post('/api/ai-import/commit', { text: replaceText(GOOD), kinds: ['transactions'], mode: 'replace' }), { transactions: 3 });
  const rows = db.where('stock_transactions', (t) => t.symbol === '00881.TW').sort((a, b) => a.date.localeCompare(b.date));
  assert.deepEqual(rows.map((t) => [t.date, t.action, t.shares, t.is_transfer]), [
    ['2024-09-30', 'BUY', 32000, 1],
    ['2024-10-18', 'SELL', 5000, 0],
    ['2024-11-14', 'BUY', 2000, 0],
    ['2025-09-02', 'BUY', 3000, 0],
    ['2025-11-05', 'BUY', 1000, 0],
  ]);
  assert.equal(db.findBy('stock_holdings', 'symbol', '00881.TW').shares, 33000);
  // The sell now consumes the 匯入持倉 lots at its cost: (25.1 − 22) × 5000 − fee − tax
  assert.equal(rows[1].realized_pl, 3.1 * 5000 - 178 - 125);
  assert.equal(db.where('stock_transactions', (t) => t.symbol === '2330.TW').length, 1);
});

test('replace is blocked when the totals do not match or the holdings cannot be worked back', async () => {
  seedReplace();
  const bad = (await parseImport(replaceText({ ...GOOD, total_shares: 9000 }), ['transactions'], 'replace')).transactions.plan;
  assert.equal(bad.ok, false);
  assert.ok(bad.problems.some((x) => x.includes('股數合計 10000 與對帳單的 9000 不符')));
  await assert.rejects(post('/api/ai-import/commit', { text: replaceText({ ...GOOD, total_shares: 9000 }), kinds: ['transactions'], mode: 'replace' }), /無法以對帳單取代/);
  assert.equal(db.where('stock_transactions', (t) => t.symbol === '00881.TW').length, 3); // nothing changed

  db.update('stock_holdings', 1, { shares: 500 }); // fewer than the trades that stay
  const neg = (await parseImport(replaceText(GOOD), ['transactions'], 'replace')).transactions.plan;
  assert.ok(neg.problems.some((x) => x.includes('負數')));

  // No summary at all: allowed, with a note to check the row count yourself
  db.update('stock_holdings', 1, { shares: 33000 });
  const none = (await parseImport(replaceText(null), ['transactions'], 'replace')).transactions.plan;
  assert.equal(none.ok, true);
  assert.equal(none.start, '2024-10-18');
  assert.ok(none.checks.some((c) => c.includes('沒有合計列')));
});

test('transactions: a code Yahoo only knows as .TWO (上櫃) is renamed', async () => {
  const text = JSON.stringify({ transactions: [
    { date: '2023-08-22', symbol: '4128', market: 'TW', action: 'BUY', shares: 1000, price: 48.05, fee: 68, tax: 0 },
    { date: '2023-09-05', symbol: '4128', market: 'TW', action: 'SELL', shares: 1000, price: 49.3, fee: 70, tax: 147, realized_pl: 965 },
  ] });
  const r = (await parseImport(text)).transactions;
  assert.deepEqual(r.records.map((x) => x.symbol), ['4128.TWO', '4128.TWO']);
  assert.ok(r.warnings.some((w) => w.includes('4128 是上櫃股票')));
  assert.equal(r.records[1].history, undefined); // the buy covers the sell
});

test('identical rows in one paste are separate records; only as many as already exist are duplicates', async () => {
  // Two 30-元 drinks on the same day, and the existing 1200 飲食 on 10/01 (id 1)
  const text = JSON.stringify({ expenses: [
    { date: '2024-08-22', type: 'expense', category: '飲料', amount: 30 },
    { date: '2024-08-22', type: 'expense', category: '飲料', amount: 30 },
    { date: '2026-10-01', type: 'expense', category: '飲食', amount: 1200 },
    { date: '2026-10-01', type: 'expense', category: '飲食', amount: 1200 },
  ] });
  const r = (await parseImport(text)).expenses;
  assert.equal(r.records.length, 3);
  assert.equal(r.duplicates, 1);
  await post('/api/ai-import/commit', { text, kinds: ['expenses'] });
  const again = (await parseImport(text)).expenses;
  assert.equal(again.records.length, 0); // re-importing the same paste adds nothing
  assert.equal(again.duplicates, 4);
});

test('trades the AI put inside "expenses" are imported as trades', async () => {
  const text = JSON.stringify({ expenses: [
    { date: '2025-10-01', type: 'expense', category: '飲料', amount: 30 },
    { date: '2020-09-17', symbol: '2886', market: 'TW', action: 'BUY', shares: 1000, price: 28.6, fee: 40, tax: 0 },
  ] });
  const r = await parseImport(text, ['expenses']);
  assert.equal(r.expenses.records.length, 1);
  assert.equal(r.expenses.errors.length, 0);
  assert.equal(r.transactions.records[0].symbol, '2886.TW');
});

test('replace without a 查詢期間: each symbol uses its own first..last trade dates', async () => {
  db._reset({
    settings: [{ id: 1, key: 'usd_twd_rate', value: '30' }],
    stock_transactions: [tx({ id: 1, symbol: '00881.TW', action: 'BUY', shares: 115000, price: 15, date: '2021-01-14', is_transfer: 1 })],
    stock_holdings: [{ id: 1, symbol: '00881.TW', market: 'TW', shares: 115000, avg_cost: 15, currency: 'TWD', note: '' }],
  });
  const text = JSON.stringify({ transactions: [
    { date: '2020-09-17', symbol: '2886', market: 'TW', action: 'BUY', shares: 1000, price: 28.6, fee: 40, tax: 0 },
    { date: '2020-09-21', symbol: '2886', market: 'TW', action: 'SELL', shares: 1000, price: 28.25, fee: 40, tax: 85, realized_pl: -500 },
    { date: '2022-02-14', symbol: '00881', market: 'TW', action: 'BUY', shares: 60000, price: 17.67, fee: 50, tax: 0 },
    { date: '2025-09-02', symbol: '00881', market: 'TW', action: 'BUY', shares: 35000, price: 26.4, fee: 112, tax: 0 },
  ] });
  const p = (await parseImport(text, ['transactions'], 'replace')).transactions.plan;
  assert.equal(p.ok, true, p.problems.join());
  assert.equal(p.perSymbol, true);
  const s = p.symbols.find((x) => x.symbol === '00881.TW');
  assert.equal(s.start, '2022-02-14');
  // 115000 now − 95000 in the statement; the old 匯入持倉 date (2021) is before 00881's own first
  // trade, so it stays. With the global start (2020-08-13, from 2886) it was dragged to 2020-08-12.
  assert.deepEqual(s.transfer, { date: '2021-01-14', shares: 20000, price: 15 });
});

test('replace: a stock the app has never had is simply added, not a negative 匯入持倉', async () => {
  seedReplace();
  const text = JSON.stringify({ transactions: [
    { date: '2024-10-18', symbol: '00881', market: 'TW', action: 'SELL', shares: 5000, price: 25.1, fee: 178, tax: 125, realized_pl: 42340 },
    { date: '2024-11-14', symbol: '00881', market: 'TW', action: 'BUY', shares: 2000, price: 24.34, fee: 69, tax: 0 },
    { date: '2025-09-02', symbol: '00881', market: 'TW', action: 'BUY', shares: 3000, price: 26.4, fee: 112, tax: 0 },
    { date: '2022-04-25', symbol: '0056', market: 'TW', action: 'BUY', shares: 5000, price: 32.09, fee: 45, tax: 0 },
  ] });
  const p = (await parseImport(text, ['transactions'], 'replace')).transactions.plan;
  assert.equal(p.ok, true, p.problems.join());
  assert.ok(p.checks.some((c) => c.includes('0056.TW：App 裡原本沒有這檔')));
  assert.equal(p.symbols.find((s) => s.symbol === '0056.TW').transfer, null);
  await post('/api/ai-import/commit', { text, kinds: ['transactions'], mode: 'replace' });
  assert.equal(db.findBy('stock_holdings', 'symbol', '0056.TW').shares, 5000);
  assert.equal(db.findBy('stock_holdings', 'symbol', '00881.TW').shares, 33000);
});

test('clear stock data: one market of the self account only; dry run only counts', async () => {
  seedReplace(); // 00881.TW ×3 + 2330.TW, both TW holdings
  db.insert('stock_transactions', tx({ symbol: 'NVDA', market: 'US', currency: 'USD', action: 'BUY', shares: 10, price: 100, date: '2025-01-01' }));
  db.insert('stock_holdings', { symbol: 'NVDA', market: 'US', shares: 10, avg_cost: 100, currency: 'USD' });
  db.insert('stock_transactions', tx({ symbol: '2330.TW', action: 'BUY', shares: 1, price: 900, date: '2025-01-01', account_id: 7 })); // managed
  db.insert('dividends', { symbol: '00881.TW', amount: 1000, date: '2025-01-20' });
  db.insert('expenses', { date: '2025-01-01', type: 'expense', amount: 50, category: '飲料' });

  assert.deepEqual(await post('/api/stocks/clear', { market: 'TW', dry: true }), { transactions: 4, holdings: 2 });
  assert.equal(db.where('stock_transactions', (t) => t.account_id == null).length, 5); // dry: nothing gone
  assert.deepEqual(await post('/api/stocks/clear', { market: 'TW' }), { transactions: 4, holdings: 2 });

  assert.deepEqual(db.where('stock_transactions', (t) => t.account_id == null).map((t) => t.symbol), ['NVDA']);
  assert.deepEqual(db.all('stock_holdings').map((h) => h.symbol), ['NVDA']);
  assert.equal(db.where('stock_transactions', (t) => t.account_id === 7).length, 1);
  assert.equal(db.all('dividends').length, 1);
  assert.equal(db.all('expenses').length, 1);
  await assert.rejects(post('/api/stocks/clear', {}), /market/);
});
