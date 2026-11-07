import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as db from '../js/server/db.js';
import { parseImport } from '../js/server/aiimport.js';

test('AI import 資產快照: cash per date, no trades → cash only; duplicates skipped; bad rows reported', async () => {
  db._reset({ asset_snapshots: [{ id: 1, date: '2025-06-30', cash_twd: 100000, cash_usd: 0, note: '' }] });
  const text = JSON.stringify({ asset_snapshots: [
    { date: '2025/12/31', cash_twd: 'NT$ 519,921', cash_usd: 325.5, note: '台新、國泰' },
    { date: '2025-06-30', cash_twd: 100000, cash_usd: 0 }, // already there
    { date: '2025-13-01', cash_twd: 1 },
    { date: '2025-11-30' },
  ] });
  const { asset_snapshots: r } = await parseImport(text, ['asset_snapshots']);
  assert.equal(r.records.length, 1);
  const s = r.records[0];
  assert.equal(s.date, '2025-12-31');
  assert.equal(s.cash_twd, 519921);
  assert.equal(s.stock_value_twd, 0);
  assert.equal(s.total_asset, 519921 + 325.5 * s.usd_twd_rate);
  assert.equal(r.duplicates, 1);
  assert.deepEqual(r.errors.map((e) => e.index), [2, 3]);
});

test('marketOn: that day’s stock values and rate from the performance series', async () => {
  const { marketOn } = await import('../js/server/assets.js');
  const perf = { series: { dates: ['2025-01-01', '2025-01-02', '2025-01-05'], value: { TW: [100, 110, 120], US: [50, 55, 60] }, fx: [32, 32.5, 33] } };
  assert.deepEqual(marketOn('2025-01-04', perf), [110, 55, 32.5]); // weekend: the last day on or before
  assert.deepEqual(marketOn('2024-12-31', perf), [0, 0, 32]); // before the first trade
  assert.deepEqual(marketOn('2025-01-04', {}).slice(0, 2), [0, 0]); // no trades at all
});
