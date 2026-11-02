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

test('expenses: lenient values, unknown category -> 其他 with note, duplicates skipped', async () => {
  const text = JSON.stringify({
    format: 'finance-watcher-import',
    expenses: [
      { date: '2026-10-01', type: 'expense', category: '飲食', amount: 1200 },          // duplicate of id 1
      { date: '2026/10/3', type: '支出', category: '飲料', amount: 'NT$ 1,350', note: '手搖' },
      { date: '2026-10', type: '收入', category: '薪資', amount: 118000, currency: '台幣' }, // month only -> 1st
      { date: '2026-10-04', category: '寵物', amount: -800 },                              // no type, negative
      { date: '2026/10/4', category: '寵物', amount: -800 },                               // same row again
      { date: '十月', amount: 10 },
      { date: '2026-10-05', amount: 'abc' },
      { date: '2026-10-06', category: '交通', amount: 20, currency: 'USD' },
    ],
  });
  const r = (await parseImport(text)).expenses;
  assert.equal(r.duplicates, 2);
  assert.deepEqual(r.errors.map((e) => e.index), [5, 6]);
  assert.deepEqual(r.records.map((e) => [e.date, e.type, e.category, e.amount, e.currency, e.note]), [
    ['2026-10-03', 'expense', '飲料', 1350, 'TWD', '手搖'],
    ['2026-10-01', 'income', '薪資', 118000, 'TWD', ''],
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
