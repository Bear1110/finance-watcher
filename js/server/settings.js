// Settings, USD/TWD refresh and backup. The backup is a JSON dump of the
// synced tables; the importer reads the same format.

import * as db from './db.js';
import { route } from './router.js';
import { fetchUSDTWDRate } from './market.js';
import { HttpError, badRequest, body, download, fmtLocal, persistRate, storedUSDTWDRate } from './util.js';

export const BACKUP_FORMAT = 'finance-watcher-backup';
export const BACKUP_VERSION = 1;

/**
 * What a backup can hold, in the groups people pick from. Tables that only make sense together
 * stay together (holdings are derived from trades; a managed account owns its snapshots and cash).
 */
export const BACKUP_GROUPS = [
  { key: 'assets', label: '資產快照', tables: ['asset_snapshots'] },
  { key: 'stocks', label: '股票交易與持倉', tables: ['stock_transactions', 'stock_holdings'] },
  { key: 'dividends', label: '股利', tables: ['dividends'] },
  { key: 'expenses', label: '收支', tables: ['expenses'] },
  { key: 'other_assets', label: '其他資產', tables: ['other_assets'] },
  { key: 'managed', label: '代管帳戶', tables: ['managed_accounts', 'managed_snapshots', 'managed_cash_movements'] },
  { key: 'settings', label: '設定', tables: ['settings'] },
];

/** The chosen groups (default: all) in the format the importer accepts. */
export function buildBackup(keys = BACKUP_GROUPS.map((g) => g.key)) {
  const tables = {};
  for (const g of BACKUP_GROUPS) {
    if (keys.includes(g.key)) for (const name of g.tables) tables[name] = db.all(name);
  }
  return { format: BACKUP_FORMAT, version: BACKUP_VERSION, exported_at: new Date().toISOString(), tables };
}

function getSettings() {
  const s = db.allSettings();
  s.db_path = '瀏覽器（localStorage）';
  s.db_size = `${(db.storedBytes() / 1024 / 1024).toFixed(2)} MB`;
  return s;
}

// ?groups=expenses,stocks (default: everything). A partial file is named after what it holds.
function backup({ query }) {
  const all = BACKUP_GROUPS.map((g) => g.key);
  const raw = query.get('groups');
  const keys = raw ? raw.split(',').filter((k) => all.includes(k)) : all;
  if (!keys.length) throw badRequest('沒有選任何資料');
  const stamp = fmtLocal(new Date()).replace(/[-:]/g, '').replace(' ', '-');
  const name = keys.length === all.length ? 'backup' : keys.join('-');
  return download(`finance-watcher-${name}-${stamp}.json`, JSON.stringify(buildBackup(keys), null, 2));
}

async function refreshRate() {
  let r;
  try {
    r = await fetchUSDTWDRate();
  } catch (e) {
    throw new HttpError(502, 'fetch forex: ' + e.message);
  }
  const previous = storedUSDTWDRate();
  return { usd_twd_rate: r.rate, usd_twd_rate_updated_at: persistRate(r.rate, r.at), previous };
}

function updateSettings(req) {
  const s = body(req);
  if (s === null || typeof s !== 'object' || Array.isArray(s)) throw badRequest('invalid JSON: expected object');
  for (const [k, v] of Object.entries(s)) {
    // Values are stored as strings, but the settings form sends usd_twd_rate as a number
    if (v !== null && typeof v === 'object') throw badRequest(`invalid JSON: value of ${k} must be a string`);
    db.setSetting(k, v == null ? '' : String(v));
  }
  return { status: 'updated' };
}

route('GET', '/api/settings', getSettings);
route('PUT', '/api/settings', updateSettings);
route('GET', '/api/settings/backup', backup);
route('POST', '/api/settings/refresh-rate', refreshRate);
