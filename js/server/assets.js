// Net-worth snapshots.

import * as db from './db.js';
import { route } from './router.js';
import { body, refreshAndPersistRate, cmp } from './util.js';
import { portfolioValues } from './stocks.js';

const FIELDS = ['cash_twd', 'cash_usd', 'stock_tw_value', 'stock_us_value', 'stock_value_twd', 'usd_twd_rate', 'total_asset'];

const assetJSON = (s) => ({
  id: s.id, date: s.date, cash_twd: s.cash_twd, cash_usd: s.cash_usd,
  stock_tw_value: s.stock_tw_value, stock_us_value: s.stock_us_value, stock_value_twd: s.stock_value_twd,
  usd_twd_rate: s.usd_twd_rate, total_asset: s.total_asset, note: s.note, created_at: s.created_at,
});

function decode(req) {
  const b = body(req);
  const s = { date: b.date ? String(b.date) : '', note: b.note == null ? '' : String(b.note) };
  for (const f of FIELDS) s[f] = Number(b[f]) || 0;
  return s;
}

/** Fill whatever the client left at 0: live rate, live stock values, total. */
async function autoFill(s) {
  // Refresh and persist so the snapshot freezes the live rate
  if (s.usd_twd_rate === 0) s.usd_twd_rate = await refreshAndPersistRate();
  if (s.stock_value_twd === 0) {
    [s.stock_tw_value, s.stock_us_value, s.stock_value_twd] = await portfolioValues();
  }
  if (s.total_asset === 0) s.total_asset = s.cash_twd + s.cash_usd * s.usd_twd_rate + s.stock_value_twd;
}

function list() {
  return db.all('asset_snapshots')
    .sort((a, b) => cmp(b.date, a.date) || cmp(b.created_at, a.created_at))
    .map(assetJSON);
}

async function create(req) {
  const s = decode(req);
  if (!s.date) s.date = db.today();
  await autoFill(s);
  const row = db.insert('asset_snapshots', s);
  return { ...assetJSON(s), id: row.id, created_at: '' };
}

async function update(req) {
  const s = decode(req);
  await autoFill(s);
  db.update('asset_snapshots', req.params.id, s);
  return { status: 'updated' };
}

route('GET', '/api/assets', list);
route('POST', '/api/assets', create);
route('PUT', '/api/assets/{id}', update);
route('DELETE', '/api/assets/{id}', (req) => { db.remove('asset_snapshots', req.params.id); return { status: 'deleted' }; });
