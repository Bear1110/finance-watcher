// In-memory tables backed by localStorage.
//
// Every table lives in memory as an array of plain row objects and is saved to
// localStorage after each change. Tables marked `synced` are mirrored to one tab
// each in the user's Google Sheet (see js/cloud/sync.js); the others are local
// caches. Every change to a synced row is recorded in `pending` so the sync can
// merge this device's edits onto whatever the sheet currently holds.

const STORAGE_KEY = 'fw.db.v1';
const PENDING_KEY = 'fw.pending.v1';
const CACHE_KEY = 'fw.cache.v1';

// Column types: int, real, text, nint (nullable int). `key` names the field
// that identifies a row across devices (default 'id').
export const SCHEMA = {
  asset_snapshots: {
    synced: true,
    columns: { id: 'int', date: 'text', cash_twd: 'real', cash_usd: 'real', stock_tw_value: 'real', stock_us_value: 'real', stock_value_twd: 'real', usd_twd_rate: 'real', total_asset: 'real', income: 'real', expense: 'real', note: 'text', created_at: 'text' },
    defaults: { usd_twd_rate: 32 },
  },
  stock_holdings: {
    synced: true, key: 'symbol',
    columns: { id: 'int', symbol: 'text', market: 'text', shares: 'real', avg_cost: 'real', currency: 'text', note: 'text' },
    defaults: { market: 'US', currency: 'USD' },
  },
  stock_transactions: {
    synced: true,
    columns: { id: 'int', symbol: 'text', market: 'text', action: 'text', shares: 'real', price: 'real', fee: 'real', tax: 'real', currency: 'text', date: 'text', realized_pl: 'real', pl_manual: 'int', lots_consumed: 'int', is_transfer: 'int', account_id: 'nint', note: 'text', created_at: 'text' },
    defaults: { market: 'US', currency: 'USD', lots_consumed: 1, account_id: null },
  },
  dividends: {
    synced: true,
    columns: { id: 'int', symbol: 'text', market: 'text', currency: 'text', amount: 'real', withheld: 'real', date: 'text', ex_date: 'text', note: 'text', created_at: 'text' },
    defaults: { market: 'TW', currency: 'TWD' },
  },
  expenses: {
    synced: true,
    columns: { id: 'int', type: 'text', amount: 'real', currency: 'text', fx_rate: 'real', category: 'text', date: 'text', note: 'text', created_at: 'text' },
    defaults: { type: 'expense', currency: 'TWD' },
  },
  budgets: {
    synced: true, key: (r) => `${r.year}-${r.month}`,
    columns: { id: 'int', year: 'int', month: 'int', planned_income: 'real', planned_expense: 'real' },
    defaults: {},
  },
  managed_accounts: {
    synced: true,
    columns: { id: 'int', name: 'text', cash_twd: 'real', cash_usd: 'real', note: 'text', created_at: 'text' },
    defaults: {},
  },
  managed_snapshots: {
    synced: true,
    columns: { id: 'int', account_id: 'int', date: 'text', cash_twd: 'real', cash_usd: 'real', cash_total_twd: 'real', stock_tw_value_twd: 'real', stock_us_value_twd: 'real', stock_value_twd: 'real', cost_twd: 'real', unrealized_pl_twd: 'real', realized_pl_twd: 'real', total_value_twd: 'real', usd_twd_rate: 'real', detail_json: 'text', note: 'text', created_at: 'text' },
    defaults: { usd_twd_rate: 32, detail_json: '[]' },
  },
  managed_cash_movements: {
    synced: true,
    columns: { id: 'int', account_id: 'int', type: 'text', currency: 'text', amount: 'real', date: 'text', note: 'text', created_at: 'text' },
    defaults: {},
  },
  settings: {
    synced: true, key: 'key',
    columns: { id: 'int', key: 'text', value: 'text' },
    defaults: {},
  },
  // Local caches of Yahoo daily closes (see services port in market.js / priceHistory.js)
  price_history: {
    synced: false, key: (r) => `${r.symbol}|${r.date}`,
    columns: { symbol: 'text', date: 'text', close: 'real', adj_close: 'real' },
    defaults: {},
  },
  price_history_sync: {
    synced: false, key: 'symbol',
    columns: { symbol: 'text', from_date: 'text', synced_at: 'text' },
    defaults: {},
  },
};

// Settings that never leave this device (secrets, per-device choices).
export const LOCAL_SETTINGS = new Set(['gemini_api_key', 'yahoo_proxy_url']);
const LOCAL_SETTINGS_KEY = 'fw.localSettings.v1';

// Values reported for settings nobody has saved yet.
const SETTING_DEFAULTS = { usd_twd_rate: '32.0' };

export const SYNCED_TABLES = Object.keys(SCHEMA).filter((t) => SCHEMA[t].synced);

let tables = {};
let pending = {}; // table -> { up: Set(key), del: Set(key) }
const listeners = new Set();
let localSettingsCache = null;

function storage() {
  try { return window.localStorage; } catch { return null; }
}

export function rowKey(table, row) {
  const k = SCHEMA[table].key || 'id';
  return typeof k === 'function' ? k(row) : String(row[k]);
}

export function nowSQL() {
  // 'YYYY-MM-DD HH:MM:SS', UTC
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

/** Local calendar date 'YYYY-MM-DD' (today by default). */
export function today(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Coerce a value to a column type, applying the table default for missing values. */
export function coerce(type, v, def) {
  if (v === undefined || v === null || v === '') {
    if (def !== undefined) return def;
    if (type === 'nint') return null;
    if (type === 'text') return '';
    return 0;
  }
  switch (type) {
    case 'int': case 'nint': {
      if (typeof v === 'boolean') return v ? 1 : 0;
      const n = Math.trunc(Number(v));
      return Number.isFinite(n) ? n : (type === 'nint' ? null : 0);
    }
    case 'real': {
      const n = Number(v);
      return Number.isFinite(n) ? n : 0;
    }
    default:
      return String(v);
  }
}

export function normalizeRow(table, row) {
  const s = SCHEMA[table];
  const out = {};
  for (const [col, type] of Object.entries(s.columns)) {
    out[col] = coerce(type, row[col], s.defaults[col]);
  }
  return out;
}

function emptyTables() {
  const t = {};
  for (const name of Object.keys(SCHEMA)) t[name] = [];
  return t;
}

// ---------------------------------------------------------------- load / save

export function load() {
  tables = emptyTables();
  pending = {};
  const ls = storage();
  if (!ls) return;
  try {
    const data = JSON.parse(ls.getItem(STORAGE_KEY) || '{}');
    const cache = JSON.parse(ls.getItem(CACHE_KEY) || '{}');
    for (const name of Object.keys(SCHEMA)) {
      const src = SCHEMA[name].synced ? data[name] : cache[name];
      if (Array.isArray(src)) tables[name] = src;
    }
    const p = JSON.parse(ls.getItem(PENDING_KEY) || '{}');
    for (const [name, v] of Object.entries(p)) {
      pending[name] = { up: new Set(v.up || []), del: new Set(v.del || []) };
    }
  } catch (e) {
    console.error('db load failed', e);
  }
}

// Only the blobs that changed are rewritten: the price cache can be megabytes.
const dirty = new Set(); // 'data' | 'cache' | 'pending'
let saveTimer = null;
function scheduleSave(...what) {
  for (const w of what) dirty.add(w);
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; saveNow(); }, 50);
}

function tablesWhere(synced) {
  const out = {};
  for (const name of Object.keys(SCHEMA)) if (SCHEMA[name].synced === synced) out[name] = tables[name];
  return out;
}

export function saveNow() {
  const ls = storage();
  if (!ls) return;
  try {
    if (dirty.has('data')) ls.setItem(STORAGE_KEY, JSON.stringify(tablesWhere(true)));
    if (dirty.has('pending')) {
      const p = {};
      for (const [name, v] of Object.entries(pending)) {
        if (v.up.size || v.del.size) p[name] = { up: [...v.up], del: [...v.del] };
      }
      ls.setItem(PENDING_KEY, JSON.stringify(p));
    }
  } catch (e) {
    console.error('db save failed', e);
  }
  if (dirty.has('cache')) {
    try {
      ls.setItem(CACHE_KEY, JSON.stringify(tablesWhere(false)));
    } catch {
      // Price cache is rebuildable; drop it rather than fail.
      try { ls.removeItem(CACHE_KEY); } catch { /* ignore */ }
    }
  }
  dirty.clear();
}

/** Approximate bytes this device's records take in localStorage (UTF-16). */
export function storedBytes() {
  try { return (storage()?.getItem(STORAGE_KEY)?.length ?? 0) * 2; } catch { return 0; }
}

// Listeners hear about each changed table once per task, not once per row.
const changedTables = new Set();
function notify(table) {
  if (!changedTables.size) {
    queueMicrotask(() => {
      const names = [...changedTables];
      changedTables.clear();
      for (const t of names) for (const fn of listeners) fn(t);
    });
  }
  changedTables.add(table);
}

function markChanged(table, key, deleted) {
  // Local caches (price history) change thousands of rows at a time and are
  // nobody's business but this device's.
  if (!SCHEMA[table].synced) { scheduleSave('cache'); return; }
  scheduleSave('data', 'pending');
  const p = (pending[table] ||= { up: new Set(), del: new Set() });
  if (deleted) { p.up.delete(key); p.del.add(key); } else { p.del.delete(key); p.up.add(key); }
  notify(table);
}

/** Subscribe to local changes (used by the sync scheduler). */
export function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// ---------------------------------------------------------------- queries

/** All rows of a table (shallow copies, safe to mutate). */
export function all(table) {
  return tables[table].map((r) => ({ ...r }));
}

/** Rows matching a predicate (copies). */
export function where(table, pred) {
  return tables[table].filter(pred).map((r) => ({ ...r }));
}

export function get(table, id) {
  const n = Number(id);
  const r = tables[table].find((x) => x.id === n);
  return r ? { ...r } : null;
}

export function findBy(table, field, value) {
  const r = tables[table].find((x) => x[field] === value);
  return r ? { ...r } : null;
}

function nextId(table) {
  // Time-based so two devices adding rows offline do not collide; always above
  // the current max so imported small integer ids keep sorting first.
  let max = 0;
  for (const r of tables[table]) if (r.id > max) max = r.id;
  const t = Date.now() * 10 + Math.floor(Math.random() * 10);
  return Math.max(max + 1, t);
}

/** Insert a row; fills id/created_at/defaults. Returns the stored copy. */
export function insert(table, row) {
  const s = SCHEMA[table];
  const r = normalizeRow(table, row);
  if ('id' in s.columns && !row.id) r.id = nextId(table);
  if ('created_at' in s.columns && !row.created_at) r.created_at = nowSQL();
  tables[table].push(r);
  markChanged(table, rowKey(table, r), false);
  return { ...r };
}

/** Patch the row with this id. Returns the updated copy, or null if missing. */
export function update(table, id, patch) {
  const n = Number(id);
  const i = tables[table].findIndex((x) => x.id === n);
  if (i < 0) return null;
  return replaceAt(table, i, { ...tables[table][i], ...patch });
}

/** Patch every row matching pred. Returns the number of rows changed. */
export function updateWhere(table, pred, patch) {
  let n = 0;
  tables[table].forEach((r, i) => {
    if (!pred(r)) return;
    replaceAt(table, i, { ...r, ...patch });
    n++;
  });
  return n;
}

function replaceAt(table, i, row) {
  const before = tables[table][i];
  const r = normalizeRow(table, row);
  const oldKey = rowKey(table, before);
  const newKey = rowKey(table, r);
  tables[table][i] = r;
  if (JSON.stringify(before) !== JSON.stringify(r)) {
    if (oldKey !== newKey) markChanged(table, oldKey, true);
    markChanged(table, newKey, false);
  }
  return { ...r };
}

/** Insert or replace by the table's identity key (stock_holdings: symbol, settings: key …). */
export function upsert(table, row) {
  const key = rowKey(table, normalizeRow(table, row));
  const i = tables[table].findIndex((x) => rowKey(table, x) === key);
  if (i < 0) return insert(table, row);
  const existing = tables[table][i];
  return replaceAt(table, i, { ...existing, ...row, id: existing.id ?? row.id });
}

export function remove(table, id) {
  const n = Number(id);
  return removeWhere(table, (x) => x.id === n);
}

export function removeWhere(table, pred) {
  const keep = [];
  let n = 0;
  for (const r of tables[table]) {
    if (pred(r)) { n++; markChanged(table, rowKey(table, r), true); } else keep.push(r);
  }
  tables[table] = keep;
  return n;
}

// ---------------------------------------------------------------- transactions

/**
 * Run fn atomically: if it throws (or rejects), every table is restored.
 */
export async function transaction(fn) {
  // Rows are never mutated in place (every write stores a new object), so
  // copying the arrays is a complete snapshot.
  const snapT = {};
  for (const [k, v] of Object.entries(tables)) snapT[k] = v.slice();
  const snapP = {};
  for (const [k, v] of Object.entries(pending)) snapP[k] = { up: new Set(v.up), del: new Set(v.del) };
  try {
    return await fn();
  } catch (e) {
    tables = snapT;
    pending = snapP;
    scheduleSave('data', 'cache', 'pending');
    throw e;
  }
}

// ---------------------------------------------------------------- settings

function localSettings() {
  if (!localSettingsCache) {
    try { localSettingsCache = JSON.parse(storage()?.getItem(LOCAL_SETTINGS_KEY) || '{}'); } catch { localSettingsCache = {}; }
  }
  return localSettingsCache;
}

/** A setting's stored value; when unset, its default (or ''). */
export function getSetting(key) {
  if (LOCAL_SETTINGS.has(key)) return localSettings()[key] ?? '';
  const r = tables.settings.find((x) => x.key === key);
  return r ? r.value : (SETTING_DEFAULTS[key] ?? '');
}

export function setSetting(key, value) {
  if (LOCAL_SETTINGS.has(key)) {
    const s = { ...localSettings(), [key]: String(value) };
    localSettingsCache = s;
    try { storage()?.setItem(LOCAL_SETTINGS_KEY, JSON.stringify(s)); } catch { /* ignore */ }
    return;
  }
  upsert('settings', { key, value: String(value) });
}

/** Every setting, local-only keys included ('' when unset). */
export function allSettings() {
  const out = { ...SETTING_DEFAULTS };
  for (const k of LOCAL_SETTINGS) out[k] = '';
  for (const r of tables.settings) out[r.key] = r.value;
  return { ...out, ...localSettings() };
}

// ---------------------------------------------------------------- sync support

/** Take the set of changed keys (moves them out of pending). */
export function takePending() {
  const p = pending;
  pending = {};
  scheduleSave('pending');
  return p;
}

/** Put keys back after a failed sync. */
export function restorePending(p) {
  for (const [name, v] of Object.entries(p)) {
    const cur = (pending[name] ||= { up: new Set(), del: new Set() });
    for (const k of v.up) if (!cur.del.has(k)) cur.up.add(k);
    for (const k of v.del) if (!cur.up.has(k)) cur.del.add(k);
  }
  scheduleSave('pending');
}

export function hasPending() {
  return Object.values(pending).some((v) => v.up.size || v.del.size);
}

export function pendingCount() {
  return Object.values(pending).reduce((n, v) => n + v.up.size + v.del.size, 0);
}

/** Mark every synced row as changed (first push to a new sheet, after import). */
export function markAllPending() {
  for (const name of SYNCED_TABLES) {
    for (const r of tables[name]) markChanged(name, rowKey(name, r), false);
  }
}

/**
 * Merge sheet rows with local edits.
 *   remote: rows read from the sheet
 *   taken:  keys this sync is pushing (from takePending)
 *   live:   keys changed since the sync started (still in pending)
 * Replaces the local table with remote + taken edits + live edits. Returns
 * { toWrite: remote + taken edits, remoteDirty: toWrite differs from the sheet,
 *   localChanged: the local table's contents changed }.
 */
export function mergeTable(table, remote, taken) {
  const key = (r) => rowKey(table, r);
  const before = tables[table];
  const localByKey = new Map(before.map((r) => [key(r), r]));
  const remoteByKey = new Map(remote.map((r) => { const n = normalizeRow(table, r); return [key(n), n]; }));
  // Device-local settings typed into the sheet are ignored (and dropped from it).
  if (table === 'settings') for (const k of LOCAL_SETTINGS) remoteByKey.delete(k);
  const merged = new Map(remoteByKey);
  const apply = (p) => {
    if (!p) return;
    for (const k of p.del) merged.delete(k);
    for (const k of p.up) {
      const r = localByKey.get(k);
      if (r) merged.set(k, r); else merged.delete(k);
    }
  };
  apply(taken);
  const toWrite = [...merged.values()];
  apply(pending[table]);
  tables[table] = [...merged.values()];
  const same = (a, b) => a === b || (!!a && !!b && JSON.stringify(a) === JSON.stringify(b));
  const remoteDirty = toWrite.length !== remote.length || toWrite.some((r) => !same(r, remoteByKey.get(key(r))));
  const localChanged = tables[table].length !== before.length || tables[table].some((r) => !same(r, localByKey.get(key(r))));
  if (localChanged) scheduleSave('data');
  return { toWrite, remoteDirty, localChanged };
}

/** Wipe everything on this device (sign-out / switch account). */
export function clearLocal() {
  tables = emptyTables();
  pending = {};
  scheduleSave('data', 'cache', 'pending');
  saveNow();
}

/** For tests: replace state directly. */
export function _reset(data = {}) {
  tables = emptyTables();
  pending = {};
  localSettingsCache = null;
  for (const [k, v] of Object.entries(data)) tables[k] = v.map((r) => normalizeRow(k, r));
}
