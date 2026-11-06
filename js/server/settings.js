// Settings, USD/TWD refresh and backup. The backup is a JSON dump of the
// synced tables; the importer reads the same format.

import * as db from './db.js';
import { route } from './router.js';
import { fetchUSDTWDRate } from './market.js';
import { HttpError, badRequest, body, download, fmtLocal, persistRate, storedUSDTWDRate } from './util.js';

export const BACKUP_FORMAT = 'finance-watcher-backup';
export const BACKUP_VERSION = 1;

/** Everything the user owns, in the format the importer accepts. */
export function buildBackup() {
  const tables = {};
  for (const name of db.SYNCED_TABLES) tables[name] = db.all(name);
  return { format: BACKUP_FORMAT, version: BACKUP_VERSION, exported_at: new Date().toISOString(), tables };
}

function getSettings() {
  const s = db.allSettings();
  s.db_path = '瀏覽器（localStorage）';
  s.db_size = `${(db.storedBytes() / 1024 / 1024).toFixed(2)} MB`;
  return s;
}

function backup() {
  const stamp = fmtLocal(new Date()).replace(/[-:]/g, '').replace(' ', '-');
  return download(`finance-watcher-backup-${stamp}.json`, JSON.stringify(buildBackup(), null, 2), 'application/json');
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
