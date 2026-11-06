import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as db from '../js/server/db.js';
import { BACKUP_GROUPS, buildBackup } from '../js/server/settings.js';

test('backup groups: every synced table in exactly one group', () => {
  const tables = BACKUP_GROUPS.flatMap((g) => g.tables);
  assert.deepEqual([...tables].sort(), [...db.SYNCED_TABLES].sort());
  assert.equal(new Set(tables).size, tables.length);
});

test('buildBackup: all by default, only the chosen groups otherwise', async () => {
  db._reset({ expenses: [{ id: 1, type: 'expense', amount: 10, currency: 'TWD', category: '餐飲', date: '2026-01-01' }] });
  assert.deepEqual(Object.keys(buildBackup().tables).sort(), [...db.SYNCED_TABLES].sort());
  const part = buildBackup(['expenses', 'stocks']);
  assert.deepEqual(Object.keys(part.tables).sort(), ['expenses', 'stock_holdings', 'stock_transactions']);
  assert.equal(part.tables.expenses.length, 1);
  const { handle } = await import('../js/server/router.js');
  const file = await handle('/api/settings/backup?groups=expenses');
  assert.match(file.filename, /^finance-watcher-expenses-/);
  await assert.rejects(handle('/api/settings/backup?groups=nope'), /沒有選任何資料/);
});
