// Keeps the local tables (js/server/db.js) and the user's Google Sheet in step.
//
// Local first: every change lands in localStorage immediately and is recorded
// as pending. A sync reads every tab, overlays this device's pending edits
// (last writer wins per row), writes back the tabs that differ, and adopts the
// merged result locally.

import * as auth from './auth.js';
import { openSpreadsheet, fetchEmail, ApiError } from './sheets.js';
import * as db from '../server/db.js';
import { setQuoteFallback } from '../server/market.js';

const SHEET_ID_KEY = 'fw.sheetId';
const AUTO_SYNC_DELAY_MS = 2000;
const PERIODIC_SYNC_MS = 5 * 60 * 1000;

let sheet = null;
let running = null;
let again = false;
let timer = null;
const listeners = new Set();
export const state = { status: 'idle', error: null, lastSync: null };

function setStatus(status, error = null) {
  state.status = status;
  state.error = error;
  for (const fn of listeners) fn(state);
}

export function onStatus(fn) {
  listeners.add(fn);
  fn(state);
  return () => listeners.delete(fn);
}

export const sheetURL = () => sheet?.url ?? null;

function cachedSheetId() {
  try { return localStorage.getItem(SHEET_ID_KEY); } catch { return null; }
}

async function ensureSheet(token) {
  if (sheet) return sheet;
  const { sheet: s, created } = await openSpreadsheet(token, { cachedId: cachedSheetId() });
  sheet = s;
  try { localStorage.setItem(SHEET_ID_KEY, s.id); } catch { /* ignore */ }
  if (created) db.markAllPending(); // a brand-new sheet gets everything on this device
  return sheet;
}

/** Run a sync now (coalesces with one already running). Resolves true if data changed. */
export function syncNow() {
  if (running) { again = true; return running; }
  running = (async () => {
    let changed = false;
    try {
      do {
        again = false;
        changed = (await syncOnce()) || changed;
      } while (again);
    } finally {
      running = null;
    }
    if (changed) window.fwRefresh?.();
    return changed;
  })();
  return running;
}

async function syncOnce() {
  const token = auth.getToken();
  if (!token) {
    setStatus(auth.getEmail() ? 'expired' : 'signed-out');
    return false;
  }
  setStatus('syncing');
  const taken = db.takePending();
  try {
    const s = await ensureSheet(token);
    const remote = await s.readAll(token);
    const writes = {};
    let localChanged = false;
    for (const table of db.SYNCED_TABLES) {
      const m = db.mergeTable(table, remote[table] || [], taken[table]);
      if (m.remoteDirty) writes[table] = m.toWrite;
      localChanged ||= m.localChanged;
    }
    await s.writeTables(token, writes);
    state.lastSync = new Date();
    setStatus(db.hasPending() ? 'pending' : 'synced');
    return localChanged;
  } catch (e) {
    db.restorePending(taken);
    if (e instanceof ApiError && e.status === 401) {
      auth.invalidateToken();
      setStatus('expired');
    } else {
      console.error('sync failed', e);
      if (e instanceof ApiError && e.status === 404) sheet = null;
      setStatus('error', e.message);
    }
    return false;
  }
}

function scheduleSync(delay = AUTO_SYNC_DELAY_MS) {
  if (!auth.hasValidToken()) {
    setStatus(db.hasPending() ? (auth.getEmail() ? 'expired' : 'signed-out') : state.status);
    return;
  }
  clearTimeout(timer);
  timer = setTimeout(() => syncNow(), delay);
}

/** Must be called synchronously from a click handler (opens the Google popup). */
export function signIn() {
  const firstTime = !auth.getEmail();
  return auth.requestToken({ firstTime }).then(async (token) => {
    const email = await fetchEmail(token);
    const prev = auth.getEmail();
    if (prev && prev !== email) {
      // Different account: this device's copy belongs to the previous one.
      db.clearLocal();
      sheet = null;
      try { localStorage.removeItem(SHEET_ID_KEY); } catch { /* ignore */ }
    }
    auth.setEmail(email);
    await syncNow();
    return email;
  });
}

export function signOut({ clearData = false } = {}) {
  auth.signOut();
  sheet = null;
  try { localStorage.removeItem(SHEET_ID_KEY); } catch { /* ignore */ }
  if (clearData) db.clearLocal();
  setStatus('signed-out');
}

export async function initSync() {
  await auth.initAuth().catch((e) => console.warn('auth init failed', e));
  db.onChange(() => scheduleSync());
  setQuoteFallback(async (symbols) => {
    const token = auth.getToken();
    if (!token) throw new Error('GOOGLEFINANCE 報價需要登入 Google');
    const s = await ensureSheet(token);
    return s.quotes(token, symbols);
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') scheduleSync(0);
  });
  setInterval(() => scheduleSync(0), PERIODIC_SYNC_MS);
  if (auth.hasValidToken()) syncNow();
  else setStatus(auth.getEmail() ? 'expired' : (auth.isConfigured() ? 'signed-out' : 'local'));
}

export { auth };
