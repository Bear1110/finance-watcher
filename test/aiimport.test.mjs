// AI import: lenient JSON extraction, 收支 normalization, duplicate detection, commit.

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

const db = await import('../js/server/db.js');
const { handle } = await import('../js/server/router.js');
const { extractJson, parseImport, buildPrompt } = await import('../js/server/aiimport.js');

const post = (url, body) => handle(url, { method: 'POST', body: JSON.stringify(body) });

beforeEach(() => {
  mem.clear();
  db._reset({
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
  const p = buildPrompt(['expenses']);
  assert.match(p, /"format": "finance-watcher-import"/);
  assert.match(p, /飲料/);
  assert.match(p, /保險/); // used before, so the AI may map to it
  assert.throws(() => buildPrompt([]), /至少/);
});

test('expenses: lenient values, unknown category -> 其他 with note, duplicates skipped', () => {
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
  const r = parseImport(text).expenses;
  assert.equal(r.duplicates, 2);
  assert.deepEqual(r.errors.map((e) => e.index), [5, 6]);
  const byNote = r.records.map((e) => [e.date, e.type, e.category, e.amount, e.currency, e.note]);
  assert.deepEqual(byNote, [
    ['2026-10-03', 'expense', '飲料', 1350, 'TWD', '手搖'],
    ['2026-10-01', 'income', '薪資', 118000, 'TWD', ''],
    ['2026-10-04', 'expense', '其他支出', 800, 'TWD', '原分類：寵物'],
    ['2026-10-06', 'expense', '交通', 20, 'USD', ''],
  ]);
});

test('a bare array is read as the requested kind', () => {
  const r = parseImport('[{"date":"2026-10-08","type":"expense","category":"飲食","amount":90}]', ['expenses']);
  assert.equal(r.expenses.records.length, 1);
});

test('commit writes only new rows; a second commit adds nothing', async () => {
  const text = '```json\n{"expenses":[{"date":"2026-10-01","type":"expense","category":"飲食","amount":1200},{"date":"2026-10-02","type":"expense","category":"飲料","amount":60}]}\n```';
  assert.deepEqual(await post('/api/ai-import/commit', { text, kinds: ['expenses'] }), { expenses: 1 });
  assert.equal(db.all('expenses').length, 3);
  assert.deepEqual(await post('/api/ai-import/commit', { text, kinds: ['expenses'] }), { expenses: 0 });
  assert.equal(db.all('expenses').length, 3);
});
