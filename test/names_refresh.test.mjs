// 股票名稱的快取：Worker 沒回的台股代號（一次太多、證交所頁面一時讀不到）不記成「沒有名稱」，下次再查。
import { test } from 'node:test';
import assert from 'node:assert/strict';

const mem = new Map();
globalThis.window = { localStorage: { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) } };
const db = await import('../js/server/db.js');
const { refreshNames, allNames } = await import('../js/server/names.js');

test('refreshNames: only codes in the Worker reply are cached; "" = no such code', async (t) => {
  db._reset({});
  const realFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = realFetch; });
  let asked = [];
  globalThis.fetch = async (url) => {
    asked = new URL(url).searchParams.get('codes').split(',');
    return new Response(JSON.stringify({ 2330: '台積電', 9999: '' })); // 6488 left out (cap / read error)
  };
  await refreshNames(['2330.TW', '9999.TW', '6488.TWO']);
  assert.deepEqual(allNames(), { '2330.TW': '台積電' });
  assert.equal(db.findBy('stock_names', 'symbol', '9999.TW').name, ''); // cached as "no name" for a day
  assert.equal(db.findBy('stock_names', 'symbol', '6488.TWO'), null);
  await refreshNames(['2330.TW', '9999.TW', '6488.TWO']);
  assert.deepEqual(asked, ['6488']); // asked again right away; the others wait (cached)
});
