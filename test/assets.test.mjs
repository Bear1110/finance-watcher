import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as db from '../js/server/db.js';
import { carriedCash } from '../js/server/assets.js';

const snap = (o) => ({ cash_twd: 0, cash_usd: 0, total_asset: 0, note: '', ...o });
const tx = (o) => ({ market: 'TW', currency: 'TWD', fee: 0, tax: 0, is_transfer: 0, account_id: null, created_at: '', ...o });

test('carriedCash: null without snapshots', () => {
  db._reset({});
  assert.equal(carriedCash(), null);
});

test('carriedCash: later own trades and dividends move cash, per currency', () => {
  db._reset({
    asset_snapshots: [
      snap({ id: 1, date: '2026-10-01', cash_twd: 1, created_at: '2026-10-01 09:00:00' }),
      snap({ id: 2, date: '2026-11-01', cash_twd: 1_000_000, cash_usd: 5000, created_at: '2026-11-01 12:00:00' }),
    ],
    stock_transactions: [
      tx({ id: 1, action: 'BUY', shares: 1000, price: 200, fee: 285, date: '2026-11-03' }),
      tx({ id: 2, action: 'SELL', shares: 100, price: 500, fee: 71, tax: 150, date: '2026-11-04' }),
      tx({ id: 3, market: 'US', currency: 'USD', action: 'BUY', shares: 10, price: 100, fee: 1, date: '2026-11-02' }),
      // same day: entered after the snapshot counts, before it doesn't
      tx({ id: 4, action: 'BUY', shares: 1, price: 1000, date: '2026-11-01', created_at: '2026-11-01 13:00:00' }),
      tx({ id: 5, action: 'BUY', shares: 1, price: 7777, date: '2026-11-01', created_at: '2026-11-01 11:00:00' }),
      // before the snapshot, an imported position, a managed account: no cash moved
      tx({ id: 6, action: 'BUY', shares: 1, price: 9999, date: '2026-10-15' }),
      tx({ id: 7, action: 'BUY', shares: 1000, price: 500, date: '2026-11-05', is_transfer: 1 }),
      tx({ id: 8, action: 'BUY', shares: 1000, price: 500, date: '2026-11-05', account_id: 3 }),
    ],
    dividends: [
      { id: 1, symbol: '0056.TW', currency: 'TWD', amount: 12000, withheld: 0, date: '2026-11-05', created_at: '' },
      { id: 2, symbol: 'VOO', currency: 'USD', amount: 7, withheld: 3, date: '2026-11-05', created_at: '' },
      { id: 3, symbol: '0056.TW', currency: 'TWD', amount: 500, withheld: 0, date: '2026-10-20', created_at: '' },
    ],
  });
  const c = carriedCash();
  const movedTwd = -200_285 + (50_000 - 71 - 150) - 1000 + 12_000;
  assert.deepEqual(c, {
    date: '2026-11-01', trades: 4, dividends: 2,
    moved_twd: movedTwd, moved_usd: -1001 + 7,
    twd: 1_000_000 + movedTwd, usd: 5000 - 1001 + 7,
  });
});

test('snapshots: 其他資產 recorded at creation, kept on edit, counted in net_worth unless turned off', async () => {
  const { handle } = await import('../js/server/router.js');
  await import('../js/server/other_assets.js');
  db._reset({ settings: [{ id: 1, key: 'usd_twd_rate', value: '30' }] });
  await handle('/api/other-assets', { method: 'POST', body: JSON.stringify({ name: '自住房', value: 3_000_000 }) });
  const make = { date: '2026-11-01', cash_twd: 1_000_000, cash_usd: 0, stock_tw_value: 4_000_000, stock_us_value: 0, stock_value_twd: 4_000_000, usd_twd_rate: 30 };
  const { id } = await handle('/api/assets', { method: 'POST', body: JSON.stringify(make) });
  let [s] = await handle('/api/assets');
  assert.equal(s.other_assets, 3_000_000);
  assert.equal(s.net_worth, 8_000_000);
  await handle(`/api/assets/${id}`, { method: 'PUT', body: JSON.stringify({ ...make, note: 'x' }) });
  [s] = await handle('/api/assets');
  assert.equal(s.other_assets, 3_000_000);
  db.setSetting('include_other_assets', '0');
  [s] = await handle('/api/assets');
  assert.equal(s.net_worth, 5_000_000);
  await assert.rejects(handle('/api/other-assets', { method: 'POST', body: JSON.stringify({ name: '', value: 1 }) }), /請填名稱/);
});
