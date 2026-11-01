// Entry point: loads the local tables, registers the API handlers,
// starts the Google Sheets sync and wires the cloud / import controls.

import * as db from './server/db.js';
import { route, handle } from './server/router.js';
import { badRequest, body } from './server/util.js';
import { VERSION } from './version.js';
import * as sync from './cloud/sync.js';
import { invalidateCache, invalidateForexCache, fetchQuote } from './server/market.js';
import { BACKUP_FORMAT } from './server/settings.js';

// Route registration happens on import.
import './server/assets.js';
import './server/stocks.js';
import './server/export.js';
import './server/twr.js';
import './server/performance.js';
import './server/datacheck.js';
import './server/dividends.js';
import './server/expenses.js';
import './server/reports.js';
import './server/llm.js';
import './server/managed.js';
import './server/settings.js';

db.load();

route('GET', '/api/version', () => ({ version: VERSION }));

// ---------------------------------------------------------------- import


/** Validate an import file and count rows per table. */
function parseImport(data) {
  if (!data || typeof data !== 'object' || data.format !== BACKUP_FORMAT || typeof data.tables !== 'object') {
    throw badRequest('不是本網站的備份檔');
  }
  const counts = {};
  for (const t of db.SYNCED_TABLES) {
    const rows = data.tables[t];
    if (rows === undefined) continue;
    if (!Array.isArray(rows)) throw badRequest(`${t} 格式錯誤`);
    counts[t] = rows.length;
  }
  if (!Object.keys(counts).length) throw badRequest('檔案裡沒有任何資料表');
  return counts;
}

// Replaces every table present in the file. Rows keep their ids so references
// (account_id) stay valid; device-local settings are never imported.
route('POST', '/api/import', async (req) => {
  const data = body(req);
  const counts = parseImport(data);
  await db.transaction(async () => {
    for (const t of Object.keys(counts)) {
      let rows = data.tables[t];
      if (t === 'settings') rows = rows.filter((r) => !db.LOCAL_SETTINGS.has(r.key));
      db.removeWhere(t, () => true);
      for (const r of rows) db.insert(t, r);
    }
  });
  return { status: 'imported', counts };
});

const TABLE_LABELS = {
  asset_snapshots: '資產快照', stock_transactions: '股票交易', stock_holdings: '持倉', dividends: '股利',
  expenses: '收支', budgets: '預算', stock_snapshots: '股票快照', managed_accounts: '代管帳戶',
  managed_snapshots: '代管快照', managed_cash_movements: '代管現金異動', settings: '設定', llm_conversations: 'AI 對話',
};

let pendingImport = null;

function onImportFile(e) {
  const file = e.target.files?.[0];
  const box = document.getElementById('import-preview');
  pendingImport = null;
  box.innerHTML = '';
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      const counts = parseImport(data);
      pendingImport = data;
      const items = Object.entries(counts).map(([t, n]) => `<li>${TABLE_LABELS[t] || t}：${n} 筆</li>`).join('');
      box.innerHTML = `<div class="card" style="padding:12px">
        <div>${data.exported_at ? `匯出時間：${escapeHtml(data.exported_at)}` : ''}</div>
        <ul style="margin:8px 0 8px 20px">${items}</ul>
        <button type="button" class="btn btn-primary btn-sm" id="import-confirm">取代目前資料並匯入</button>
      </div>`;
      document.getElementById('import-confirm').onclick = confirmImport;
    } catch (err) {
      box.innerHTML = `<p class="text-danger">${escapeHtml(err.message)}</p>`;
    }
  };
  reader.readAsText(file);
}

async function confirmImport() {
  if (!pendingImport) return;
  if (!confirm('匯入會取代目前所有資料（登入時也會同步到試算表），確定嗎？')) return;
  try {
    const res = await handle('/api/import', { method: 'POST', body: pendingImport });
    const total = Object.values(res.counts).reduce((a, b) => a + b, 0);
    window.showToast?.(`已匯入 ${total} 筆`, 'success');
    pendingImport = null;
    document.getElementById('import-preview').innerHTML = '';
    document.getElementById('import-file').value = '';
    window.fwRefresh?.();
  } catch (err) {
    window.showToast?.('匯入失敗：' + err.message, 'error');
  }
}

// ---------------------------------------------------------------- cloud UI

const STATUS_TEXT = {
  local: '本機', 'signed-out': '未登入', expired: '需要重新連線', syncing: '同步中…',
  synced: '已同步', pending: '待同步', error: '同步失敗', idle: '本機',
};

function renderCloudStatus() {
  const st = sync.state;
  const pill = document.getElementById('sync-pill');
  if (pill) {
    pill.dataset.status = st.status;
    const n = db.pendingCount();
    document.getElementById('sync-pill-text').textContent =
      STATUS_TEXT[st.status] + (n && st.status !== 'syncing' && st.status !== 'local' ? ` · ${n}` : '');
    pill.title = st.error ? `同步失敗：${st.error}` : '雲端同步狀態';
  }
  const acct = document.getElementById('cloud-account');
  if (!acct) return;
  const email = sync.auth.getEmail();
  const configured = sync.auth.isConfigured();
  acct.textContent = !configured
    ? '這個網站還沒設定 Google 用戶端 ID（js/config.js），資料只存在這台裝置。'
    : email ? `${email}（${STATUS_TEXT[st.status]}${st.lastSync ? `，上次同步 ${st.lastSync.toLocaleTimeString()}` : ''}）` : '尚未登入';
  document.getElementById('cloud-signin-btn').style.display = configured && st.status !== 'synced' && st.status !== 'syncing' ? '' : 'none';
  document.getElementById('cloud-signin-btn').textContent = email ? '重新連線' : '用 Google 登入';
  document.getElementById('cloud-sync-btn').style.display = sync.auth.hasValidToken() ? '' : 'none';
  document.getElementById('cloud-signout-btn').style.display = email ? '' : 'none';
  const link = document.getElementById('cloud-sheet-link');
  const url = sync.sheetURL();
  link.style.display = url ? '' : 'none';
  if (url) link.href = url;
}

// Must stay synchronous up to sync.signIn(): it opens the Google popup.
function cloudSignIn() {
  sync.signIn()
    .then((email) => window.showToast?.(`已連線 ${email}`, 'success'))
    .catch((e) => {
      if (e.message !== 'popup_closed') window.showToast?.('登入失敗：' + e.message, 'error');
    });
}

function onSyncPillClick() {
  const st = sync.state.status;
  if ((st === 'expired' || st === 'signed-out') && sync.auth.isAuthReady()) return cloudSignIn();
  document.querySelector('.tab-btn[data-tab="settings"]')?.click();
}

async function cloudSyncNow() {
  await sync.syncNow();
  if (sync.state.status === 'error') window.showToast?.('同步失敗：' + sync.state.error, 'error');
}

function cloudSignOut() {
  const pendingN = db.pendingCount();
  const msg = pendingN
    ? `還有 ${pendingN} 筆變更沒同步，登出會遺失。要登出並清除這台裝置的資料嗎？`
    : '登出並清除這台裝置的資料？（試算表裡的資料不受影響）';
  if (!confirm(msg)) return;
  sync.signOut({ clearData: true });
  window.fwRefresh?.();
}

async function saveProxyURL() {
  const input = document.getElementById('yahoo-proxy-url');
  const url = input.value.trim().replace(/\/+$/, '');
  if (url && !/^https:\/\//.test(url)) {
    window.showToast?.('代理網址需以 https:// 開頭', 'error');
    return;
  }
  db.setSetting('yahoo_proxy_url', url);
  invalidateCache();
  invalidateForexCache();
  try {
    const q = await fetchQuote('SPY');
    window.showToast?.(`行情來源可用（SPY ${q.price}）`, 'success');
  } catch (e) {
    window.showToast?.('行情來源無法使用：' + e.message, 'error');
  }
}

function downloadBackup() {
  window.api('/api/settings/backup').catch((e) => window.showToast?.('備份失敗：' + e.message, 'error'));
}

function clearLocalData() {
  const signedIn = !!sync.auth.getEmail();
  const msg = signedIn
    ? '清除這台裝置的資料？下次同步會從試算表重新下載（尚未同步的變更會遺失）。'
    : '清除這台裝置的所有資料？沒有登入，資料無法復原。建議先下載備份。';
  if (!confirm(msg)) return;
  db.clearLocal();
  db.load();
  if (signedIn) sync.syncNow();
  window.fwRefresh?.();
}

/** Re-render the active tab after data changed underneath it. */
function fwRefresh() {
  const tab = document.querySelector('.tab-btn.active')?.dataset.tab;
  if (tab && typeof window.onTabActivated === 'function') window.onTabActivated(tab);
  renderCloudStatus();
}

Object.assign(window, {
  LocalAPI: { handle },
  fwRefresh, renderCloudStatus, cloudSignIn, cloudSyncNow, cloudSignOut,
  onSyncPillClick, saveProxyURL, downloadBackup, clearLocalData,
});

window.localApiReady = Promise.resolve();

document.getElementById('import-file')?.addEventListener('change', onImportFile);
sync.onStatus(renderCloudStatus);
db.onChange(() => renderCloudStatus());
sync.initSync();

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch((e) => console.warn('sw register failed', e));
}
