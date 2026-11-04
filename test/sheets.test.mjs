// Spreadsheet.writeTables: rows are overwritten, then only the old tail is cleared — never a range
// past the rows that held data (the API rejects ranges beyond the grid, and a tab that grew to
// exactly its row count has nothing after the last row).

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { Spreadsheet, SHEET_IDS } from '../js/cloud/sheets.js';
import { SYNCED_TABLES } from '../js/server/db.js';

const header = ['id', 'type', 'amount', 'currency', 'category', 'date', 'note', 'created_at'];
const row = (id) => [id, 'expense', 100, 'TWD', '飲食', '2026-01-01', '', ''];

const realFetch = globalThis.fetch;
after(() => { globalThis.fetch = realFetch; });

/** A fake Sheets API: the expenses tab holds `sheetRows` data rows; records every call. */
function fakeSheets(sheetRows) {
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ url: String(url), body });
    if (String(url).includes('values:batchGet')) {
      return Response.json({ valueRanges: SYNCED_TABLES.map((t) => ({ values: t === 'expenses' ? [header, ...Array.from({ length: sheetRows }, (_, i) => row(i + 1))] : [] })) });
    }
    return Response.json({});
  };
  return calls;
}

const titles = Object.fromEntries(SYNCED_TABLES.map((t) => [SHEET_IDS[t], t]));
const records = (n) => Array.from({ length: n }, (_, i) => ({ id: i + 1, type: 'expense', amount: 100, currency: 'TWD', category: '飲食', date: '2026-01-01' }));
const clearsOf = (calls) => calls.filter((c) => c.url.includes('values:batchClear')).flatMap((c) => c.body.ranges);

test('fewer rows than before: only the old tail rows are cleared', async () => {
  const calls = fakeSheets(5);
  const s = new Spreadsheet('sheet', titles);
  await s.readAll('token');
  await s.writeTables('token', { expenses: records(2) });
  // header + 2 rows written; rows 4–6 held the old 3rd–5th records
  assert.deepEqual(clearsOf(calls), ["'expenses'!4:6"]);
});

test('same or more rows (a tab already at its grid size): nothing to clear, no out-of-grid range', async () => {
  for (const n of [5, 8]) {
    const calls = fakeSheets(5);
    const s = new Spreadsheet('sheet', titles);
    await s.readAll('token');
    await s.writeTables('token', { expenses: records(n) });
    assert.deepEqual(clearsOf(calls), []);
  }
});
