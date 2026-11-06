/* ============================================================
   Finance Watcher - Main Application JS
   Single Page Application logic for personal finance management
   ============================================================ */

// ============================================================
// SECTION: Utility Functions
// ============================================================

// Privacy mode (eye toggle): amounts and share counts render as MASK.
// fmt() and the money formatters built on it are masked; prices, FX rates
// and percentages use fmtNum()/fmtPrice()/fmtPct() and stay visible.
const MASK = '****';
let privacyMode = false;
try { privacyMode = localStorage.getItem('privacyMode') === '1'; } catch (e) {}

/** Axis tick/grid style shared by the charts */
const CHART_AXIS = { ticks: { color: '#5c6f8a', font: { size: 11 } }, grid: { color: 'rgba(42,58,78,0.4)' } };

/** Format an amount / share count with commas (masked in privacy mode) */
function fmt(n, decimals = 0) {
  if (n == null || isNaN(n)) return '--';
  if (privacyMode) return (n < 0 ? '-' : '') + MASK;
  return fmtNum(n, decimals);
}

/** Format a number with commas, never masked (prices, rates) */
function fmtNum(n, decimals = 0) {
  if (n == null || isNaN(n)) return '--';
  return Number(n).toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/** Format as NT$ currency */
function fmtTWD(n) {
  if (n == null || isNaN(n)) return '--';
  return 'NT$ ' + fmt(n, 0);
}

/** Format as US$ currency */
function fmtUSD(n) {
  if (n == null || isNaN(n)) return '--';
  return 'US$ ' + fmt(n, 2);
}

/** Format percentage */
function fmtPct(n) {
  if (n == null || isNaN(n)) return '--';
  return (n >= 0 ? '+' : '') + n.toFixed(2) + '%';
}

/** Get CSS class for positive/negative */
function plClass(n) {
  if (n == null || isNaN(n) || n === 0) return '';
  return n > 0 ? 'positive' : 'negative';
}

/** Format P&L value with sign */
function fmtPL(n) {
  if (n == null || isNaN(n)) return '--';
  const prefix = n > 0 ? '+' : '';
  return prefix + fmt(n, 0);
}

/** Format amount in native currency (USD=2 decimals, TWD=0 decimals) */
function fmtCur(n, currency) {
  if (n == null || isNaN(n)) return '--';
  const isUSD = currency === 'USD';
  return (isUSD ? '$' : 'NT$') + fmt(n, isUSD ? 2 : 0);
}

/** 收支 currencies by code (EXPENSE_CURRENCIES comes from js/server/expenses.js via main.js). */
const expCurrency = (code) => EXPENSE_CURRENCIES.find(c => c.code === (code || 'TWD')) || EXPENSE_CURRENCIES[0];

/** An amount in a 收支 currency: 🇯🇵 ¥1,200 */
function fmtMoney(n, code) {
  if (n == null || isNaN(n)) return '--';
  const c = expCurrency(code);
  return `${c.flag} ${c.symbol}${fmt(n, c.decimals)}`;
}

/** YYYY-MM-DD → MM/DD */
const shortDate = (d) => (d || '').slice(5).replace('-', '/');
/** YYYY-MM-DD → MM/DD（三） */
function dayLabel(d) {
  if (!d) return '';
  const [y, m, day] = d.split('-').map(Number);
  return `${shortDate(d)}（${'日一二三四五六'[new Date(y, m - 1, day).getDay()]}）`;
}

/** Format a per-share price in native currency (always 2 decimals, TW prices can be fractional) */
function fmtPrice(n, currency) {
  if (n == null || isNaN(n)) return '--';
  return (currency === 'USD' ? '$' : 'NT$') + fmtNum(n, 2);
}

/** Convert a native-currency amount to TWD */
function toTWD(n, currency, rate) {
  return currency === 'USD' ? n * rate : n;
}

/** Format P&L in native currency, with sign */
function fmtPLCur(n, currency) {
  if (n == null || isNaN(n)) return '--';
  const isUSD = currency === 'USD';
  const prefix = n > 0 ? '+' : (n < 0 ? '-' : '');
  return prefix + (isUSD ? '$' : 'NT$') + fmt(Math.abs(n), isUSD ? 2 : 0);
}

/** Today's date string YYYY-MM-DD */
function todayStr() {
  return new Date().toISOString().slice(0, 10);
}


// ============================================================
// SECTION: Toast Notifications
// ============================================================

/**
 * action: { label, run } adds a button and makes the toast sticky (stays until clicked);
 * id: only one toast with this id is shown at a time.
 */
/** action: a button on the toast (stays until clicked, or `timeout` ms). */
function showToast(message, type = 'info', { action, id, timeout } = {}) {
  if (id && document.getElementById(id)) return;
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  if (id) toast.id = id;
  const text = document.createElement('span');
  text.textContent = message;
  toast.appendChild(text);
  container.appendChild(toast);
  if (action) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-primary btn-sm';
    btn.textContent = action.label;
    btn.addEventListener('click', () => { toast.remove(); action.run(); });
    toast.appendChild(btn);
    if (timeout) setTimeout(() => toast.remove(), timeout);
    else toast.classList.add('toast-sticky');
    return;
  }
  setTimeout(() => toast.remove(), 3000);
}

// ============================================================
// SECTION: API Helper
// ============================================================

// There is no server: js/main.js registers the handlers in js/server and exposes
// them as window.LocalAPI, which answers the /api/... routes in-browser.
async function api(url, options = {}) {
  try {
    await window.localApiReady;
    const result = await window.LocalAPI.handle(url, options);
    if (result && result.__download) {
      downloadFile(result.filename, result.content, result.type);
      return result;
    }
    return result;
  } catch (err) {
    console.error('API Error:', url, err);
    throw err;
  }
}

function downloadFile(filename, content, type) {
  const blob = new Blob([content], { type: type || 'application/octet-stream' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ============================================================
// SECTION: Icons — line icons in the nav's style, filled into <span data-icon="name">
// ============================================================

const ICONS = {
  grid: '<rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/>',
  wallet: '<path d="M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1"/><path d="M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  briefcase: '<rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/>',
  pie: '<path d="M21.21 15.89A10 10 0 1 1 8 2.83"/><path d="M22 12A10 10 0 0 0 12 2v10z"/>',
  dollar: '<circle cx="12" cy="12" r="10"/><path d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8M12 18V6"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  coins: '<circle cx="8" cy="8" r="6"/><path d="M18.09 10.37A6 6 0 1 1 10.34 18M7 6h1v4M16.71 13.88l.7.71-2.82 2.82"/>',
  cloud: '<path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/>',
  // Sync status (same drawings as headack): one cloud, a mark for the state
  'cloud-check': '<path d="M7 18h10a4 4 0 0 0 .6-7.96A6 6 0 0 0 6.1 9.6 4.2 4.2 0 0 0 7 18z"/><path d="M9.5 13.5l2 2 3.5-3.5"/>',
  'cloud-up': '<path d="M7 18h10a4 4 0 0 0 .6-7.96A6 6 0 0 0 6.1 9.6 4.2 4.2 0 0 0 7 18z"/><path d="M12 16v-5M9.5 13.5 12 11l2.5 2.5"/>',
  'cloud-sync': '<path d="M7 18h10a4 4 0 0 0 .6-7.96A6 6 0 0 0 6.1 9.6 4.2 4.2 0 0 0 7 18z"/><path d="M9 14h.01M12 14h.01M15 14h.01"/>',
  'cloud-off': '<path d="M7 18h10a4 4 0 0 0 .6-7.96A6 6 0 0 0 6.1 9.6 4.2 4.2 0 0 0 7 18z"/><path d="M3 3l18 18"/>',
  sliders: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
  trending: '<polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/>',
  type: '<path d="M4 7V4h16v3M9 20h6M12 4v16"/>',
  database: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14a9 3 0 0 0 18 0V5"/><path d="M3 12a9 3 0 0 0 18 0"/>',
  check: '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
  alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4M12 17h.01"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  eye: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>',
  'eye-off': '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/>',
  pencil: '<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/>',
  trash: '<path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M10 11v6M14 11v6"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5M12 15V3"/>',
  'chevron-left': '<path d="m15 18-6-6 6-6"/>',
  'chevron-right': '<path d="m9 18 6-6-6-6"/>',
  sparkles: '<path d="M12 3l1.9 5.8L20 10.7l-6.1 1.9L12 18.5l-1.9-5.9L4 10.7l6.1-1.9z"/><path d="M19 17v4M17 19h4"/>',
};

/** An icon by reference: the paths live once, in the sprite applyIcons adds (#i-name). */
const svgIcon = (name) => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;

function applyIcons(root = document) {
  if (!document.getElementById('icon-sprite')) {
    const symbols = Object.entries(ICONS).map(([name, paths]) =>
      `<symbol id="i-${name}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</symbol>`).join('');
    document.body.insertAdjacentHTML('afterbegin', `<svg id="icon-sprite" width="0" height="0" style="position:absolute" aria-hidden="true">${symbols}</svg>`);
  }
  root.querySelectorAll('[data-icon]').forEach(el => {
    if (ICONS[el.dataset.icon]) el.innerHTML = svgIcon(el.dataset.icon);
  });
}

/** Icon-only row actions: [icon, button style, label]; the label is the tooltip and screen-reader name. */
const ROW_ACTIONS = {
  edit: ['pencil', 'btn-outline', '編輯'],
  delete: ['trash', 'btn-danger', '刪除'],
  view: ['list', 'btn-outline', '明細'],
};
const rowBtn = (kind, onclick, label = ROW_ACTIONS[kind][2]) => {
  const [icon, cls] = ROW_ACTIONS[kind];
  return `<button type="button" class="btn ${cls} btn-sm btn-icon" title="${label}" aria-label="${label}" onclick="${onclick}">${svgIcon(icon)}</button>`;
};

// ============================================================
// SECTION: Tap tooltips — a `title` is only a hover tooltip, and touch screens can't hover.
// Tapping an element that has one (and isn't itself a control) shows its text in a bubble.
// ============================================================

// Keep in step with the [title] cursor rule in style.css
const TIP_CONTROLS = 'button, a, input, select, textarea, label, [onclick]';

/**
 * Put a position:fixed box centred below rect r (above it when there's no room below),
 * `gap` px from r and at least `margin` px inside the viewport. Shared by tap tips and the tour.
 */
function placeNear(box, r, gap, margin) {
  const b = box.getBoundingClientRect();
  box.style.left = `${Math.min(Math.max(margin, r.left + r.width / 2 - b.width / 2), innerWidth - b.width - margin)}px`;
  box.style.top = `${r.bottom + gap + b.height <= innerHeight - margin ? r.bottom + gap : Math.max(margin, r.top - b.height - gap)}px`;
}

function initTapTips() {
  const bubble = document.createElement('div');
  bubble.id = 'tip-bubble';
  bubble.setAttribute('role', 'tooltip');
  bubble.hidden = true;
  document.body.appendChild(bubble);
  let anchor = null;
  const hide = () => {
    if (bubble.hidden) return;
    bubble.hidden = true;
    anchor = null;
  };

  document.addEventListener('click', (e) => {
    const el = e.target.closest('[title]');
    if (!el || el.closest(TIP_CONTROLS) || !el.title.trim()) {
      if (!bubble.contains(e.target)) hide();
      return;
    }
    if (anchor === el) return hide(); // tap again to close
    anchor = el;
    bubble.textContent = el.title;
    bubble.hidden = false;
    placeNear(bubble, el.getBoundingClientRect(), 8, 8);
  });
  addEventListener('scroll', hide, { passive: true, capture: true });
  addEventListener('resize', hide);
}

// ============================================================
// SECTION: Tab Navigation
// ============================================================

// Pages without their own nav button: the nav tab they were opened from stays
// highlighted, and their back link (text filled in here) returns there.
const SUB_PAGES = new Set(['managed', 'llm']);
const activeNav = () => document.querySelector('.tab-btn.active');

function showTab(tab) {
  if (SUB_PAGES.has(tab)) {
    const label = activeNav().querySelector('.tab-label').textContent;
    document.querySelectorAll(`#tab-${tab} > .back-link`).forEach(b => { b.textContent = `‹ ${label}`; });
  } else {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  }
  document.querySelectorAll('.tab-content').forEach(tc => tc.classList.toggle('active', tc.id === 'tab-' + tab));
  window.scrollTo(0, 0);
  onTabActivated(tab);
}

const goBack = () => showTab(activeNav().dataset.tab);

function initTabs() {
  document.querySelectorAll('.tab-btn').forEach(btn => btn.addEventListener('click', () => showTab(btn.dataset.tab)));

  // Sub-tabs (stocks)
  document.querySelectorAll('.sub-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const parent = btn.closest('section');
      parent.querySelectorAll('.sub-tab-btn').forEach(b => b.classList.remove('active'));
      parent.querySelectorAll('.subtab-content').forEach(c => c.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('subtab-' + btn.dataset.subtab).classList.add('active');
      // Each 股票 sub-tab loads when shown (charts need a visible canvas to size)
      STOCKS_SUBTAB_LOADERS[btn.dataset.subtab]?.forEach(load => load());
    });
  });

  // LLM toggle
  document.querySelectorAll('.toggle-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.toggle-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll('.llm-mode').forEach(m => m.classList.remove('active'));
      document.getElementById('llm-mode-' + btn.dataset.mode).classList.add('active');
    });
  });
}

function applyPrivacyUI() {
  document.querySelectorAll('.privacy-toggle').forEach(btn => {
    btn.setAttribute('aria-pressed', privacyMode ? 'true' : 'false');
    btn.title = privacyMode ? '顯示金額' : '隱藏金額';
  });
}

function togglePrivacy() {
  privacyMode = !privacyMode;
  try { localStorage.setItem('privacyMode', privacyMode ? '1' : '0'); } catch (e) {}
  applyPrivacyUI();
  // Re-render the active tab so every formatted number picks up the new mode
  onTabActivated(document.body.dataset.tab || 'dashboard');
}

/** What each 股票 sub-tab loads when it is shown (only the visible one loads). */
const STOCKS_SUBTAB_LOADERS = {
  holdings: [loadHoldings, loadXirr, loadHoldingsTrend],
  portfolio: [loadPortfolioAnalysis],
  realized: [loadRealizedSummary],
  transactions: [loadTransactions],
  dividends: [loadDividends],
};

function onTabActivated(tab) {
  document.body.dataset.tab = tab; // CSS shows tab-specific controls (e.g. the 收支 + button)
  switch (tab) {
    case 'dashboard': loadDashboard(); break;
    case 'stocks': {
      const sub = document.querySelector('#tab-stocks .sub-tab-btn.active')?.dataset.subtab || 'holdings';
      STOCKS_SUBTAB_LOADERS[sub]?.forEach(load => load());
      break;
    }
    case 'expenses': loadExpenses(); break;
    case 'managed': loadManagedAccounts(); break;
    case 'llm': initAIImport(); break;
    case 'settings': loadSettings(); loadDataCheck(); break;
  }
}

// ============================================================
// SECTION: Modal Helpers
// ============================================================

function openModal(id) {
  document.getElementById(id).style.display = 'flex';
}

function closeModal(id) {
  document.getElementById(id).style.display = 'none';
}

// Close modals on overlay click
document.addEventListener('click', (e) => {
  if (e.target.classList.contains('modal-overlay')) {
    e.target.style.display = 'none';
  }
});

// ============================================================
// SECTION: Dashboard
// ============================================================

let assetTrendChart = null;
let _cachedAssets = [];
let _carriedCash = null; // /api/assets/cash: the latest snapshot's cash carried forward; prefills a new snapshot

async function loadDashboard() {
  try {
    const [assets, cash, stocks, transactions, xirr, overview] = await Promise.all([
      api('/api/assets').catch(() => []),
      api('/api/assets/cash').catch(() => null),
      api('/api/stocks').catch(() => ({ holdings: [], total_value_twd: 0 })),
      api('/api/transactions').catch(() => []),
      api('/api/stocks/xirr').catch(() => ({})),
      api('/api/overview').catch(() => ({ years: [] })),
    ]);

    const assetList = Array.isArray(assets) ? assets : [];
    const stockData = (stocks && stocks.holdings) ? stocks : { holdings: [], total_value_twd: 0 };
    const txList = Array.isArray(transactions) ? transactions : [];

    _cachedAssets = assetList;

    // Current live values - split TW/US
    const holdings = stockData.holdings || [];
    const twHoldings = holdings.filter(h => h.market === 'TW');
    const usHoldings = holdings.filter(h => h.market === 'US');
    const twStockValue = twHoldings.reduce((s, h) => s + (h.market_value_twd || 0), 0);
    const usStockValue = usHoldings.reduce((s, h) => s + (h.market_value_twd || 0), 0);
    const currentStockValue = stockData.total_value_twd || 0;

    // Latest snapshot for cash info
    const latest = assetList.length > 0 ? assetList[0] : null;
    const rate = (latest && latest.usd_twd_rate) || 32;

    // Cash = latest snapshot carried forward by later trades and dividends (see assets.js carriedCash)
    _carriedCash = latest ? cash : null;
    const cashTwd = _carriedCash ? _carriedCash.twd : 0;
    const cashUsd = _carriedCash ? _carriedCash.usd : 0;
    const liveNetWorth = latest ? cashTwd + cashUsd * rate + currentStockValue : null;

    const netDate = document.getElementById('dash-net-date');
    netDate.title = '';
    if (latest) {
      document.getElementById('dash-net-worth').textContent = fmtTWD(liveNetWorth);
      const c = _carriedCash || { trades: 0, dividends: 0 };
      const counted = [c.trades && `${c.trades} 筆交易`, c.dividends && `${c.dividends} 筆股利`].filter(Boolean);
      netDate.textContent = `現金：${latest.date} 快照${counted.length ? `＋之後 ${counted.join('、')}` : ''} / 股票為即時市值`;
      if (counted.length) netDate.title = `台幣 ${fmtPL(c.moved_twd)}、美金 ${fmtPLCur(c.moved_usd, 'USD')}（收支不算，下次記快照時對齊）`;
      document.getElementById('dash-growth').innerHTML =
        `較 ${shortDate(latest.date)} 快照 ${changeHtml(liveNetWorth, latest.total_asset)}`;
    } else {
      document.getElementById('dash-net-worth').textContent = '--';
      netDate.textContent = '尚無快照，請新增';
      document.getElementById('dash-growth').innerHTML = '';
    }

    renderDashChangeStats({ twHoldings, usHoldings, stockValue: currentStockValue, xirr, year: overview.years.find(y => y.current) });
    loadPerformance(); // separate request: the first run fetches price history
    loadDataCheckBadge();

    // Asset composition donut - split TW/US stocks
    if (latest) {
      const cashUsdTwd = cashUsd * rate;
      const ctx = document.getElementById('chart-asset-composition');
      if (window._assetCompChart) window._assetCompChart.destroy();
      const compLabels = ['台幣現金', '美金現金(換算TWD)', '台股市值', '美股市值'];
      const compData = [cashTwd, cashUsdTwd, twStockValue, usStockValue].map(v => Math.max(0, v)); // carried-forward cash can dip below 0
      const compColors = ['#4e8cff', '#fbbf24', '#34d399', '#f87171'];
      const compTotal = compData.reduce((a, b) => a + b, 0);
      window._assetCompChart = new Chart(ctx, {
        type: 'doughnut',
        data: {
          labels: compLabels,
          datasets: [{ data: compData, backgroundColor: compColors, borderWidth: 0, hoverOffset: 6 }]
        },
        options: {
          responsive: true, maintainAspectRatio: false, cutout: '55%',
          plugins: {
            legend: { display: false },
            tooltip: { callbacks: { label: c => { const pct = compTotal > 0 ? ((c.parsed/compTotal)*100).toFixed(1) : 0; return `${c.label}: ${fmtTWD(c.parsed)} (${pct}%)`; } } }
          }
        }
      });
      document.getElementById('legend-asset-composition').innerHTML = compLabels.map((l, i) => {
        const pct = compTotal > 0 ? ((compData[i]/compTotal)*100).toFixed(1) : 0;
        return `<span class="legend-item"><span class="legend-dot" style="background:${compColors[i]}"></span>${l}: ${fmtTWD(compData[i])} (${pct}%)</span>`;
      }).join('');
    }

    // Net worth trend from snapshots
    window._trendAssets = [...assetList].reverse(); // chronological
    reRenderTrendChart();

    // Recent transactions
    const recentTx = txList.slice(0, 5);
    const txBody = document.getElementById('dash-tx-body');
    if (recentTx.length === 0) {
      txBody.innerHTML = '<tr><td colspan="5" class="empty-state">尚無交易紀錄</td></tr>';
    } else {
      txBody.innerHTML = recentTx.map(t => `
        <tr>
          <td>${t.date || '--'}</td>
          <td>${t.symbol || '--'}</td>
          <td><span class="${t.action === 'BUY' ? 'tag-buy' : 'tag-sell'}">${t.action === 'BUY' ? '買' : '賣'}</span></td>
          <td>${fmt(t.shares)}</td>
          <td>${fmtNum(t.price, 2)}</td>
        </tr>
      `).join('');
    }

    // Snapshots table
    renderSnapshots(assetList);

  } catch (err) {
    showToast('載入總覽資料失敗: ' + err.message, 'error');
  }
}

let _trendChartType = 'bar';

function setTrendChartType(type) {
  _trendChartType = type;
  document.querySelectorAll('#trend-type .chart-type-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.type === type);
  });
  reRenderTrendChart();
}

function reRenderTrendChart() {
  const assets = window._trendAssets || [];
  const mode = document.getElementById('trend-granularity')?.value || 'all';
  if (mode === 'daily') {
    renderDailyTrendChart(assets);
    return;
  }
  let filtered;

  switch (mode) {
    case 'last10':
      filtered = assets.slice(-10);
      break;
    case 'last20':
      filtered = assets.slice(-20);
      break;
    case 'monthly':
      filtered = pickLastPerGroup(assets, a => a.date?.slice(0, 7)); // YYYY-MM
      break;
    case 'quarterly':
      filtered = pickLastPerGroup(assets, a => {
        const m = parseInt(a.date?.slice(5, 7) || '1');
        const q = Math.ceil(m / 3);
        return a.date?.slice(0, 4) + '-Q' + q;
      });
      break;
    case 'yearly':
      filtered = pickLastPerGroup(assets, a => a.date?.slice(0, 4)); // YYYY
      break;
    default:
      filtered = assets;
  }

  renderAssetTrendChart(filtered);
}

/**
 * Net worth per weekday: stock values rebuilt by /api/stocks/performance (from
 * the performance start date), cash from the latest snapshot on or before each
 * day. Before the performance data arrives it draws nothing; loadPerformance
 * re-renders it.
 */
/** The four net-worth parts, shared by the snapshot and daily trend charts (tw/us colors also used by 市值與損益走勢) */
const ASSET_SERIES = [
  { key: 'cashTWD', label: '台幣現金', color: '#4e8cff' },
  { key: 'cashUSD', label: '美金現金(TWD)', color: '#fbbf24' },
  { key: 'tw', label: '台股市值', color: '#34d399' },
  { key: 'us', label: '美股市值', color: '#f87171' },
];

function renderDailyTrendChart(assets) {
  const ctx = document.getElementById('chart-asset-trend');
  if (assetTrendChart) assetTrendChart.destroy();
  assetTrendChart = null;
  const s = _perfData && _perfData.series;
  if (!s || !s.dates) return;

  const idx = weekdayIndexes(s.dates, 0);
  let j = -1;
  const snaps = idx.map(i => {
    while (j + 1 < assets.length && assets[j + 1].date <= s.dates[i]) j++;
    return j >= 0 ? assets[j] : null;
  });
  const daily = {
    cashTWD: k => snaps[k] ? snaps[k].cash_twd || 0 : 0,
    cashUSD: k => snaps[k] ? toTWD(snaps[k].cash_usd || 0, 'USD', s.fx[idx[k]]) : 0,
    tw: k => s.value.TW[idx[k]],
    us: k => s.value.US[idx[k]],
  };
  const parts = ASSET_SERIES.map(a => [a.label, a.color, daily[a.key]]);
  const labels = idx.map(i => s.dates[i]);
  const axis = { ticks: { ...CHART_AXIS.ticks, maxTicksLimit: 8, maxRotation: 0 }, grid: CHART_AXIS.grid };
  const isLine = _trendChartType === 'line';
  const datasets = isLine
    ? [{
        label: '總資產', data: idx.map((_, k) => parts.reduce((sum, p) => sum + p[2](k), 0)),
        borderColor: '#4e8cff', backgroundColor: 'rgba(78, 140, 255, 0.08)', fill: true,
        borderWidth: 2, pointRadius: 0, pointHitRadius: 8, tension: 0,
      }]
    : parts.map(([label, color, val], n) => ({
        label, data: idx.map((_, k) => val(k)), borderColor: color, backgroundColor: color + '99',
        fill: n === 0 ? 'origin' : '-1', borderWidth: 1, pointRadius: 0, pointHitRadius: 8, tension: 0,
      }));

  assetTrendChart = new Chart(ctx, {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: !isLine, position: 'top', labels: { color: '#8a9ab5', usePointStyle: true, pointStyle: 'rect', font: { size: 11 } } },
        tooltip: {
          callbacks: {
            label: c => `${c.dataset.label}: ${fmtTWD(c.parsed.y)}`,
            footer: items => isLine ? '' : `總資產: ${fmtTWD(items.reduce((sum, i) => sum + i.parsed.y, 0))}`,
          },
        },
      },
      scales: {
        x: axis,
        y: { ...axis, stacked: !isLine, ticks: { ...axis.ticks, callback: v => fmt(v) } },
      },
    },
  });
}

function pickLastPerGroup(arr, keyFn) {
  const map = new Map();
  for (const item of arr) {
    const key = keyFn(item);
    map.set(key, item); // last one wins (arr is chronological)
  }
  return Array.from(map.values());
}

function renderAssetTrendChart(assets) {
  const ctx = document.getElementById('chart-asset-trend');
  if (assetTrendChart) assetTrendChart.destroy();

  if (!assets || assets.length === 0) return;

  const labels = assets.map(a => a.date || '');
  const isLine = _trendChartType === 'line';

  let datasets, options;

  if (isLine) {
    // Clean line chart - just total asset
    datasets = [{
      label: '總資產',
      data: assets.map(a => a.total_asset || 0),
      borderColor: '#4e8cff',
      backgroundColor: 'rgba(78, 140, 255, 0.08)',
      fill: true,
      tension: 0.35,
      pointRadius: 4,
      pointHoverRadius: 6,
      pointBackgroundColor: '#4e8cff',
      borderWidth: 2,
    }];
    options = {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: c => `總資產: ${fmtTWD(c.parsed.y)}` } }
      },
      scales: {
        x: { ticks: { color: '#5c6f8a', font: { size: 11 } }, grid: { color: 'rgba(42,58,78,0.4)' } },
        y: { ticks: { color: '#5c6f8a', font: { size: 11 }, callback: v => fmt(v) }, grid: { color: 'rgba(42,58,78,0.4)' } }
      }
    };
  } else {
    // Stacked bar chart with breakdown
    const snap = {
      cashTWD: a => a.cash_twd || 0,
      cashUSD: a => (a.cash_usd || 0) * (a.usd_twd_rate || 32),
      tw: a => a.stock_tw_value || 0,
      us: a => a.stock_us_value || 0,
    };
    datasets = ASSET_SERIES.map(s => ({
      label: s.label, data: assets.map(snap[s.key]), backgroundColor: s.color, borderRadius: 2, stack: 'stack',
    }));
    options = {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: true, position: 'top', labels: { color: '#8a9ab5', usePointStyle: true, pointStyle: 'rect', font: { size: 11 } } },
        tooltip: {
          mode: 'index',
          callbacks: {
            label: c => `${c.dataset.label}: ${fmtTWD(c.parsed.y)}`,
            footer: items => { const total = items.reduce((s, i) => s + i.parsed.y, 0); return `總資產: ${fmtTWD(total)}`; }
          }
        }
      },
      scales: {
        x: { stacked: true, ticks: { color: '#5c6f8a', font: { size: 11 } }, grid: { color: 'rgba(42,58,78,0.4)' } },
        y: { stacked: true, ticks: { color: '#5c6f8a', font: { size: 11 }, callback: v => fmt(v) }, grid: { color: 'rgba(42,58,78,0.4)' } }
      }
    };
  }

  assetTrendChart = new Chart(ctx, {
    type: isLine ? 'line' : 'bar',
    data: { labels, datasets },
    options,
  });
}

/** A growthBetween result (js/server/overview.js) as colored parts: 股價 / 股利 / 儲蓄. */
function growthParts(g) {
  return [
    { label: '股價漲跌', v: g.price, color: g.price < 0 ? 'var(--red)' : 'var(--green)' },
    { label: '股利', v: g.dividends, color: 'var(--yellow)' },
    { label: '儲蓄', v: g.savings, color: 'var(--accent)' },
  ];
}

/** Whole days from a YYYY-MM-DD date to today (local time). */
function daysSince(d) {
  const [y, m, day] = d.split('-').map(Number);
  const now = new Date();
  return Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()) - new Date(y, m - 1, day)) / 86400000);
}

/** Colored change from base to cur: "+12,345 (+1.23%)", or just the percent when compact. '' without a base. */
function changeHtml(cur, base, compact = false) {
  if (!(base > 0)) return '';
  const diff = cur - base;
  const pct = fmtPct(diff / base * 100);
  return `<span class="${plClass(diff)}">${compact ? pct : `${fmtPL(diff)} (${pct})`}</span>`;
}

/** One history row: date, total and change in the summary; tap for the rest. */
function snapshotRowHtml(a, prev) {
  return `<details class="snap-row">
    <summary>
      <span class="snap-date">${shortDate(a.date)}</span>
      <span class="snap-total">${fmtTWD(a.net_worth)}</span>
      <span class="snap-delta">${prev ? changeHtml(a.net_worth, prev.net_worth, true) : ''}</span>
    </summary>
    <div class="snap-detail">
      <dl>
        <div><dt>台幣現金</dt><dd>${fmtTWD(a.cash_twd)}</dd></div>
        <div><dt>美金現金</dt><dd>${fmtUSD(a.cash_usd)}</dd></div>
        <div><dt>台股市值</dt><dd>${fmtTWD(a.stock_tw_value)}</dd></div>
        <div><dt>美股市值</dt><dd>${fmtTWD(a.stock_us_value)}</dd></div>
        <div><dt>匯率</dt><dd>${fmtNum(a.usd_twd_rate, 2)}</dd></div>
        ${prev ? `<div><dt>較上一筆</dt><dd>${changeHtml(a.net_worth, prev.net_worth)}</dd></div>` : ''}
      </dl>
      ${a.note ? `<p class="snap-note">${escapeHtml(a.note)}</p>` : ''}
      <div class="snap-actions">
        ${rowBtn('edit', `editSnapshot(${a.id})`)}
        ${rowBtn('delete', `deleteSnapshot(${a.id})`)}
      </div>
    </div>
  </details>`;
}

/** Snapshot card: the latest one up front; the full history (by year, rows expand) behind a toggle. */
function renderSnapshots(assets) {
  const latestEl = document.getElementById('snapshot-latest');
  const toggle = document.getElementById('snapshot-toggle');
  const history = document.getElementById('snapshot-history');
  toggle.hidden = !assets.length;
  if (!assets.length) {
    latestEl.innerHTML = '<div class="empty-state">尚無快照資料，請新增</div>';
    history.hidden = true;
    history.innerHTML = '';
    return;
  }
  const [latest, prev] = assets;
  const days = daysSince(latest.date);
  latestEl.innerHTML = `
    <div class="snap-latest-meta">最新 ${latest.date} · ${days <= 0 ? '今天' : `${days} 天前`}</div>
    <div class="snap-latest-total">${fmtTWD(latest.net_worth)}</div>
    ${prev ? `<div class="snap-latest-delta">較上一筆（${prev.date}）${changeHtml(latest.net_worth, prev.net_worth)}</div>` : ''}`;
  syncSnapshotToggle();

  // assets are newest first, so the previous snapshot of assets[i] is assets[i + 1]
  const years = new Map();
  assets.forEach((a, i) => {
    const y = a.date.slice(0, 4);
    if (!years.has(y)) years.set(y, []);
    years.get(y).push(snapshotRowHtml(a, assets[i + 1]));
  });
  const thisYear = String(new Date().getFullYear());
  const yearList = [...years.keys()];
  // year-end (or latest) snapshot of each year = first of its group
  const yearEnd = new Map(yearList.map(y => [y, assets.find(a => a.date.startsWith(y))]));
  history.innerHTML = yearList.map((y, yi) => {
    const last = yearEnd.get(y);
    const prevYear = yearEnd.get(yearList[yi + 1]);
    const yoy = prevYear ? changeHtml(last.net_worth, prevYear.net_worth, true) : '';
    return `<details class="snap-year"${yi === 0 || y === thisYear ? ' open' : ''}>
      <summary>
        <span class="snap-year-label">${y}</span>
        <span class="snap-year-meta">${years.get(y).length} 筆 · ${y === thisYear ? '最新' : '年末'} ${fmtTWD(last.net_worth)}${yoy ? ` · 年增 ${yoy}` : ''}</span>
      </summary>
      ${years.get(y).join('')}
    </details>`;
  }).join('');
}

function syncSnapshotToggle() {
  const toggle = document.getElementById('snapshot-toggle');
  const open = !document.getElementById('snapshot-history').hidden;
  toggle.textContent = open ? '收合紀錄' : `全部紀錄（${_cachedAssets.length} 筆）`;
  toggle.setAttribute('aria-expanded', String(open));
}

function toggleSnapshotHistory() {
  const history = document.getElementById('snapshot-history');
  history.hidden = !history.hidden;
  syncSnapshotToggle();
}

/** Dashboard change cards: today's P&L, YTD, YTD change sources, XIRR. Formulas are in each label's tooltip in index.html. */
function renderDashChangeStats({ twHoldings, usHoldings, stockValue, xirr, year }) {
  const setPL = (id, n, text) => {
    const el = document.getElementById(id);
    el.className = 'stat-value ' + plClass(n);
    el.textContent = text;
  };
  const setSub = (id, html) => { document.getElementById(id).innerHTML = html; };

  // 1. Today's P&L
  const sumDay = list => list.reduce((s, h) => s + (h.day_change_twd || 0), 0);
  const twDay = sumDay(twHoldings);
  const usDay = sumDay(usHoldings);
  const dayPL = twDay + usDay;
  const prevValue = stockValue - dayPL;
  if (twHoldings.length || usHoldings.length) {
    setPL('dash-day-pl', dayPL, `${fmtPL(dayPL)}${prevValue > 0 ? ` (${fmtPct(dayPL / prevValue * 100)})` : ''}`);
    setSub('dash-day-pl-sub', `台股 <span class="${plClass(twDay)}">${fmtPL(twDay)}</span> · 美股 <span class="${plClass(usDay)}">${fmtPL(usDay)}</span>`);
  }

  // 2–3. This year (from /api/overview: base snapshot → today), split by source
  if (!year || !(year.start > 0)) {
    setSub('dash-ytd-sub', '需要至少一筆今年以前或今年的快照');
  } else {
    setPL('dash-ytd', year.change, `${fmtPL(year.change)} (${fmtPct(year.change / year.start * 100)})`);
    setSub('dash-ytd-sub', `基準 ${year.from} · ${fmtTWD(year.start)}`);
    setPL('dash-source', year.change, fmtPL(year.change));
    const parts = growthParts(year);
    const total = parts.reduce((s, p) => s + Math.abs(p.v), 0);
    document.getElementById('dash-source-bar').innerHTML = total > 0
      ? parts.map(p => `<span style="width:${Math.abs(p.v) / total * 100}%;background:${p.color}"></span>`).join('')
      : '';
    setSub('dash-source-sub', parts.map(p =>
      `<span><span class="legend-dot src-dot" style="background:${p.color}"></span>${p.label} ${fmtPL(p.v)}</span>`).join('<br>'));
    document.getElementById('dash-source').title = `${year.from} → ${year.to}`;
  }

  // 4. XIRR (cumulative since first trade)
  const all = xirr.ALL;
  if (all && all.xirr != null) {
    setPL('dash-xirr', all.xirr, fmtPct(all.xirr));
    setSub('dash-xirr-sub', `台股 ${xirrHtml(xirr.TW)} · 美股 ${xirrHtml(xirr.US)}<br>自 ${(all.first_date || '').slice(0, 7)} 起・年化`);
  }
}

// ============================================================
// SECTION: Asset Snapshots CRUD
// ============================================================

let _snapshotMode = 'auto'; // 'auto' or 'manual'

function setSnapshotMode(mode) {
  _snapshotMode = mode;
  const toggles = document.querySelectorAll('.snapshot-mode-toggle .toggle-sm');
  toggles.forEach(b => b.classList.toggle('active', b.textContent.includes(mode === 'auto' ? '自動' : '手動')));
  const manualFields = document.getElementById('snapshot-manual-fields');
  const autoInfo = document.getElementById('snapshot-auto-info');
  if (mode === 'manual') {
    manualFields.style.display = 'block';
    autoInfo.textContent = '手動模式：所有欄位由你自行填入';
  } else {
    manualFields.style.display = 'none';
    autoInfo.textContent = '系統將自動擷取：目前股票市值、USD/TWD 匯率';
  }
}

function openSnapshotModal() {
  const form = document.getElementById('snapshot-form');
  form.reset();
  form.querySelector('[name="id"]').value = '';
  form.querySelector('[name="date"]').value = todayStr();
  if (_carriedCash) { // the user corrects it to the real balance
    form.querySelector('[name="cash_twd"]').value = Math.max(0, Math.round(_carriedCash.twd));
    form.querySelector('[name="cash_usd"]').value = Math.max(0, Math.round(_carriedCash.usd * 100) / 100);
  }
  document.getElementById('snapshot-modal-title').textContent = '新增資產快照';
  setSnapshotMode('auto');
  document.getElementById('snapshot-cash-hint').hidden = !_carriedCash;
  openModal('modal-snapshot');
}

function editSnapshot(id) {
  const a = _cachedAssets.find(x => x.id === id);
  if (!a) return;
  const form = document.getElementById('snapshot-form');
  form.querySelector('[name="id"]').value = a.id;
  form.querySelector('[name="date"]').value = a.date;
  form.querySelector('[name="cash_twd"]').value = a.cash_twd || 0;
  form.querySelector('[name="cash_usd"]').value = a.cash_usd || 0;
  form.querySelector('[name="stock_tw_value"]').value = a.stock_tw_value || 0;
  form.querySelector('[name="stock_us_value"]').value = a.stock_us_value || 0;
  form.querySelector('[name="usd_twd_rate"]').value = a.usd_twd_rate || 0;
  form.querySelector('[name="total_asset_override"]').value = '';
  form.querySelector('[name="note"]').value = a.note || '';
  document.getElementById('snapshot-modal-title').textContent = '編輯資產快照';
  setSnapshotMode('manual'); // editing always shows all fields
  document.getElementById('snapshot-cash-hint').hidden = true;
  openModal('modal-snapshot');
}

async function submitSnapshot(e) {
  e.preventDefault();
  const form = e.target;
  const id = form.querySelector('[name="id"]').value;
  const data = {
    date: form.querySelector('[name="date"]').value,
    cash_twd: Number(form.querySelector('[name="cash_twd"]').value),
    cash_usd: Number(form.querySelector('[name="cash_usd"]').value),
    note: form.querySelector('[name="note"]').value,
  };

  // Manual mode: include stock value, rate, and optional total override
  if (_snapshotMode === 'manual') {
    const twInput = form.querySelector('[name="stock_tw_value"]').value;
    const usInput = form.querySelector('[name="stock_us_value"]').value;
    const rateInput = form.querySelector('[name="usd_twd_rate"]').value;
    const totalInput = form.querySelector('[name="total_asset_override"]').value;
    if (twInput) data.stock_tw_value = Number(twInput);
    if (usInput) data.stock_us_value = Number(usInput);
    if (twInput || usInput) data.stock_value_twd = (Number(twInput) || 0) + (Number(usInput) || 0);
    if (rateInput) data.usd_twd_rate = Number(rateInput);
    if (totalInput) data.total_asset = Number(totalInput);
  }

  try {
    if (id) {
      await api(`/api/assets/${id}`, { method: 'PUT', body: JSON.stringify(data) });
      showToast('快照已更新', 'success');
    } else {
      const msg = _snapshotMode === 'auto' ? '快照已新增（股票市值已自動擷取）' : '快照已新增（手動填入）';
      await api('/api/assets', { method: 'POST', body: JSON.stringify(data) });
      showToast(msg, 'success');
    }
    closeModal('modal-snapshot');
    loadDashboard();
  } catch (err) {
    showToast('儲存失敗: ' + err.message, 'error');
  }
}

async function deleteSnapshot(id) {
  if (!confirm('確定要刪除此快照嗎？')) return;
  try {
    await api(`/api/assets/${id}`, { method: 'DELETE' });
    showToast('快照已刪除', 'success');
    loadDashboard();
  } catch (err) {
    showToast('刪除失敗: ' + err.message, 'error');
  }
}

// ============================================================
// SECTION: Stock Holdings
// ============================================================

// Dividends received per symbol (native currency), loaded alongside holdings
let _divBySymbol = {};

// Table or card view of the holdings ('table' | 'cards'), remembered on this device
function setHoldingsView(view, save = true) {
  if (save) try { localStorage.setItem('holdingsView', view); } catch (e) { /* ignore */ }
  document.querySelector('.holdings-table').classList.toggle('as-cards', view === 'cards');
  document.querySelectorAll('#holdings-view .chart-type-btn').forEach(b => b.classList.toggle('active', b.dataset.view === view));
}

function initHoldingsView() {
  let saved = null;
  try { saved = localStorage.getItem('holdingsView'); } catch (e) { /* ignore */ }
  // Until chosen: cards on phones (same breakpoint as the CSS phone layout)
  setHoldingsView(saved || (matchMedia('(max-width: 599px)').matches ? 'cards' : 'table'), false);
}

// Total return incl. dividends, and yield on price / on cost (trailing 12 months of recorded dividends)
function divMetrics(pl, cost, mv, div) {
  const total = div ? div.total : 0;
  const ttm = div ? div.ttm : 0;
  return {
    total,
    ret: cost > 0 ? ((pl + total) / cost) * 100 : null,
    yieldPrice: mv > 0 && ttm > 0 ? (ttm / mv) * 100 : null,
    yieldCost: cost > 0 && ttm > 0 ? (ttm / cost) * 100 : null,
  };
}

const fmtYield = (v) => (v == null ? '--' : `${fmtNum(v, 2)}%`);

// Three cells: dividends (+ total return incl. dividends underneath), yield on price, yield on cost
function divCells(m, cur) {
  const divTxt = m.total ? fmtCur(m.total, cur) : '--';
  const retTxt = m.ret == null ? '--' : fmtPct(m.ret);
  return `
      <td class="c-div">${divTxt}<span class="cell-sub ${plClass(m.ret)}">${retTxt}</span></td>
      <td class="c-yp">${fmtYield(m.yieldPrice)}</td>
      <td class="c-yc">${fmtYield(m.yieldCost)}</td>`;
}

// Unrealized P&L amount with its % underneath
function plCell(pl, pct, cur) {
  return `<td class="c-pl ${plClass(pl)}">${fmtPLCur(pl, cur)}<span class="cell-sub">${fmtPct(pct)}</span></td>`;
}

// Today's change in the 現價 column of subtotal/total rows: amount with % vs previous close underneath
function dayChangeCell(chg, mv, cur, strong) {
  const prev = mv - chg;
  const amt = `今日 ${fmtPLCur(chg, cur)}`;
  return `<td class="c-day ${plClass(chg)}" title="較前一交易日收盤">${strong ? `<strong>${amt}</strong>` : amt}` +
    `<span class="cell-sub">${prev > 0 ? fmtPct(chg / prev * 100) : '--'}</span></td>`;
}


/**
 * The stock's page on Google Finance. Listed Taiwan stocks are CODE:TPE; Google has no
 * 上櫃 (.TWO) quotes, and a US quote needs the exchange (from the Yahoo quote), so those
 * fall back to a Google search, which shows the price card.
 */
function quoteURL(s) {
  const code = s.symbol.replace(/\.TWO?$/, '');
  if (s.symbol.endsWith('.TW')) return `https://www.google.com/finance/quote/${encodeURIComponent(code)}:TPE`;
  if (s.market === 'US' && s.exchange) return `https://www.google.com/finance/quote/${encodeURIComponent(code)}:${s.exchange}`;
  return `https://www.google.com/search?q=${encodeURIComponent(`${code} 股價`)}`;
}

function renderHoldingRow(s) {
  const cur = s.currency;
  const costNative = (s.avg_cost || 0) * (s.shares || 0);
  const dm = divMetrics(s.unrealized_pl || 0, costNative, s.market_value || 0, _divBySymbol[s.symbol]);
  return `
    <tr>
      <td class="c-sym"><a class="sym-link" href="${quoteURL(s)}" target="_blank" rel="noopener" title="在 Google 財經查看"><strong>${s.symbol || '--'}</strong></a></td>
      <td class="c-sh">${fmt(s.shares)}<span class="cell-sub">均價 ${fmtPrice(s.avg_cost, cur)}</span></td>
      <td class="c-cost">${fmtCur(costNative, cur)}</td>
      <td class="c-px">${fmtPrice(s.current_price, cur)}${s.current_price ? `<span class="cell-sub ${plClass(s.day_change_pct)}" title="較前一交易日收盤">${fmtPct(s.day_change_pct)}</span>` : ''}</td>
      <td class="c-mv">${fmtCur(s.market_value, cur)}</td>
      ${plCell(s.unrealized_pl, s.pl_percent, cur)}${divCells(dm, cur)}
      <td class="c-act action-buttons">
        ${['BUY', 'SELL'].map(side => `<button type="button" class="btn ${side === 'BUY' ? 'btn-buy' : 'btn-sell'} btn-sm" onclick="openTradeModal('${side}', '${s.symbol}', '${s.market}', '${s.currency}', ${s.shares}, ${s.current_price || 0})">${side === 'BUY' ? '買' : '賣'}</button>`).join('')}
        ${rowBtn('delete', `deleteHolding(${s.id})`, '刪除持倉')}
      </td>
    </tr>
  `;
}

async function loadHoldings() {
  try {
    const [stockData, divData] = await Promise.all([
      api('/api/stocks'),
      api('/api/dividends/by-symbol').catch(() => ({ items: [], usd_twd_rate: 32 })),
    ]);
    _divBySymbol = {};
    (divData.items || []).forEach(d => { _divBySymbol[d.symbol] = d; });
    const list = (stockData && stockData.holdings) ? stockData.holdings : [];
    const tbody = document.getElementById('holdings-body');
    const tfoot = document.getElementById('holdings-foot');

    if (list.length === 0) {
      tbody.innerHTML = '<tr><td colspan="10" class="empty-state">尚無持倉資料</td></tr>';
      tfoot.style.display = 'none';
      return;
    }

    const subtotal = (rows) => {
      const cost = rows.reduce((sum, s) => sum + (s.avg_cost || 0) * (s.shares || 0), 0);
      const mv = rows.reduce((sum, s) => sum + (s.market_value || 0), 0);
      const pl = rows.reduce((sum, s) => sum + (s.unrealized_pl || 0), 0);
      const pct = cost > 0 ? (pl / cost) * 100 : 0;
      // Native-currency day change, from each holding's market value and % vs previous close
      const day = rows.reduce((sum, s) => {
        const p = s.day_change_pct || 0;
        return sum + (s.market_value || 0) * p / (100 + p);
      }, 0);
      // Dividends of the symbols in this group, same currency as the group
      const div = { total: 0, ttm: 0 };
      rows.forEach(s => {
        const d = _divBySymbol[s.symbol];
        if (d) { div.total += d.total; div.ttm += d.ttm; }
      });
      return { cost, mv, pl, pct, day, dm: divMetrics(pl, cost, mv, div) };
    };

    const groups = [
      { market: 'US', label: '\u{1F1FA}\u{1F1F8} 美股', subtotalLabel: '美股小計', cur: 'USD' },
      { market: 'TW', label: '\u{1F1F9}\u{1F1FC} 台股', subtotalLabel: '台股小計', cur: 'TWD' },
    ];
    tbody.innerHTML = groups.map(g => {
      const rows = list.filter(s => s.market === g.market);
      if (rows.length === 0) return '';
      const t = subtotal(rows);
      return `<tr class="market-group-header"><td colspan="10">${g.label}</td></tr>` +
        rows.map(renderHoldingRow).join('') +
        `<tr class="market-subtotal"><td colspan="2" class="c-sym">${g.subtotalLabel}</td><td class="c-cost">${fmtCur(t.cost, g.cur)}</td>${dayChangeCell(t.day, t.mv, g.cur)}<td class="c-mv">${fmtCur(t.mv, g.cur)}</td>${plCell(t.pl, t.pct, g.cur)}${divCells(t.dm, g.cur)}<td></td></tr>`;
    }).join('');

    // TWD footer: USD dividends converted at the stored rate
    const rate = divData.usd_twd_rate || 32;
    const divTwd = { total: 0, ttm: 0 };
    (divData.items || []).forEach(d => {
      divTwd.total += toTWD(d.total, d.currency, rate);
      divTwd.ttm += toTWD(d.ttm, d.currency, rate);
    });
    const totalDm = divMetrics(stockData.total_pl_twd, stockData.total_cost_twd, stockData.total_value_twd, divTwd);
    document.getElementById('total-div').innerHTML = `<strong>${totalDm.total ? fmtTWD(totalDm.total) : '--'}</strong>`;
    document.getElementById('total-div-return').innerHTML =
      `<strong class="${plClass(totalDm.ret)}">${totalDm.ret == null ? '--' : fmtPct(totalDm.ret)}</strong>`;
    document.getElementById('total-yield-price').innerHTML = `<strong>${fmtYield(totalDm.yieldPrice)}</strong>`;
    document.getElementById('total-yield-cost').innerHTML = `<strong>${fmtYield(totalDm.yieldCost)}</strong>`;

    document.getElementById('total-cost').innerHTML = `<strong>${fmtTWD(stockData.total_cost_twd)}</strong>`;
    const dayTwd = list.reduce((sum, s) => sum + (s.day_change_twd || 0), 0);
    document.getElementById('total-day-change').outerHTML =
      dayChangeCell(dayTwd, stockData.total_value_twd, 'TWD', true).replace('<td ', '<td id="total-day-change" ');
    document.getElementById('total-market-value').innerHTML = `<strong>${fmtTWD(stockData.total_value_twd)}</strong>`;
    document.getElementById('total-unrealized-pl').innerHTML = `<strong class="${plClass(stockData.total_pl_twd)}">${fmtPL(stockData.total_pl_twd)}</strong>`;
    document.getElementById('total-pl-pct').innerHTML = `<strong class="${plClass(stockData.total_pl_percent)}">${fmtPct(stockData.total_pl_percent)}</strong>`;
    tfoot.style.display = '';

    // Show quote fetch time
    const fetchedEl = document.getElementById('quote-fetched-at');
    if (fetchedEl && stockData.quote_fetched_at) {
      fetchedEl.textContent = `報價更新: ${stockData.quote_fetched_at}`;
    }

  } catch (err) {
    showToast('載入持倉失敗: ' + err.message, 'error');
  }
}

function openHoldingModal() {
  const form = document.getElementById('holding-form');
  form.reset();
  // Default to TW
  form.querySelector('[name="market"]').value = 'TW';
  onHoldingMarketChange(form.querySelector('[name="market"]'));
  openModal('modal-holding');
}

function onHoldingMarketChange(select) {
  const market = select.value;
  const symbolInput = select.form.querySelector('[name="symbol"]');
  const hint = document.getElementById('holding-symbol-hint');
  const currLabel = document.getElementById('holding-currency-label');

  if (market === 'TW') {
    symbolInput.placeholder = '輸入股票代號，例如 2330';
    hint.textContent = '台股輸入代號即可（如 2330），系統自動加上 .TW';
    currLabel.textContent = 'TWD';
  } else {
    symbolInput.placeholder = '輸入股票代號，例如 AAPL';
    hint.textContent = '美股直接輸入代號（如 AAPL、NVDA）';
    currLabel.textContent = 'USD';
  }
}

async function submitHolding(e) {
  e.preventDefault();
  const form = e.target;
  const market = form.querySelector('[name="market"]').value;
  let symbol = form.querySelector('[name="symbol"]').value.trim().toUpperCase();

  // Auto-append .TW for Taiwan stocks if not already present
  if (market === 'TW' && !symbol.endsWith('.TW') && !symbol.endsWith('.TWO')) {
    symbol = symbol + '.TW';
  }

  const data = {
    symbol,
    market,
    shares: Number(form.querySelector('[name="shares"]').value),
    avg_cost: Number(form.querySelector('[name="avg_cost"]').value),
    currency: market === 'US' ? 'USD' : 'TWD',
    date: form.querySelector('[name="date"]').value || '',
  };

  try {
    await api('/api/stocks', { method: 'POST', body: JSON.stringify(data) });
    showToast('持倉已匯入（含買入交易紀錄）', 'success');
    closeModal('modal-holding');
    loadHoldings();
    loadTransactions();
  } catch (err) {
    showToast('新增失敗: ' + err.message, 'error');
  }
}

async function deleteHolding(id) {
  if (!confirm('確定要刪除此持倉嗎？\n\n這會一併刪除該股票的「買入」交易紀錄（否則持倉會在下次重算時復活）。\n已實現損益的「賣出」紀錄會保留。')) return;
  try {
    await api(`/api/stocks/${id}`, { method: 'DELETE' });
    showToast('持倉已刪除', 'success');
    loadHoldings();
    loadTransactions();
    loadXirr();
  } catch (err) {
    showToast('刪除失敗: ' + err.message, 'error');
  }
}

async function refreshStockPrices() {
  const btn = document.querySelector('[onclick="refreshStockPrices()"]');
  btn.classList.add('refreshing');
  btn.disabled = true;
  try {
    // Clear server cache first, then reload
    await api('/api/stocks/refresh', { method: 'POST' });
    await loadHoldings();
    showToast('報價已強制更新', 'success');
  } catch (err) {
    showToast('更新報價失敗: ' + err.message, 'error');
  } finally {
    btn.classList.remove('refreshing');
    btn.disabled = false;
  }
}

// ============================================================
// SECTION: Realized P&L Summary
// ============================================================

let _rplData = null; // cached realized P&L data
let _rplFilter = 'ALL';
let _rplYear = 'ALL';
let _rplYears = [];

async function loadRealizedSummary() {
  try {
    const q = _rplYear === 'ALL' ? '' : '?year=' + _rplYear;
    _rplData = await api('/api/transactions/summary' + q);
    // Year list comes from the server unfiltered, so keep it when a year is selected
    if (_rplYear === 'ALL' || _rplYears.length === 0) _rplYears = _rplData.years || [];
    renderRplYearButtons();
    renderRealizedSummary();
  } catch (err) {
    showToast('載入已實現損益失敗: ' + err.message, 'error');
  }
}

function renderRplYearButtons() {
  const el = document.getElementById('rpl-year-filter');
  if (!el) return;
  const items = ['ALL', ..._rplYears];
  el.innerHTML = items.map(y =>
    `<button class="rpl-filter-btn${y === _rplYear ? ' active' : ''}" onclick="filterRealizedYear('${y}')">${y === 'ALL' ? '全部年度' : y}</button>`
  ).join('');
}

function filterRealizedYear(year) {
  _rplYear = year;
  loadRealizedSummary();
}

function filterRealizedPL(market) {
  _rplFilter = market;
  // Update button states
  document.querySelectorAll('.rpl-filter-btn[data-market]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.market === market);
  });
  renderRealizedSummary();
}

function renderRealizedSummary() {
  if (!_rplData) return;

  const allStocks = _rplData.by_stock || [];
  const stocks = _rplFilter === 'ALL' ? allStocks : allStocks.filter(s => s.market === _rplFilter);

  // Recalculate stats for filtered data
  let totalTrades = 0, winTrades = 0, loseTrades = 0;
  let totalPLTwd = 0, totalCostTwd = 0;
  let bestTrade = null, worstTrade = null;

  // We need the exchange rate for USD→TWD conversion
  const rate = _rplData.overall?.usd_twd_rate || 32;

  stocks.forEach(s => {
    totalTrades += s.total_trades;
    // Count wins/losses per stock (approximate: if total_realized_pl > 0, consider trades mostly winning)
    // Better: use per-trade data. For now, estimate from avg.
    const plTwd = toTWD(s.total_realized_pl, s.currency, rate);
    totalPLTwd += plTwd;
    totalCostTwd += toTWD(s.total_cost, s.currency, rate);

    // null: every sale of this stock had no real cost (配股), so there is no % to compare
    if (s.best_trade_pct != null && (!bestTrade || s.best_trade_pct > bestTrade.pct)) {
      bestTrade = { symbol: s.symbol, pct: s.best_trade_pct };
    }
    if (s.worst_trade_pct != null && (!worstTrade || s.worst_trade_pct < worstTrade.pct)) {
      worstTrade = { symbol: s.symbol, pct: s.worst_trade_pct };
    }
  });

  // Use overall win/lose if showing all, otherwise estimate
  let flatTrades = 0;
  if (_rplFilter === 'ALL' && _rplData.overall) {
    winTrades = _rplData.overall.winning_trades || 0;
    loseTrades = _rplData.overall.losing_trades || 0;
    flatTrades = _rplData.overall.flat_trades || 0;
  } else {
    // Estimate: count stocks with positive vs negative total P&L (rough)
    stocks.forEach(s => {
      if (s.total_realized_pl > 0) winTrades += s.total_trades;
      else if (s.total_realized_pl < 0) loseTrades += s.total_trades;
      else flatTrades += s.total_trades;
    });
  }

  const winRate = totalTrades > 0 ? (winTrades / totalTrades) * 100 : 0;

  // Render stats cards
  const totalPct = totalCostTwd > 0 ? (totalPLTwd / totalCostTwd) * 100 : 0;
  document.getElementById('rpl-total').innerHTML =
    `<span class="${plClass(totalPLTwd)}">${fmtTWD(totalPLTwd)}</span> ` +
    `<span class="${plClass(totalPct)}" style="font-size:0.6em">(${fmtPct(totalPct)})</span>`;
  document.getElementById('rpl-trades').textContent =
    `${totalTrades} 筆 (勝${winTrades}/負${loseTrades}${flatTrades ? '/平' + flatTrades : ''})`;
  document.getElementById('rpl-winrate').textContent =
    `${winRate.toFixed(1)}%`;

  const divTwd = (_rplData.dividends || [])
    .filter(d => _rplFilter === 'ALL' || d.market === _rplFilter)
    .reduce((sum, d) => sum + toTWD(d.total, d.currency, rate), 0);
  document.getElementById('rpl-div').innerHTML = divTwd ? `<span class="positive">${fmtTWD(divTwd)}</span>` : '--';
  const withDiv = totalPLTwd + divTwd;
  document.getElementById('rpl-total-div').innerHTML =
    `<span class="${plClass(withDiv)}">${fmtTWD(withDiv)}</span>`;

  if (bestTrade) {
    document.getElementById('rpl-best').innerHTML =
      `${bestTrade.symbol} <span class="${plClass(bestTrade.pct)}">${fmtPct(bestTrade.pct)}</span>`;
  } else {
    document.getElementById('rpl-best').textContent = '--';
  }

  // Render table
  const tbody = document.getElementById('rpl-stock-body');
  if (stocks.length === 0) {
    tbody.innerHTML = '<tr><td colspan="10" class="empty-state">此分類無已實現損益紀錄</td></tr>';
    document.getElementById('rpl-stock-total-pl').textContent = '--';
    document.getElementById('rpl-stock-avg-return').textContent = '--';
    return;
  }

  tbody.innerHTML = stocks.map(s => {
    const fc = s.currency === 'TWD' ? fmtTWD : fmtUSD;
    return `
      <tr>
        <td><strong>${s.symbol}</strong></td>
        <td>${s.market === 'TW' ? '台股' : '美股'}</td>
        <td>${s.total_trades}</td>
        <td>${fmt(s.total_shares_sold)}</td>
        <td>${fc(s.total_revenue)}</td>
        <td>${fc(s.total_cost)}</td>
        <td class="${plClass(s.total_realized_pl)}"><strong>${fc(s.total_realized_pl)}</strong></td>
        <td class="${plClass(s.avg_return_pct)}">${fmtPct(s.avg_return_pct)}</td>
        <td class="${plClass(s.best_trade_pct)}">${fmtPct(s.best_trade_pct)}</td>
        <td class="${plClass(s.worst_trade_pct)}">${fmtPct(s.worst_trade_pct)}</td>
      </tr>
    `;
  }).join('');

  // Footer totals
  document.getElementById('rpl-stock-total-pl').innerHTML =
    `<strong class="${plClass(totalPLTwd)}">${fmtTWD(totalPLTwd)}</strong>`;

  document.getElementById('rpl-stock-avg-return').innerHTML =
    `<strong class="${plClass(totalPct)}">${fmtPct(totalPct)}</strong>`;
}

// ============================================================
// SECTION: Transactions
// ============================================================

async function submitTransaction(e) {
  e.preventDefault();
  const form = e.target;
  const data = {
    symbol: form.querySelector('[name="symbol"]').value.trim().toUpperCase(),
    action: form.querySelector('[name="action"]').value,
    shares: Number(form.querySelector('[name="shares"]').value),
    price: Number(form.querySelector('[name="price"]').value),
    fee: Number(form.querySelector('[name="fee"]').value) || 0,
    tax: Number(form.querySelector('[name="tax"]').value) || 0,
    auto_fee: form.querySelector('[name="auto_fee"]').checked,
    date: form.querySelector('[name="date"]').value,
    note: form.querySelector('[name="note"]').value,
  };

  const editId = form.dataset.editId;

  try {
    let result;
    if (editId) {
      // Edit mode - PUT
      data.market = form.dataset.editMarket || 'US';
      data.realized_pl = Number(form.dataset.editRealizedPl) || 0;
      result = await api(`/api/transactions/${editId}`, { method: 'PUT', body: JSON.stringify(data) });
      showToast('交易已更新', 'success');
      showLedgerWarnings(result);
      cancelTransactionEdit();
    } else {
      // New transaction - POST
      result = await api('/api/transactions', { method: 'POST', body: JSON.stringify(data) });
      showToast('交易已記錄', 'success');

      // Show realized P&L for sell transactions
      const resultBox = document.getElementById('tx-result');
      if (data.action === 'SELL' && result && result.realized_pl != null) {
        resultBox.style.display = 'block';
        resultBox.className = 'tx-result-box success';
        resultBox.innerHTML = `賣出完成！已實現損益: <strong class="${plClass(result.realized_pl)}">${fmtTWD(result.realized_pl)}</strong>`;
        setTimeout(() => { resultBox.style.display = 'none'; }, 8000);
      } else {
        resultBox.style.display = 'block';
        resultBox.className = 'tx-result-box info';
        resultBox.textContent = '買入交易已記錄';
        setTimeout(() => { resultBox.style.display = 'none'; }, 4000);
      }

      form.reset();
      form.querySelector('[name="date"]').value = todayStr();
    }

    loadTransactions();
    loadHoldings();
    loadRealizedSummary();
  } catch (err) {
    showToast('交易記錄失敗: ' + err.message, 'error');
  }
}

async function loadTransactions() {
  try {
    let url = '/api/transactions';
    const params = new URLSearchParams();
    const sym = document.getElementById('tx-filter-symbol').value.trim();
    const start = document.getElementById('tx-filter-start').value;
    const end = document.getElementById('tx-filter-end').value;
    if (sym) params.set('symbol', sym);
    if (start) params.set('from', start);
    if (end) params.set('to', end);
    const qs = params.toString();
    if (qs) url += '?' + qs;

    const transactions = await api(url);
    const list = Array.isArray(transactions) ? transactions : [];
    const tbody = document.getElementById('tx-body');

    if (list.length === 0) {
      tbody.innerHTML = '<tr><td colspan="10" class="empty-state">尚無交易紀錄</td></tr>';
      document.getElementById('cumulative-realized-pl').textContent = '--';
      return;
    }

    let cumPL = 0;
    tbody.innerHTML = list.map(t => {
      if (t.realized_pl) cumPL += t.realized_pl;
      const escaped = (s) => (s || '').replace(/'/g, "\\'").replace(/"/g, '&quot;');
      return `
        <tr>
          <td>${t.date || '--'}</td>
          <td><strong>${t.symbol || '--'}</strong></td>
          <td><span class="${t.action === 'BUY' ? 'tag-buy' : 'tag-sell'}">${t.action === 'BUY' ? '買' : '賣'}</span></td>
          <td>${fmt(t.shares)}</td>
          <td>${fmtNum(t.price, 2)}</td>
          <td>${fmt(t.fee, 0)}</td>
          <td>${t.tax ? fmt(t.tax, 0) : '--'}</td>
          <td class="${plClass(t.realized_pl)}">${t.realized_pl ? fmtPL(t.realized_pl) : '--'}</td>
          <td>${t.note || ''}</td>
          <td>
            ${rowBtn('edit', `editTransaction(${t.id}, '${escaped(t.symbol)}', '${t.market}', '${t.action}', ${t.shares}, ${t.price}, ${t.fee || 0}, '${t.date}', '${escaped(t.note)}', ${t.realized_pl || 0}, ${t.tax || 0})`)}
            ${rowBtn('delete', `deleteTransaction(${t.id})`)}
          </td>
        </tr>
      `;
    }).join('');

    const plEl = document.getElementById('cumulative-realized-pl');
    plEl.textContent = fmtTWD(cumPL);
    plEl.className = plClass(cumPL);

  } catch (err) {
    showToast('載入交易紀錄失敗: ' + err.message, 'error');
  }
}

// ============================================================
// SECTION: Portfolio Analysis
// ============================================================

const MKT = { TW: { cls: 'tw', short: '台', label: '台股' }, US: { cls: 'us', short: '美', label: '美股' } };
const CONCENTRATION = { warn: ['偏高', 'risk-warn'], danger: ['高度集中', 'risk-danger'] };

/** 組合分析: numbers come from /api/stocks/portfolio (js/server/portfolio.js); this only renders. */
async function loadPortfolioAnalysis() {
  try {
    const p = await api('/api/stocks/portfolio');
    if (!p) {
      document.getElementById('pf-weights').innerHTML = '<div class="empty-state">尚無持股（或還沒抓到報價）</div>';
      return;
    }
    renderPortfolioStats(p);
    renderPortfolioWeights(p.rows);
    renderRebalance(p);
  } catch (err) {
    showToast('載入投資組合分析失敗: ' + err.message, 'error');
  }
}

function renderPortfolioStats(p) {
  const top = p.rows[0];
  const set = (id, text, sub, cls = '') => {
    const el = document.getElementById(id);
    el.textContent = text;
    el.className = 'stat-value ' + cls;
    document.getElementById(id + '-sub').innerHTML = sub;
  };
  set('pf-top', `${top.weight.toFixed(1)}%`,
    `${escapeHtml(top.symbol)}${p.rows.length > 3 ? ` · 前 3 大 ${p.top3.toFixed(1)}%` : ''}`,
    top.level ? CONCENTRATION[top.level][1] : '');
  set('pf-effective', `${p.effective.toFixed(1)} 檔`, `實際持有 ${p.rows.length} 檔；越小越集中`);
  const usdTotal = p.usd.stock + (p.usd.cash || 0);
  set('pf-usd', p.usd.pct == null ? '--' : `${p.usd.pct.toFixed(1)}%`,
    `淨資產中美金計價的比例<br>美股 ${fmtTWD(p.usd.stock)}${p.usd.cash == null ? '（尚無快照，只算股票）' : ` ＋ 美金現金 ${fmtTWD(p.usd.cash)}`}<br>台幣升值 1% ≈ ${fmtPL(-usdTotal / 100)}`);
  const d = p.dividends;
  set('pf-div', fmtTWD(d.ttm), d.ttm > 0 ? `月均 ${fmtTWD(d.ttm / 12)} · 殖利率 ${fmtYield(d.yield_cost)}` : '近 12 個月沒有股利紀錄');
}

/** Bar = weight now, tick = weight at cost; bars scale to the heaviest so small ones stay visible. */
function renderPortfolioWeights(rows) {
  const scale = Math.max(...rows.map(r => Math.max(r.weight, r.cost_weight)));
  document.getElementById('pf-weights').innerHTML = rows.map(r => {
    const mkt = MKT[r.market] || MKT.US;
    const flag = CONCENTRATION[r.level];
    const drift = r.weight - r.cost_weight;
    const sub = [
      `成本時 ${r.cost_weight.toFixed(1)}%${Math.abs(drift) >= 0.1 ? ` <span class="${plClass(drift)}">${drift > 0 ? '↑' : '↓'}${Math.abs(drift).toFixed(1)}</span>` : ''}`,
      `損益 <span class="${plClass(r.pl)}">${fmtPL(r.pl)}${r.pl_percent ? ` (${fmtPct(r.pl_percent)})` : ''}</span>`,
      r.yield_cost != null ? `殖利率 ${fmtYield(r.yield_cost)}` : '',
    ].filter(Boolean).join(' · ');
    return `<div class="pf-row pf-mkt-${mkt.cls}">
      <div class="pf-row-head">
        <span class="pf-sym">${escapeHtml(r.symbol)}</span>
        <span class="pf-mkt">${mkt.short}</span>
        ${flag ? `<span class="pf-flag ${flag[1]}">${flag[0]}</span>` : ''}
        <span class="pf-weight">${r.weight.toFixed(1)}%</span>
      </div>
      <div class="pf-bar" aria-hidden="true">
        <span class="source-bar cat-track"><span style="width:${r.weight / scale * 100}%"></span></span>
        <span class="pf-bar-cost" style="left:${r.cost_weight / scale * 100}%"></span>
      </div>
      <div class="pf-row-sub">${sub}</div>
    </div>`;
  }).join('');
}

/** TW/US split bar and how to reach the target TW share. */
function renderRebalance(p) {
  const { tw, us } = p.split;
  const twPct = tw / (tw + us) * 100;
  document.getElementById('pf-split').innerHTML = `
    <div class="source-bar pf-split-bar" aria-hidden="true">
      <span class="pf-mkt-tw" style="width:${twPct}%"></span><span class="pf-mkt-us" style="width:${100 - twPct}%"></span>
    </div>
    <div class="pf-split-legend">
      <span>台股 ${twPct.toFixed(1)}% · ${fmtTWD(tw)}</span><span>美股 ${(100 - twPct).toFixed(1)}% · ${fmtTWD(us)}</span>
    </div>`;
  _savedRebalanceTarget = p.target_tw == null ? '' : String(p.target_tw);
  document.getElementById('pf-target-tw').value = _savedRebalanceTarget;

  const r = p.rebalance;
  const out = document.getElementById('pf-rebalance');
  if (!r) {
    out.innerHTML = '<p class="form-hint">填一個目標比例（例如台股 60%），算出要怎麼買才會回到目標。</p>';
  } else if (r.in_range) {
    out.innerHTML = `<p>目前已在目標（台股 ${r.target}%／美股 ${100 - r.target}%）的 1% 以內，不用動。</p>`;
  } else {
    const under = MKT[r.under].label;
    const over = MKT[r.under === 'TW' ? 'US' : 'TW'].label;
    out.innerHTML = `
      <p>目標 台股 ${r.target}%／美股 ${100 - r.target}%，目前${under}偏低：</p>
      <ul class="pf-rebalance-list">
        <li><strong>只用買的：</strong>${under}再買 ${r.buy_only == null ? '--（目標 100% 只能靠賣出）' : fmtTWD(r.buy_only)}</li>
        <li><strong>用換的：</strong>賣出${over} ${fmtTWD(r.switch)}，換成${under}</li>
      </ul>
      <p class="form-hint">只看股票市值，不含現金；手續費、稅與匯差另計。</p>`;
  }
}

let _savedRebalanceTarget = null;
async function saveRebalanceTarget(v) {
  const n = v === '' ? '' : String(Math.min(100, Math.max(0, Number(v))));
  if (n === _savedRebalanceTarget) return; // spinner clicks fire change per step
  _savedRebalanceTarget = n;
  try {
    await api('/api/settings', { method: 'PUT', body: JSON.stringify({ rebalance_target_tw: n }) });
    loadPortfolioAnalysis(); // quotes are cached, so this only recomputes
  } catch (err) {
    showToast('儲存目標比例失敗: ' + err.message, 'error');
  }
}

// ============================================================
// SECTION: Trade Modal (Buy/Sell from Holdings)
// ============================================================

function openTradeModal(action, symbol, market, currency, currentShares, currentPrice) {
  const form = document.getElementById('trade-form');
  form.reset();
  form.querySelector('[name="action"]').value = action;
  form.querySelector('[name="symbol"]').value = symbol;
  form.querySelector('[name="market"]').value = market;
  form.querySelector('[name="date"]').value = todayStr();

  // Pre-fill current price
  if (currentPrice > 0) {
    form.querySelector('[name="price"]').value = currentPrice;
  }

  const title = document.getElementById('trade-modal-title');
  const submitBtn = document.getElementById('trade-submit-btn');
  const currLabel = document.getElementById('trade-currency-label');
  const info = document.getElementById('trade-stock-info');

  currLabel.textContent = currency || 'USD';

  if (action === 'BUY') {
    title.textContent = `買入 ${symbol}`;
    submitBtn.textContent = '確認買入';
    submitBtn.className = 'btn btn-buy';
    info.innerHTML = `<strong>${symbol}</strong> 目前持有 ${fmt(currentShares)} 股`;
  } else {
    title.textContent = `賣出 ${symbol}`;
    submitBtn.textContent = '確認賣出';
    submitBtn.className = 'btn btn-sell';
    info.innerHTML = `<strong>${symbol}</strong> 目前持有 <strong>${fmt(currentShares)} 股</strong>（可賣出上限）`;
    form.querySelector('[name="shares"]').max = currentShares;
  }

  document.getElementById('trade-result').style.display = 'none';
  openModal('modal-trade');
}

async function submitTrade(e) {
  e.preventDefault();
  const form = e.target;
  const market = form.querySelector('[name="market"]').value;
  const data = {
    symbol: form.querySelector('[name="symbol"]').value,
    market,
    action: form.querySelector('[name="action"]').value,
    shares: Number(form.querySelector('[name="shares"]').value),
    price: Number(form.querySelector('[name="price"]').value),
    fee: Number(form.querySelector('[name="fee"]').value) || 0,
    auto_fee: form.querySelector('[name="auto_fee"]').checked,
    currency: market === 'TW' ? 'TWD' : 'USD',
    date: form.querySelector('[name="date"]').value,
    note: form.querySelector('[name="note"]').value,
  };

  try {
    const result = await api('/api/transactions', { method: 'POST', body: JSON.stringify(data) });

    const resultBox = document.getElementById('trade-result');
    if (data.action === 'SELL' && result && result.realized_pl != null) {
      resultBox.style.display = 'block';
      resultBox.className = 'tx-result-box success';
      resultBox.innerHTML = `賣出完成！已實現損益: <strong class="${plClass(result.realized_pl)}">${fmtTWD(result.realized_pl)}</strong>`;
      showToast(`${data.symbol} 賣出 ${data.shares} 股完成`, 'success');
    } else {
      showToast(`${data.symbol} 買入 ${data.shares} 股完成`, 'success');
      closeModal('modal-trade');
    }

    loadHoldings();
    loadTransactions();
    loadRealizedSummary();
    loadXirr();
  } catch (err) {
    showToast('交易失敗: ' + err.message, 'error');
  }
}

// ---- Shared edit mode for forms that double as "add" and "edit" ----
// Fills the named fields, remembers the record id (plus any extra edit*
// dataset entries), relabels submit and adds a cancel button.
function enterEditMode(form, { id, values, extra = {}, submitLabel, onCancel }) {
  Object.entries(values).forEach(([name, v]) => {
    const el = form.querySelector(`[name="${name}"]`);
    if (el.type === 'checkbox') el.checked = !!v;
    else el.value = v;
  });
  form.dataset.editId = id;
  Object.entries(extra).forEach(([key, v]) => { form.dataset[key] = v; });

  const submitBtn = form.querySelector('button[type="submit"]');
  submitBtn.textContent = submitLabel;
  const cancelId = form.id + '-cancel-btn';
  if (!document.getElementById(cancelId)) {
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.id = cancelId;
    cancelBtn.className = 'btn btn-outline';
    cancelBtn.textContent = '取消編輯';
    cancelBtn.onclick = onCancel;
    submitBtn.parentNode.insertBefore(cancelBtn, submitBtn.nextSibling);
  }
  form.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// Back to "add" mode: clears every edit* dataset entry, resets the form.
function exitEditMode(form, submitLabel) {
  Object.keys(form.dataset).filter(k => k.startsWith('edit')).forEach(k => delete form.dataset[k]);
  form.reset();
  form.querySelector('[name="date"]').value = todayStr();
  form.querySelector('button[type="submit"]').textContent = submitLabel;
  document.getElementById(form.id + '-cancel-btn')?.remove();
}

function editTransaction(id, symbol, market, action, shares, price, fee, date, note, realizedPl, tax) {
  enterEditMode(document.getElementById('tx-form'), {
    id,
    // auto_fee off: editing keeps the stored fee/tax
    values: { symbol, action, shares, price, fee, tax: tax || 0, auto_fee: false, date, note },
    extra: { editRealizedPl: realizedPl, editMarket: market },
    submitLabel: '更新交易',
    onCancel: cancelTransactionEdit,
  });
}

function cancelTransactionEdit() {
  exitEditMode(document.getElementById('tx-form'), '新增交易');
}

async function deleteTransaction(id) {
  if (!confirm('確定要刪除此筆交易嗎？')) return;
  try {
    const result = await api(`/api/transactions/${id}`, { method: 'DELETE' });
    showToast('交易已刪除，持倉與已實現損益已重新計算', 'success');
    showLedgerWarnings(result);
    loadTransactions();
    loadHoldings();
    loadRealizedSummary();
  } catch (err) {
    showToast('刪除失敗: ' + err.message, 'error');
  }
}

// Server reports SELLs that lost their BUY records after an edit/delete
function showLedgerWarnings(result) {
  const warnings = result && result.warnings;
  if (warnings && warnings.length) showToast(warnings.join('\n'), 'error');
}

function exportCSV(kind) {
  const year = kind === 'dividends' ? (document.getElementById('div-year-filter')?.value || '') : '';
  const qs = /^\d{4}$/.test(year) ? '?year=' + year : '';
  api(`/api/${kind}/export${qs}`).catch(err => showToast('匯出失敗: ' + err.message, 'error'));
}

// ============================================================
// SECTION: XIRR (annualized money-weighted return)
// ============================================================

/** One market's /api/stocks/xirr result as a colored % with a flow-count tooltip, or -- */
function xirrHtml(r) {
  if (!r || r.xirr == null) return '--';
  const title = `${r.flows} 筆現金流，期間 ${r.span_days} 天` +
    (r.span_days < 365 ? '（不足一年，年化數字僅供參考）' : '');
  return `<span class="${plClass(r.xirr)}" title="${title}">${fmtPct(r.xirr)}</span>`;
}

async function loadXirr() {
  const targets = [['ALL', 'xirr-all'], ['TW', 'xirr-tw'], ['US', 'xirr-us']];
  let data = {};
  try {
    data = await api('/api/stocks/xirr');
  } catch (err) { /* leave every cell at -- */ }
  targets.forEach(([market, id]) => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = xirrHtml(data[market]);
  });
}

// ============================================================
// SECTION: Performance (time-weighted return by period)
// ============================================================

let _perfData = null;
let _perfPeriod = '1Y';
let _perfChart = null;
let _heatmapSeg = 'ALL';

const PERF_ROWS = [
  { seg: 'ALL', name: '全部', color: '#4e8cff', width: 2 },
  { seg: 'TW', name: '台股', color: '#34d399', width: 1.5, dash: [4, 2] },
  { seg: 'US', name: '美股', color: '#fbbf24', width: 1.5, dash: [4, 2] },
];

/** The benchmark picked in the dropdown, or undefined */
function selectedBench() {
  const sym = document.getElementById('perf-bench').value;
  return ((_perfData && _perfData.benchmarks) || []).find(b => b.symbol === sym);
}

/** Dashboard performance card + monthly heatmap from /api/stocks/performance */
let _perfPromise = null;

/** /api/stocks/performance, fetched once and shared until data changes (invalidatePerf). */
function getPerf() {
  _perfPromise ||= api('/api/stocks/performance')
    .then(d => (_perfData = d))
    .catch(err => { _perfPromise = null; throw err; });
  return _perfPromise;
}

/** Called by main.js on every data change, and by the dashboard to pick up fresh quotes. */
function invalidatePerf() {
  _perfPromise = null;
  _perfData = null;
}

async function loadPerformance() {
  const head = document.getElementById('perf-head');
  const body = document.getElementById('perf-body');
  if (!head || !body) return;
  let data;
  try {
    invalidatePerf(); // the dashboard always shows today's quotes
    data = await getPerf();
  } catch (err) {
    // 503 = no Yahoo proxy configured; its message says where to set one
    const why = err.status === 503 ? escapeHtml(err.message) : '無法計算績效';
    body.innerHTML = `<tr><td class="text-muted">${why}</td></tr>`;
    return;
  }
  const periods = data.periods || [];
  if (!periods.length) {
    body.innerHTML = '<tr><td class="text-muted">尚無交易紀錄</td></tr>';
    return;
  }

  const benchSel = document.getElementById('perf-bench');
  const benchKept = benchSel.value;
  benchSel.innerHTML = '<option value="">不比較大盤</option>' +
    (data.benchmarks || []).map(b => `<option value="${b.symbol}">比較 ${b.label}</option>`).join('');
  benchSel.value = benchKept;

  head.innerHTML = '<th></th>' + periods.map(p => {
    const title = `${p.start} 收盤 → ${data.as_of}（${p.days} 天）` +
      (p.partial ? '\n期間起點早於起算日，從起算日開始算' : '');
    return `<th data-period="${p.key}" class="perf-period-th" title="${title}" onclick="renderPerfChart('${p.key}')">${p.label}${p.partial ? '*' : ''}</th>`;
  }).join('');
  document.getElementById('perf-periods').innerHTML = periods.map(p =>
    `<button class="chart-type-btn" data-period="${p.key}" onclick="renderPerfChart('${p.key}')">${p.label}</button>`).join('');
  document.getElementById('heatmap-seg').innerHTML = PERF_ROWS.map(r =>
    `<button class="chart-type-btn" data-seg="${r.seg}" onclick="renderHeatmap('${r.seg}')">${r.name}</button>`).join('');

  const notes = [`自 ${data.inception} 起`];
  if (data.start_setting) notes.push('起算日可在設定頁調整');
  if (data.missing && data.missing.length) notes.push(`${data.missing.join(', ')} 無 Yahoo 歷史價，以成交價估`);
  document.getElementById('perf-note').textContent = notes.join(' · ');
  renderPerfChart(_perfPeriod);
  renderHeatmap(_heatmapSeg);
  if (document.getElementById('trend-granularity')?.value === 'daily') reRenderTrendChart();
}

/** Return rows per market, plus the selected benchmark's row */
function renderPerfTableBody() {
  const data = _perfData;
  const periods = data.periods || [];
  let html = PERF_ROWS.map(({ seg, name }) => `<tr><td><strong>${name}</strong></td>` + periods.map(p => {
    const r = p.markets[seg];
    if (!r || r.twr == null) return '<td>--</td>';
    const title = `期初市值 ${fmtTWD(r.start_value)}\n期末市值 ${fmtTWD(r.end_value)}`;
    const annual = r.annualized != null ? ` · 年化 ${fmtPct(r.annualized)}` : '';
    return `<td title="${title}"><span class="${plClass(r.twr)}">${fmtPct(r.twr)}</span>` +
      `<span class="cell-sub ${plClass(r.pnl)}">${fmtTWD(r.pnl)}${annual}</span></td>`;
  }).join('') + '</tr>').join('');

  const bench = selectedBench();
  if (bench) {
    html += `<tr class="perf-bench-row"><td>${bench.label}</td>` + periods.map(p => {
      const v = p.bench[bench.symbol];
      return `<td>${v == null ? '--' : `<span class="${plClass(v)}">${fmtPct(v)}</span>`}</td>`;
    }).join('') + '</tr>';
  }
  document.getElementById('perf-body').innerHTML = html;
}

/** Cumulative TWR line chart for one period: the daily growth index rebased to 0% at the period's start close. */
function renderPerfChart(key) {
  const data = _perfData;
  const p = data && (data.periods || []).find(x => x.key === key);
  const s = data && data.series;
  if (!p || !s) return;
  _perfPeriod = key;
  renderPerfTableBody();
  document.querySelectorAll('#perf-periods .chart-type-btn, .perf-period-th').forEach(el =>
    el.classList.toggle('active', el.dataset.period === key));
  renderPerfRisk(p);

  // Window from the period's base close to today; weekends are flat, drop them.
  let b = s.dates.findIndex(d => d >= p.start);
  if (b < 0) b = 0;
  const idx = weekdayIndexes(s.dates, b);
  // A line that starts mid-window is rebased at its own first point.
  const rebased = vals => {
    const base = idx.map(i => vals[i]).find(v => v != null);
    return idx.map(i => (vals[i] == null || !base) ? null : (vals[i] / base - 1) * 100);
  };
  const line = (label, vals, color, width, dash) => ({
    label, data: rebased(vals || []), borderColor: color, backgroundColor: 'transparent',
    borderWidth: width, borderDash: dash || [], pointRadius: 0, pointHoverRadius: 5, pointHitRadius: 8, tension: 0,
  });
  const datasets = PERF_ROWS.map(r => line(r.name, s.growth[r.seg], r.color, r.width, r.dash));
  const bench = selectedBench();
  if (bench) datasets.push(line(bench.label, s.bench[bench.symbol], '#c3cede', 1.5, [1, 3]));

  const ctx = document.getElementById('chart-perf');
  if (_perfChart) _perfChart.destroy();
  _perfChart = new Chart(ctx, {
    type: 'line',
    data: { labels: idx.map(i => s.dates[i]), datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: true, position: 'top', labels: { color: '#8a9ab5', usePointStyle: true, pointStyle: 'line', font: { size: 11 } } },
        tooltip: { callbacks: { label: c => c.parsed.y == null ? null : `${c.dataset.label}: ${fmtPct(c.parsed.y)}` } },
      },
      scales: {
        x: { ticks: { color: '#5c6f8a', font: { size: 11 }, maxTicksLimit: 8, maxRotation: 0 }, grid: { display: false } },
        y: {
          ticks: { color: '#5c6f8a', font: { size: 11 }, callback: v => v + '%' },
          // Emphasize the 0% line: above it the period made money.
          grid: { color: c => c.tick.value === 0 ? 'rgba(138,154,181,0.6)' : 'rgba(42,58,78,0.4)' },
        },
      },
    },
  });
}

/** Indexes from b to the end, skipping weekends but keeping the first and last day */
function weekdayIndexes(dates, b) {
  const idx = [];
  for (let i = b; i < dates.length; i++) {
    const dow = new Date(dates[i] + 'T00:00:00').getDay();
    if (i === b || i === dates.length - 1 || (dow !== 0 && dow !== 6)) idx.push(i);
  }
  return idx;
}

// ============================================================
// SECTION: 持倉總覽 — market value trend (from the performance series, no manual snapshots)
// ============================================================

let _holdingsTrendChart = null;

async function loadHoldingsTrend() {
  const hint = document.getElementById('holdings-trend-hint');
  try {
    await getPerf();
    renderHoldingsTrend();
  } catch (err) {
    // 503 = no Yahoo proxy configured; its message says where to set one
    hint.textContent = err.status === 503 ? err.message : '無法計算市值走勢：' + err.message;
  }
}

const TREND_SEG_LABEL = { ALL: '合計', TW: '台股', US: '美股' };
const assetColor = (key) => ASSET_SERIES.find(a => a.key === key).color;
/** Series colors: 市值 per market (as on the dashboard), 未實現 / 已實現 as the CVD-checked blue / orange pair */
const trendColor = (key) => ({ ALL: '#4e8cff', TW: assetColor('tw'), US: assetColor('us') }[key] || seriesColor(key));
const trendPick = (name) => document.querySelector(`[data-trend="${name}"] .active`)?.dataset.v;
const unrealPct = (pl, cost) => (cost > 0 ? fmtPct(pl / cost * 100) : '--');
let _trendPeriod = '1Y';

function renderHoldingsTrend() {
  const s = _perfData && _perfData.series;
  if (!s || !s.dates || !s.dates.length) return;
  const seg = trendPick('seg') || 'ALL';
  const mode = trendPick('mode') || 'value';
  // Same calendar periods as the 投資績效 card (1 個月 … 全部), from the server
  const periods = _perfData.periods || [];
  if (!periods.some(p => p.key === _trendPeriod)) _trendPeriod = 'ALL';
  document.getElementById('holdings-trend-periods').innerHTML = periods.map(p =>
    `<button type="button" class="chart-type-btn${p.key === _trendPeriod ? ' active' : ''}" onclick="setTrendPeriod('${p.key}')">${p.label}</button>`).join('');
  const start = periods.find(p => p.key === _trendPeriod)?.start || '';
  const b = Math.max(0, s.dates.findIndex(d => d >= start));
  const idx = weekdayIndexes(s.dates, b);
  const value = s.value[seg], cost = s.cost[seg], realized = s.realized[seg];
  const unreal = (i) => value[i] - cost[i];

  // Latest numbers, plus how much each moved over the shown period
  const last = s.dates.length - 1;
  const moved = (now, then) => (idx.length > 1 ? `<span class="${plClass(now - then)}">期間 ${fmtPL(now - then)}</span>` : '');
  const pl = unreal(last);
  document.getElementById('holdings-trend-summary').innerHTML = [
    ['市值', fmtTWD(value[last]), ''],
    ['持有成本', fmtTWD(cost[last]), ''],
    ['未實現損益', `${fmtPL(pl)}${cost[last] > 0 ? ` (${unrealPct(pl, cost[last])})` : ''}`, plClass(pl), moved(pl, unreal(idx[0]))],
    ['累計已實現', fmtPL(realized[last]), plClass(realized[last]), moved(realized[last], realized[idx[0]])],
  ].map(([label, val, cls, sub = '']) => `<div><span>${label}</span><strong class="${cls}">${val}</strong>${sub}</div>`).join('');

  const line = (label, data, color, extra = {}) => ({
    label, data, borderColor: color, backgroundColor: color,
    borderWidth: 2, pointRadius: 0, pointHitRadius: 8, tension: 0, ...extra,
  });
  const datasets = mode === 'value'
    ? [line(`${TREND_SEG_LABEL[seg]}市值`, idx.map(i => value[i]), trendColor(seg)),
       line('持有成本', idx.map(i => cost[i]), '#8a9ab5', { borderDash: [6, 4], borderWidth: 1.5 })]
    : [line('未實現損益', idx.map(unreal), trendColor('income')),
       line('累計已實現', idx.map(i => realized[i]), trendColor('expense'))];

  if (_holdingsTrendChart) _holdingsTrendChart.destroy();
  _holdingsTrendChart = new Chart(document.getElementById('chart-holdings-trend'), {
    type: 'line',
    data: { labels: idx.map(i => s.dates[i]), datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { labels: { color: '#8a9ab5', boxWidth: 12, font: { size: 11 } } },
        tooltip: {
          callbacks: {
            label: c => `${c.dataset.label}: ${mode === 'value' ? fmtTWD(c.parsed.y) : fmtPL(c.parsed.y)}`,
            footer: items => {
              const i = idx[items[0].dataIndex];
              return mode === 'value'
                ? `未實現 ${fmtPL(unreal(i))} (${unrealPct(unreal(i), cost[i])})\n累計已實現 ${fmtPL(realized[i])}`
                : `未實現報酬率 ${unrealPct(unreal(i), cost[i])}`;
            },
          },
        },
      },
      scales: {
        x: { ticks: { ...CHART_AXIS.ticks, maxTicksLimit: 6, maxRotation: 0 }, grid: { display: false } },
        y: { ticks: { ...CHART_AXIS.ticks, callback: v => fmt(v) }, grid: CHART_AXIS.grid },
      },
    },
  });
}

function setTrendPeriod(key) {
  _trendPeriod = key;
  renderHoldingsTrend();
}

document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-trend] .chart-type-btn');
  if (!btn) return;
  btn.parentElement.querySelectorAll('.chart-type-btn').forEach(x => x.classList.toggle('active', x === btn));
  renderHoldingsTrend();
});

/** Max drawdown and volatility of the selected period, per market */
function renderPerfRisk(p) {
  document.getElementById('perf-risk-head').innerHTML =
    `<th>風險（${p.label}）</th>` + PERF_ROWS.map(r => `<th>${r.name}</th>`).join('');
  const cells = fn => PERF_ROWS.map(({ seg }) => {
    const r = p.markets[seg];
    return `<td>${r && r.twr != null ? fn(r) : '--'}</td>`;
  }).join('');
  const md = d => d.slice(5);
  document.getElementById('perf-risk-body').innerHTML = `
    <tr><td title="期間內從最高點到之後最低點的最大跌幅">最大回撤 ⓘ</td>${cells(r => r.max_drawdown ? `<span class="negative">${fmtPct(r.max_drawdown)}</span>` : '0%')}</tr>
    <tr><td>回撤期間</td>${cells(r => !r.dd_peak ? '--' :
      `${md(r.dd_peak)} → ${md(r.dd_trough)}<span class="cell-sub">${r.dd_recovered ? `${md(r.dd_recovered)} 回到高點` : '尚未回到高點'}</span>`)}</tr>
    <tr><td title="每日報酬的標準差 × √252，越大代表波動越劇烈。0050 長期約 15–20%">年化波動度 ⓘ</td>${cells(r => r.volatility == null ? '--' : r.volatility.toFixed(1) + '%')}</tr>`;
}

/** Monthly TWR heatmap for one market, newest year first */
function renderHeatmap(seg) {
  _heatmapSeg = seg;
  document.querySelectorAll('#heatmap-seg .chart-type-btn').forEach(b => b.classList.toggle('active', b.dataset.seg === seg));
  const years = ((_perfData && _perfData.monthly && _perfData.monthly[seg]) || []).slice().reverse();
  const body = document.getElementById('heatmap-body');
  if (!years.length) {
    body.innerHTML = '<tr><td colspan="14" class="text-muted">尚無資料</td></tr>';
    return;
  }
  // Fill strength scales with |return|, saturating at 10% a month (30% a year).
  const cell = (v, cap) => {
    if (v == null) return '<td class="heatmap-empty"></td>';
    const a = Math.min(Math.abs(v) / cap, 1) * 0.55 + 0.08;
    const rgb = v >= 0 ? '52,211,153' : '248,113,113';
    return `<td style="background:rgba(${rgb},${a.toFixed(2)})">${fmtPct(v)}</td>`;
  };
  body.innerHTML = years.map(y =>
    `<tr><td><strong>${y.year}</strong></td>${y.months.map(v => cell(v, 10)).join('')}${cell(y.total, 30)}</tr>`).join('');
}

// ============================================================
// SECTION: Data health check
// ============================================================

/** Warning count next to the performance note, linking to the settings page */
async function loadDataCheckBadge() {
  const badge = document.getElementById('perf-check-badge');
  if (!badge) return;
  let d;
  try {
    d = await api('/api/data-check');
  } catch (_) { return; }
  const warns = (d.checks || []).filter(c => c.level === 'warn').length;
  badge.innerHTML = warns ? ` · <a href="#" onclick="goToTab('settings');return false">⚠ 資料檢查 ${warns} 項提醒</a>` : '';
}

/** Show a page (and optionally a stocks sub-tab); also for pages without a nav button */
function goToTab(tab, subtab) {
  showTab(tab);
  if (subtab) document.querySelector(`.sub-tab-btn[data-subtab="${subtab}"]`)?.click();
}

const CHECK_ICONS = { warn: '⚠', info: 'ℹ', ok: '✓' };
const CHECK_ACTIONS = {
  start_date: ['設定起算日', () => document.getElementById('perf-start-date').focus()],
  transactions: ['到交易紀錄', () => goToTab('stocks', 'transactions')],
  dividends: ['到股利', () => goToTab('stocks', 'dividends')],
  assets: ['到總覽', () => goToTab('dashboard')],
};

async function loadDataCheck() {
  const list = document.getElementById('data-check-list');
  if (!list) return;
  list.innerHTML = '<p class="text-muted">檢查中…</p>';
  let d;
  try {
    d = await api('/api/data-check');
  } catch (err) {
    list.innerHTML = `<p class="negative">檢查失敗：${err.message}</p>`;
    return;
  }
  document.getElementById('perf-start-date').value = d.start_setting || '';
  const sug = document.getElementById('perf-start-suggest');
  sug.dataset.date = d.suggested_start || '';
  sug.style.display = d.suggested_start && d.suggested_start !== d.start_setting ? '' : 'none';
  sug.textContent = `套用建議：${d.suggested_start}（匯入持倉後第一筆實際交易）`;

  const order = { warn: 0, info: 1, ok: 2 };
  list.innerHTML = (d.checks || []).slice().sort((a, b) => order[a.level] - order[b.level]).map(c => {
    const action = CHECK_ACTIONS[c.action];
    return `<div class="check-item check-${c.level}">
      <div class="check-title"><span class="check-icon">${CHECK_ICONS[c.level] || ''}</span><span>${c.title}</span>
        ${action ? `<button type="button" class="btn btn-outline btn-sm" onclick="CHECK_ACTIONS['${c.action}'][1]()">${action[0]}</button>` : ''}</div>
      ${c.detail ? `<div class="check-detail">${c.detail}</div>` : ''}
      ${c.items && c.items.length ? `<details><summary>明細（${c.items.length}）</summary><ul>${c.items.map(x => `<li>${x}</li>`).join('')}</ul></details>` : ''}
    </div>`;
  }).join('');
}

async function savePerfStartDate(value) {
  const v = value !== undefined ? value : document.getElementById('perf-start-date').value;
  try {
    await api('/api/settings', { method: 'PUT', body: JSON.stringify({ perf_start_date: v }) });
    showToast(v ? `績效起算日已設為 ${v}` : '已清除績效起算日', 'success');
    loadDataCheck();
  } catch (err) {
    showToast('儲存失敗: ' + err.message, 'error');
  }
}

function applySuggestedStart() {
  const date = document.getElementById('perf-start-suggest').dataset.date;
  if (date) savePerfStartDate(date);
}

// ============================================================
// SECTION: Dividends
// ============================================================

let _dividends = [];

async function loadDividends() {
  try {
    _dividends = await api('/api/dividends');
    const sel = document.getElementById('div-year-filter');
    if (sel) {
      const prev = sel.value;
      const years = [...new Set(_dividends.map(d => d.date.slice(0, 4)))].sort().reverse();
      sel.innerHTML = '<option value="">全部年度</option>' + years.map(y => `<option value="${y}">${y}</option>`).join('');
      if (years.includes(prev)) sel.value = prev;
    }
    const form = document.getElementById('div-form');
    if (form && !form.querySelector('[name="date"]').value) form.querySelector('[name="date"]').value = todayStr();
    renderDividends();
  } catch (err) {
    showToast('載入股利失敗: ' + err.message, 'error');
  }
}

function renderDividends() {
  const year = document.getElementById('div-year-filter').value;
  const list = _dividends.filter(d => !year || d.date.startsWith(year));
  const rate = _rplData?.overall?.usd_twd_rate || 32;
  const totalTwd = list.reduce((s, d) => s + toTWD(d.amount, d.currency, rate), 0);
  document.getElementById('div-total').innerHTML = list.length ? `<span class="positive">${fmtTWD(totalTwd)}</span>` : '--';
  document.getElementById('div-count').textContent = list.length ? `${list.length} 筆` : '--';

  const tbody = document.getElementById('div-body');
  if (list.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty-state">尚無股利紀錄</td></tr>';
    return;
  }
  tbody.innerHTML = list.map(d => {
    const fc = n => fmtCur(n, d.currency);
    return `
      <tr>
        <td>${d.date}</td>
        <td><strong>${escapeHtml(d.symbol)}</strong></td>
        <td>${d.market === 'TW' ? '台股' : '美股'}</td>
        <td class="positive">${fc(d.amount)}</td>
        <td>${d.withheld ? fc(d.withheld) : '--'}</td>
        <td>${escapeHtml(d.note || '')}</td>
        <td>
          ${rowBtn('edit', `editDividend(${d.id})`)}
          ${rowBtn('delete', `deleteDividend(${d.id})`)}
        </td>
      </tr>`;
  }).join('');
}

// Amount labels follow the market: explicit choice, else the symbol (.TW/.TWO = 台股)
function updateDividendCurrency() {
  const form = document.getElementById('div-form');
  let market = form.querySelector('[name="market"]').value;
  if (!market) {
    const sym = form.querySelector('[name="symbol"]').value.trim().toUpperCase();
    market = /\.TWO?$/.test(sym) || !sym ? 'TW' : 'US';
  }
  const label = market === 'TW' ? 'NT$' : 'US$';
  form.querySelectorAll('.div-cur').forEach(el => { el.textContent = label; });
}

let _divSuggestions = [];

async function loadDividendSuggestions() {
  const btn = document.getElementById('div-suggest-btn');
  btn.disabled = true;
  btn.textContent = '查詢中...';
  try {
    const res = await api('/api/dividends/suggestions');
    _divSuggestions = res.suggestions || [];
    document.getElementById('div-suggest').style.display = 'block';
    renderDividendSuggestions();
    if (res.errors && res.errors.length) showToast('部分股票查詢失敗：\n' + res.errors.join('\n'), 'error');
  } catch (err) {
    showToast('查詢股利失敗: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '從 Yahoo 查詢股利';
  }
}

function renderDividendSuggestions() {
  const since = document.getElementById('div-suggest-since').value;
  document.getElementById('div-suggest-all').checked = true;
  const body = document.getElementById('div-suggest-body');
  // data-idx stays the index into the full list so import picks the right row
  const rows = _divSuggestions
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => !since || s.ex_date >= since);
  if (rows.length === 0) {
    body.innerHTML = '<tr><td colspan="7" class="empty-state">沒有新的股利可匯入（已記錄的會自動略過）</td></tr>';
    return;
  }
  body.innerHTML = rows.map(({ s, i }) => {
    const fc = n => fmtCur(n, s.currency);
    return `
      <tr>
        <td><input type="checkbox" class="div-suggest-cb" data-idx="${i}" checked></td>
        <td>${s.ex_date}</td>
        <td><strong>${escapeHtml(s.symbol)}</strong></td>
        <td>${s.currency === 'TWD' ? 'NT$' : '$'}${fmtNum(s.per_share, 4)}</td>
        <td>${fmt(s.shares)}</td>
        <td class="positive">${fc(s.amount)}</td>
        <td>${s.withheld ? fc(s.withheld) : '--'}</td>
      </tr>`;
  }).join('');
}

function toggleAllSuggestions(checked) {
  document.querySelectorAll('.div-suggest-cb').forEach(cb => { cb.checked = checked; });
}

async function importDividendSuggestions() {
  const picked = [...document.querySelectorAll('.div-suggest-cb')]
    .filter(cb => cb.checked)
    .map(cb => _divSuggestions[Number(cb.dataset.idx)]);
  if (picked.length === 0) { showToast('請先勾選要匯入的項目', 'error'); return; }
  try {
    await api('/api/dividends/batch', {
      method: 'POST',
      body: JSON.stringify(picked.map(s => ({
        symbol: s.symbol, market: s.market, currency: s.currency,
        amount: s.amount, withheld: s.withheld,
        date: s.ex_date, ex_date: s.ex_date,
        note: `Yahoo 估算：每股 ${s.per_share} × ${s.shares} 股（日期為除息日）`,
      }))),
    });
    showToast(`已匯入 ${picked.length} 筆股利`, 'success');
    document.getElementById('div-suggest').style.display = 'none';
    loadDividends();
    loadRealizedSummary();
    loadXirr();
  } catch (err) {
    showToast('匯入失敗: ' + err.message, 'error');
    loadDividends();
  }
}

async function submitDividend(e) {
  e.preventDefault();
  const form = e.target;
  const data = {
    symbol: form.querySelector('[name="symbol"]').value.trim().toUpperCase(),
    amount: Number(form.querySelector('[name="amount"]').value),
    withheld: Number(form.querySelector('[name="withheld"]').value) || 0,
    date: form.querySelector('[name="date"]').value,
    note: form.querySelector('[name="note"]').value,
  };
  data.market = form.querySelector('[name="market"]').value; // '' lets the server infer from the symbol
  const editId = form.dataset.editId;
  try {
    if (editId) {
      await api(`/api/dividends/${editId}`, { method: 'PUT', body: JSON.stringify(data) });
      showToast('股利已更新', 'success');
      cancelDividendEdit();
    } else {
      await api('/api/dividends', { method: 'POST', body: JSON.stringify(data) });
      showToast('股利已記錄', 'success');
      form.reset();
      updateDividendCurrency();
      form.querySelector('[name="date"]').value = todayStr();
    }
    loadDividends();
    loadRealizedSummary();
    loadXirr();
  } catch (err) {
    showToast('儲存股利失敗: ' + err.message, 'error');
  }
}

function editDividend(id) {
  const d = _dividends.find(x => x.id === id);
  if (!d) return;
  enterEditMode(document.getElementById('div-form'), {
    id,
    values: { symbol: d.symbol, market: d.market, amount: d.amount, withheld: d.withheld || 0, date: d.date, note: d.note || '' },
    submitLabel: '更新股利',
    onCancel: cancelDividendEdit,
  });
  updateDividendCurrency();
}

function cancelDividendEdit() {
  exitEditMode(document.getElementById('div-form'), '新增股利');
  updateDividendCurrency();
}

async function deleteDividend(id) {
  if (!confirm('確定要刪除此筆股利嗎？')) return;
  try {
    await api(`/api/dividends/${id}`, { method: 'DELETE' });
    showToast('股利已刪除', 'success');
    loadDividends();
    loadRealizedSummary();
    loadXirr();
  } catch (err) {
    showToast('刪除失敗: ' + err.message, 'error');
  }
}

// ============================================================
// SECTION: Expenses
// ============================================================

// EXPENSE_CATEGORIES (the dialog's presets) comes from js/server/expenses.js via main.js.
/** An emoji per category, so lists read at a glance; categories added later get the tag. */
const CATEGORY_EMOJI = {
  飲食: '🍜', 飲料: '🧋', 交通: '🚗', 住房: '🏠', 娛樂: '🎮', 醫療: '💊', 日用品: '🧻', 購物: '🛍️', 送禮: '🎁',
  其他支出: '📦', 保險: '🛡️', 薪資: '💼', 股利: '📈', 獎金: '🎉', 其他收入: '💰', '': '❔',
};
/** Custom categories (typed by hand, or from AI import) by a word they contain: 餐飲, 午餐費, 日本旅遊… First match wins. */
const CATEGORY_KEYWORD_EMOJI = [
  ['飯店', '🏨'], ['住宿', '🏨'], ['早餐', '🥐'], ['咖啡', '☕'], ['餐', '🍜'], ['飯', '🍜'], ['吃', '🍜'], ['零食', '🍪'],
  ['機票', '✈️'], ['旅', '✈️'], ['加油', '⛽'], ['停車', '🅿️'], ['車', '🚗'],
  ['房租', '🏠'], ['水電', '💡'], ['電信', '📱'], ['手機', '📱'], ['網路', '🌐'], ['訂閱', '🔁'],
  ['衣', '👕'], ['美容', '💇'], ['運動', '🏋️'], ['健身', '🏋️'], ['學', '📚'], ['教育', '📚'], ['書', '📚'],
  ['寵物', '🐾'], ['孝親', '👪'], ['稅', '🧾'], ['投資', '📊'], ['利息', '🏦'], ['退款', '↩️'],
];
/** Display name of a category; records without one show as 未分類. */
const catLabel = (c) => c || '未分類';
const catEmoji = (c) => CATEGORY_EMOJI[c || ''] || CATEGORY_KEYWORD_EMOJI.find(([k]) => c.includes(k))?.[1] || '🏷️';
/** Emoji + name, for lists and tables */
const catDisplay = (c) => `${catEmoji(c)} ${catLabel(c)}`;

/**
 * Categories the dialog offers for `type`: the presets plus every one used before, the most used
 * in the last 90 days first (ties: preset order, then custom ones by name).
 */
function categoryChoices(type) {
  const since = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
  const used = new Set();
  const recent = new Map();
  for (const e of _expAll) {
    if ((e.type || 'expense') !== type || !e.category) continue;
    used.add(e.category);
    if (e.date >= since) recent.set(e.category, (recent.get(e.category) || 0) + 1);
  }
  const presets = EXPENSE_CATEGORIES[type];
  const rank = (c) => { const i = presets.indexOf(c); return i < 0 ? presets.length : i; };
  return [...new Set([...presets, ...used])]
    .sort((a, b) => (recent.get(b) || 0) - (recent.get(a) || 0) || rank(a) - rank(b) || a.localeCompare(b));
}

/**
 * The category chips of `type` with `selected` chosen (default: the most used). The active chip is
 * the dialog's category; 自訂 (__custom__) takes the name from the text field below it.
 */
function renderCategoryChips(type, selected) {
  const choices = categoryChoices(type);
  const chip = (value, label) =>
    `<button type="button" class="cat-chip" role="radio" data-cat="${escapeAttr(value)}" onclick="selectCategory(this.dataset.cat, true)">${label}</button>`;
  document.getElementById('expense-cat-chips').innerHTML =
    choices.map(c => chip(c, escapeHtml(catDisplay(c)))).join('') + chip('__custom__', '＋ 自訂');
  selectCategory(selected === undefined ? choices[0] : selected);
}

function selectCategory(cat, tapped = false) {
  const chips = [...document.querySelectorAll('#expense-cat-chips .cat-chip')];
  // A category not on a chip (none here: every used one is) would be edited as 自訂
  const value = cat && !chips.some(b => b.dataset.cat === cat) ? '__custom__' : cat;
  chips.forEach(b => {
    const on = b.dataset.cat === value;
    b.classList.toggle('active', on);
    b.setAttribute('aria-checked', on);
  });
  const custom = value === '__custom__';
  document.getElementById('custom-category-group').style.display = custom ? 'flex' : 'none';
  const input = document.getElementById('custom-category-input');
  if (custom && cat !== '__custom__') input.value = cat;
  if (custom && tapped) input.focus();
}

/** The chosen category ('' when none). */
function chosenCategory() {
  const cat = document.querySelector('#expense-cat-chips .cat-chip.active')?.dataset.cat || '';
  return cat === '__custom__' ? document.getElementById('custom-category-input').value.trim() : cat;
}

function buildCurrencyOptions() {
  document.getElementById('expense-currency').innerHTML =
    EXPENSE_CURRENCIES.map(c => `<option value="${c.code}">${c.flag} ${c.symbol} ${c.name}</option>`).join('');
}

function initExpenseDefaults() {
  buildCurrencyOptions();
  initYearSelector('exp-year-filter');
  initMonthSelector();
}

/** Years from next year back to `startYear` (a rebuild keeps the current choice). */
function initYearSelector(id, startYear = 2020) {
  const select = document.getElementById(id);
  if (!select) return;
  const currentYear = new Date().getFullYear();
  const chosen = Number(select.value) || currentYear;
  select.innerHTML = '';
  for (let y = currentYear + 1; y >= startYear; y--) {
    const opt = document.createElement('option');
    opt.value = y;
    opt.textContent = y + '\u5E74';
    if (y === chosen) opt.selected = true;
    select.appendChild(opt);
  }
}

/** The 收支 year picker reaches back to the oldest record (rebuilt only when that changes). */
let _expStartYear = 2020;
function setExpenseStartYear(firstYear) {
  const start = Math.min(2020, firstYear || 2020);
  if (start === _expStartYear) return;
  _expStartYear = start;
  initYearSelector('exp-year-filter', start);
}

/** `category`: the one to select (editing); default the type's most used. */
function setExpenseType(type, category) {
  const typeInput = document.querySelector('#expense-form [name="type"]');
  if (typeInput) typeInput.value = type;
  document.querySelectorAll('.type-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.type === type);
  });
  // Only the chosen type's categories
  renderCategoryChips(type, category);
}

/** Clears the add/edit form back to a new expense dated today. */
function resetExpenseForm() {
  const form = document.getElementById('expense-form');
  form.reset();
  form.querySelector('[name="id"]').value = '';
  form.querySelector('[name="date"]').value = todayStr();
  setExpenseType('expense');
  let last = null;
  try { last = localStorage.getItem('expenseCurrency'); } catch (e) { /* ignore */ }
  setExpenseCurrency(EXPENSE_CURRENCIES.some(c => c.code === last) ? last : 'TWD');
}

// --- 收支 dialog: currency and exchange rate ---
// The rate field holds the date's market rate (looked up on currency/date change) until the user
// types one (data-manual); an empty field is filled in by the server when saving.

let _fxSeq = 0; // latest lookup wins

const expField = (name) => document.getElementById('expense-form').elements[name];
const expForeign = () => expField('currency').value !== 'TWD';
const fxManual = () => 'manual' in expField('fx_rate').dataset;
const setFxSource = (text) => { document.getElementById('expense-fx-source').textContent = text; };

/** Shows/hides the rate row for `code`; keepRate keeps the rate already in the field (editing a record). */
function setExpenseCurrency(code, keepRate = false) {
  expField('currency').value = code;
  const foreign = expForeign();
  expField('currency').closest('.amount-row').classList.toggle('foreign', foreign);
  document.getElementById('expense-fx').hidden = !foreign;
  document.getElementById('expense-fx-hint').hidden = !foreign;
  document.getElementById('expense-fx-cur').textContent = code;
  const rate = expField('fx_rate');
  delete rate.dataset.estimated;
  if (keepRate && rate.value) {
    rate.dataset.manual = '';
    setFxSource('自訂匯率');
  } else {
    delete rate.dataset.manual;
    rate.value = '';
    setFxSource('');
    if (foreign) lookupExpenseFx();
  }
  updateExpenseFxHint();
}

function onExpenseCurrencyChange() {
  setExpenseCurrency(expField('currency').value);
}

function onExpenseDateChange() {
  if (expForeign() && !fxManual()) lookupExpenseFx();
}

function onExpenseFxInput() {
  expField('fx_rate').dataset.manual = '';
  delete expField('fx_rate').dataset.estimated;
  setFxSource('自訂匯率');
  updateExpenseFxHint();
}

async function lookupExpenseFx() {
  const seq = ++_fxSeq;
  setFxSource('查詢匯率中…');
  try {
    const r = await api(`/api/expenses/fx?currency=${expField('currency').value}&date=${expField('date').value || todayStr()}`);
    if (seq !== _fxSeq || fxManual()) return;
    const rate = expField('fx_rate');
    rate.value = Number(r.rate.toPrecision(5));
    if (r.estimated) {
      // Offline: saved as an estimate (fx_pending) and replaced by the market rate once online
      rate.dataset.estimated = '';
      setFxSource(`離線，先用${r.date ? ` ${shortDate(r.date)} ` : '之前'}的匯率估算，有網路時自動更新`);
    } else {
      delete rate.dataset.estimated;
      setFxSource(`${shortDate(r.date)} 市場匯率`);
    }
    updateExpenseFxHint();
  } catch (err) {
    if (seq === _fxSeq && !fxManual()) setFxSource(`查不到匯率，請手動填寫（${err.message}）`);
  }
}

/** ≈ NT$ of the amount at the rate in the field (the hint's source part is set separately). */
function updateExpenseFxHint() {
  const amount = Number(expField('amount').value);
  const rate = Number(expField('fx_rate').value);
  document.getElementById('expense-fx-twd').textContent = expForeign() && amount > 0 && rate > 0 ? `≈ ${fmtTWD(amount * rate)}` : '';
}

/** Shows the expense modal in add or edit mode and focuses the amount. */
function showExpenseModal(editing) {
  document.getElementById('expense-modal-title').textContent = editing ? '編輯紀錄' : '新增紀錄';
  document.getElementById('expense-continue-btn').style.display = editing ? 'none' : '';
  document.getElementById('expense-delete-btn').style.display = editing ? '' : 'none';
  openModal('modal-expense');
  document.querySelector('#expense-form [name="amount"]').focus();
}

function openExpenseModal() {
  resetExpenseForm();
  showExpenseModal(false);
}

async function submitExpense(e) {
  e.preventDefault();
  const form = e.target;
  const id = form.querySelector('[name="id"]').value;
  const category = chosenCategory();
  if (!category) {
    showToast('請選擇或輸入分類', 'error');
    return;
  }

  const data = {
    type: form.querySelector('[name="type"]').value || 'expense',
    amount: Number(form.querySelector('[name="amount"]').value),
    currency: form.querySelector('[name="currency"]').value,
    fx_rate: Number(form.querySelector('[name="fx_rate"]').value) || 0,
    fx_pending: 'estimated' in expField('fx_rate').dataset ? 1 : 0,
    category,
    date: form.querySelector('[name="date"]').value,
    note: form.querySelector('[name="note"]').value,
  };

  try {
    if (id) {
      await api(`/api/expenses/${id}`, { method: 'PUT', body: JSON.stringify(data) });
      showToast('紀錄已更新', 'success');
    } else {
      await api('/api/expenses', { method: 'POST', body: JSON.stringify(data) });
      showToast('紀錄已新增', 'success');
      try { localStorage.setItem('expenseCurrency', data.currency); } catch (err) { /* ignore */ }
    }
    if (!id && e.submitter?.dataset.continue) {
      // Keep type, category and date; clear the rest for the next entry
      form.querySelector('[name="amount"]').value = '';
      form.querySelector('[name="note"]').value = '';
      updateExpenseFxHint();
      form.querySelector('[name="amount"]').focus();
    } else {
      closeModal('modal-expense');
    }
    loadExpenses();
  } catch (err) {
    showToast('儲存失敗: ' + err.message, 'error');
  }
}

function editExpense(id) {
  const e = _expAll.find(x => x.id === id);
  if (!e) return;
  const form = document.getElementById('expense-form');
  form.querySelector('[name="id"]').value = e.id;
  form.querySelector('[name="amount"]').value = e.amount;
  form.querySelector('[name="date"]').value = e.date;
  form.querySelector('[name="note"]').value = e.note || '';
  setExpenseType(e.type || 'expense', e.category);
  // Keep the record's own rate (old USD rows have none: empty = looked up when saving)
  form.querySelector('[name="fx_rate"]').value = e.fx_rate > 0 && e.currency !== 'TWD' ? e.fx_rate : '';
  setExpenseCurrency(e.currency || 'TWD', true);
  if (e.fx_pending) {
    // Still an offline estimate: keep it replaceable (a date change looks the rate up again)
    const rate = expField('fx_rate');
    delete rate.dataset.manual;
    rate.dataset.estimated = '';
    setFxSource('離線估算，有網路時自動更新');
  }


  showExpenseModal(true);
}

/** Deletes right away; the toast's 復原 adds the same record back (no confirm dialog). */
async function deleteExpense(id) {
  const e = _expAll.find(x => x.id === Number(id));
  try {
    await api(`/api/expenses/${id}`, { method: 'DELETE' });
    const undo = e && (async () => {
      const { type, amount, currency, fx_rate, fx_pending, category, date, note } = e;
      await api('/api/expenses', { method: 'POST', body: JSON.stringify({ type, amount, currency, fx_rate, fx_pending, category, date, note }) });
      showToast('已復原', 'success');
      loadExpenses();
    });
    showToast('紀錄已刪除', 'success', undo ? { action: { label: '復原', run: undo }, timeout: 6000 } : {});
    loadExpenses();
    return true;
  } catch (err) {
    showToast('刪除失敗: ' + err.message, 'error');
    return false;
  }
}

async function deleteExpenseFromModal() {
  const id = document.querySelector('#expense-form [name="id"]').value;
  if (id && await deleteExpense(id)) closeModal('modal-expense');
}

// --- 收支 page: period summary, category ranking, monthly chart, records table ---

let _expAutoMonth = true;      // first load / a year change picks the latest month that has data
function onExpYearChange() {
  _expAutoMonth = true;
  loadExpenseStats();
}

/** [oldest, newest] year a year <select> offers (initYearSelector lists them newest first). */
const yearBounds = (select) => [Number(select.options[select.options.length - 1].value), Number(select.options[0].value)];

/** The 收支 period one step away: next/previous month (crossing years), or year when 全年 (m = 0); null past the ends. */
function nextExpPeriod(delta) {
  const [min, max] = yearBounds(document.getElementById('exp-year-filter'));
  let y = expYear();
  let m = expMonth();
  if (m === 0) y += delta;
  else {
    m += delta;
    if (m < 1) { m = 12; y--; }
    if (m > 12) { m = 1; y++; }
  }
  return y < min || y > max ? null : { y, m };
}

function stepExpPeriod(delta) {
  const next = nextExpPeriod(delta);
  if (!next) return;
  document.getElementById('exp-month-filter').value = String(next.m);
  if (next.y === expYear()) { renderExpensePage(); return; }
  document.getElementById('exp-year-filter').value = String(next.y);
  _expAutoMonth = false; // keep the month we stepped to (also 全年, unlike picking a year from the list)
  loadExpenseStats();
}

let _expCatType = 'expense';   // category ranking shows expense or income
let _expCatFilter = null;      // raw category clicked in the ranking ('' = 未分類); null = no filter
let _expStats = null;          // /api/expenses/stats of the selected year
let _expAll = [];              // /api/expenses
let _expMonthlyChart = null;

/** Series colors from CSS (validated for CVD separation on the card surface). */
const seriesColor = (name) => getComputedStyle(document.documentElement).getPropertyValue(`--series-${name}`).trim();

function initMonthSelector() {
  const select = document.getElementById('exp-month-filter');
  select.innerHTML = '<option value="0">全年</option>' +
    Array.from({ length: 12 }, (_, i) => `<option value="${i + 1}">${i + 1}月</option>`).join('');
  select.value = String(new Date().getMonth() + 1);
}

/** The month rows a period covers: one month, or the whole year when month is 0. */
const periodMonths = (stats, month) => (month ? [stats.months[month - 1]] : stats.months);

const expYear = () => Number(document.getElementById('exp-year-filter').value) || new Date().getFullYear();
const expMonth = () => Number(document.getElementById('exp-month-filter').value) || 0; // 0 = whole year

/** Records (all years) + the selected year's stats; after a record changes. */
async function loadExpenses() {
  try {
    // Offline estimates → market rates when there's a connection (a no-op otherwise)
    if (_expAll.some(e => e.fx_pending) || !_expAll.length) await api('/api/expenses/refresh-fx', { method: 'POST' }).catch(() => {});
    const expenses = await api('/api/expenses');
    _expAll = Array.isArray(expenses) ? expenses : [];
  } catch (err) {
    showToast('載入收支資料失敗: ' + err.message, 'error');
    return;
  }
  await loadExpenseStats();
}

// Back online with offline-estimated rates on screen: fetch the market rates
window.addEventListener('online', () => {
  if (document.body.dataset.tab === 'expenses' && _expAll.some(e => e.fx_pending)) loadExpenses();
});

// Swipe left / right on the 收支 page = next / previous month (same as › ‹). Ignored when the swipe
// starts on a control or something that scrolls sideways itself, or at the screen edge (back gesture).
(function initExpenseSwipe() {
  const page = document.getElementById('tab-expenses');
  let start = null;
  page.addEventListener('touchstart', (e) => {
    const t = e.touches[0];
    const edge = t.clientX < 24 || t.clientX > window.innerWidth - 24;
    start = e.touches.length === 1 && !edge && !e.target.closest('input, select, textarea, button, canvas, .chart-type-toggle, .table-wrap, .modal')
      ? { x: t.clientX, y: t.clientY, at: Date.now() } : null;
  }, { passive: true });
  page.addEventListener('touchend', (e) => {
    if (!start) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - start.x;
    const dy = t.clientY - start.y;
    const quick = Date.now() - start.at < 600;
    start = null;
    if (quick && Math.abs(dx) > 60 && Math.abs(dx) > 2 * Math.abs(dy)) stepExpPeriod(dx < 0 ? 1 : -1);
  }, { passive: true });
})();

/** Only the selected year's stats (records don't depend on the year); the latest call wins when years change quickly. */
let _expStatsSeq = 0;
async function loadExpenseStats() {
  const seq = ++_expStatsSeq;
  try {
    const stats = await api(`/api/expenses/stats?year=${expYear()}`);
    if (seq !== _expStatsSeq) return;
    _expStats = stats;
    setExpenseStartYear(stats.first_year);
    if (_expAutoMonth) {
      _expAutoMonth = false;
      const withData = stats.months.filter(m => m.income || m.expense).map(m => m.month);
      if (withData.length && !withData.includes(expMonth())) {
        document.getElementById('exp-month-filter').value = String(Math.max(...withData));
      }
    }
    renderExpensePage();
  } catch (err) {
    showToast('載入收支資料失敗: ' + err.message, 'error');
  }
}

/** Everything below the period selector, from the cached data (no fetch). */
function renderExpensePage() {
  if (!_expStats) return; // not loaded yet
  const month = expMonth();
  document.getElementById('exp-prev').disabled = !nextExpPeriod(-1);
  document.getElementById('exp-next').disabled = !nextExpPeriod(1);
  renderExpenseSummary(_expStats, month);
  renderCategoryRank(_expStats, month);
  renderMonthlyChart(_expStats, month);
  renderExpenseTable(month);
}

/** Percent change vs. a previous value, or '' when there is nothing to compare. */
function changeText(cur, prev, label) {
  if (!prev) return '';
  const pct = (cur - prev) / prev * 100;
  return `${label} ${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`;
}

const savingRate = (income, expense) => (income > 0 ? `${((income - expense) / income * 100).toFixed(1)}%` : '--');

function renderExpenseSummary(stats, month) {
  const sumOf = (ms, k) => ms.reduce((s, m) => s + m[k], 0);
  const months = periodMonths(stats, month);
  const income = sumOf(months, 'income');
  const expense = sumOf(months, 'expense');
  const net = income - expense;
  const prev = month ? (month > 1 ? stats.months[month - 2] : stats.prev_december) : null;
  const active = stats.months.filter(m => m.income || m.expense).length;
  const set = (id, html, cls = '') => {
    const el = document.getElementById(id);
    el.innerHTML = html;
    el.classList.remove('positive', 'negative');
    if (cls) el.classList.add(cls);
  };

  set('exp-sum-income', fmtTWD(income));
  set('exp-sum-expense', fmtTWD(expense));
  set('exp-sum-net', fmtPL(net), plClass(net));
  set('exp-sum-rate', savingRate(income, expense), income > 0 ? plClass(net) : '');

  if (month) {
    const hasPrev = prev.income || prev.expense;
    set('exp-sum-income-sub', changeText(income, prev.income, '較上月'));
    set('exp-sum-net-sub', hasPrev ? `上月 ${fmtPL(prev.income - prev.expense)}` : '');
    set('exp-sum-rate-sub', prev.income > 0 ? `上月 ${savingRate(prev.income, prev.expense)}` : '');
  } else {
    set('exp-sum-income-sub', active ? `月平均 ${fmtTWD(income / active)}` : '');
    set('exp-sum-net-sub', active ? `月平均 ${fmtPL(net / active)}` : '');
    set('exp-sum-rate-sub', active ? `${active} 個月有紀錄` : '');
  }
  if (month) {
    set('exp-sum-expense-sub', changeText(expense, prev.expense, '較上月'));
  } else {
    set('exp-sum-expense-sub', active ? `月平均 ${fmtTWD(expense / active)}` : '');
  }
}

function renderCategoryRank(stats, month) {
  const totals = {};
  for (const m of periodMonths(stats, month)) {
    for (const [c, v] of Object.entries(m.by_category[_expCatType])) totals[c] = (totals[c] || 0) + v;
  }
  const rows = Object.entries(totals).sort((a, b) => b[1] - a[1]);
  const el = document.getElementById('exp-cat-list');
  if (!rows.length) {
    el.innerHTML = `<p class="empty-state">這段期間沒有${_expCatType === 'income' ? '收入' : '支出'}紀錄</p>`;
    return;
  }
  const sum = rows.reduce((s, r) => s + r[1], 0);
  const max = rows[0][1];
  el.style.setProperty('--cat-color', seriesColor(_expCatType));
  el.innerHTML = rows.map(([c, v]) => `
    <button type="button" class="cat-row${c === _expCatFilter ? ' active' : ''}" data-cat="${escapeAttr(c)}" onclick="setCategoryFilter(this.dataset.cat)">
      <span class="cat-name">${escapeHtml(catDisplay(c))}</span>
      <span class="source-bar cat-track"><span style="width:${(v / max * 100).toFixed(1)}%"></span></span>
      <span class="cat-amt">${fmtTWD(v)}</span>
      <span class="cat-pct">${(v / sum * 100).toFixed(1)}%</span>
    </button>`).join('');
}

function renderMonthlyChart(stats, month) {
  // The selected month stays solid; the others fade (+ hex alpha, so --series-* must be #rrggbb)
  const colors = (name) => stats.months.map(m => (!month || m.month === month ? seriesColor(name) : seriesColor(name) + '59'));
  const series = [['收入', 'income'], ['支出', 'expense']];
  if (_expMonthlyChart) {
    _expMonthlyChart.data.datasets.forEach((ds, i) => {
      ds.data = stats.months.map(m => m[series[i][1]]);
      ds.backgroundColor = colors(series[i][1]);
    });
    _expMonthlyChart.update();
    return;
  }
  _expMonthlyChart = new Chart(document.getElementById('chart-exp-monthly'), {
    type: 'bar',
    data: {
      labels: stats.months.map(m => `${m.month}月`),
      datasets: series.map(([label, key]) => ({
        label, data: stats.months.map(m => m[key]), backgroundColor: colors(key),
        borderRadius: 4, borderSkipped: 'bottom',
      })),
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      datasets: { bar: { categoryPercentage: 0.7, barPercentage: 0.9 } },
      interaction: { mode: 'index', intersect: false },
      onClick: (_, els) => {
        if (!els.length) return;
        document.getElementById('exp-month-filter').value = String(els[0].index + 1);
        renderExpensePage();
      },
      onHover: (e, els) => { e.native.target.style.cursor = els.length ? 'pointer' : 'default'; },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: c => `${c.dataset.label}: ${fmtTWD(c.parsed.y)}`,
            footer: items => `結餘: ${fmtPL(items[0].parsed.y - items[1].parsed.y)}`,
          },
        },
      },
      scales: {
        x: { ticks: { ...CHART_AXIS.ticks, maxRotation: 0, autoSkip: true }, grid: { display: false } },
        y: { beginAtZero: true, ticks: { ...CHART_AXIS.ticks, precision: 0, callback: v => fmt(v) }, grid: CHART_AXIS.grid },
      },
    },
  });
}

function setCategoryType(type) {
  _expCatType = type;
  document.querySelectorAll('[data-cat-type]').forEach(b => b.classList.toggle('active', b.dataset.catType === type));
  document.getElementById('exp-cat-title').textContent = type === 'income' ? '收入分類' : '支出分類';
  if (_expStats) renderCategoryRank(_expStats, expMonth());
}

function setCategoryFilter(cat) {
  _expCatFilter = cat !== _expCatFilter ? cat : null; // clicking the active row clears it
  const chip = document.getElementById('exp-cat-chip');
  chip.style.display = _expCatFilter === null ? 'none' : '';
  chip.textContent = _expCatFilter === null ? '' : `分類：${catLabel(_expCatFilter)} ✕`;
  if (!_expStats) return;
  renderCategoryRank(_expStats, expMonth());
  renderExpenseTable(expMonth());
}

/** TWD records as before; foreign ones in their currency with the TWD value underneath. */
function expAmountCell(e) {
  if ((e.currency || 'TWD') === 'TWD') return fmtTWD(e.amount);
  const est = e.fx_pending ? '<span title="離線時記的，用之前的匯率估算；有網路時自動更新"> · 估算</span>' : '';
  return `${fmtMoney(e.amount, e.currency)}<span class="cell-sub">≈ ${fmtTWD(e.amount_twd)}${est}</span>`;
}

/** The search box re-renders once typing pauses (the list can be every record). */
let _expSearchTimer = null;
function onExpenseSearch() {
  clearTimeout(_expSearchTimer);
  _expSearchTimer = setTimeout(() => renderExpenseTable(expMonth()), 150);
}

/** Search: every word must appear in the note, category or currency (code / name / aliases), or equal the amount. */
function expenseMatches(e, words) {
  const c = expCurrency(e.currency);
  const text = [e.note, catLabel(e.category), c.code, c.symbol, c.name, ...c.aliases].join(' ').toLowerCase();
  return words.every(w => text.includes(w) || Number(w.replace(/,/g, '')) === e.amount);
}

/** Income / expense totals in TWD: "收入 +NT$ 1,500 · 支出 NT$ 1,283" (parts with nothing are left out). */
function expTotals(records) {
  let inc = 0, out = 0;
  for (const e of records) if (e.type === 'income') inc += e.amount_twd; else out += e.amount_twd;
  return [inc ? `收入 +${fmtTWD(inc)}` : '', out ? `支出 ${fmtTWD(out)}` : ''].filter(Boolean).join(' · ');
}

// --- 收支 export: pick a period (default: the one on screen), download CSV ---

const pad2 = (n) => String(n).padStart(2, '0');

/** [from, to] of the chosen export range ('' = open end; day 31 is a safe upper bound for any month). */
function expenseExportRange() {
  const f = document.getElementById('export-expenses-form').elements;
  const y = expYear();
  const m = pad2(expMonth());
  switch (f.range.value) {
    case 'month': return [`${y}-${m}-01`, `${y}-${m}-31`];
    case 'year': return [`${y}-01-01`, `${y}-12-31`];
    case 'custom': return [f.from.value, f.to.value];
    default: return ['', ''];
  }
}

function openExpenseExport() {
  const f = document.getElementById('export-expenses-form').elements;
  const y = expYear();
  const m = expMonth();
  document.getElementById('export-range-month').textContent = `${y} 年 ${m} 月`;
  document.getElementById('export-range-month-row').hidden = !m; // 全年 on screen: no single month
  document.getElementById('export-range-year').textContent = `${y} 整年`;
  f.range.value = m ? 'month' : 'year';
  // 自訂 starts as the period on screen
  f.from.value = m ? `${y}-${pad2(m)}-01` : `${y}-01-01`;
  f.to.value = m ? `${y}-${pad2(m)}-${pad2(new Date(y, m, 0).getDate())}` : `${y}-12-31`;
  updateExpenseExportCount();
  openModal('modal-export-expenses');
}

function updateExpenseExportCount() {
  const [from, to] = expenseExportRange();
  const n = _expAll.filter(e => (!from || e.date >= from) && (!to || e.date <= to)).length;
  document.getElementById('export-count').textContent = `共 ${n} 筆`;
}

function submitExpenseExport(ev) {
  ev.preventDefault();
  const [from, to] = expenseExportRange();
  api(`/api/expenses/export?from=${from}&to=${to}`)
    .then(() => closeModal('modal-export-expenses'))
    .catch(err => showToast('匯出失敗: ' + err.message, 'error'));
}

/**
 * The 收支明細 list: the selected month / year, or every record matching the search box. Grouped by
 * day (header: date, weekday, the day's totals); each row: category with note, amount, actions.
 */
function renderExpenseTable(month) {
  const prefix = month ? `${expYear()}-${String(month).padStart(2, '0')}` : String(expYear());
  const words = document.getElementById('exp-search').value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const filtered = _expAll.filter(e => e.date && (words.length ? expenseMatches(e, words) : e.date.startsWith(prefix)) &&
    (_expCatFilter === null || (e.category || '') === _expCatFilter));
  const summary = document.getElementById('exp-search-summary');
  summary.hidden = !words.length;
  summary.textContent = `找到 ${filtered.length} 筆${filtered.length ? ` · ${expTotals(filtered)}` : ''}`;
  const list = document.getElementById('expense-list');
  if (filtered.length === 0) {
    list.innerHTML = `<div class="empty-state">${words.length ? '找不到符合的紀錄' : month ? '這個月尚無紀錄' : '此年度尚無紀錄'}</div>`;
    return;
  }
  const days = new Map(); // date -> records, newest first (the API's order)
  for (const e of filtered) {
    if (!days.has(e.date)) days.set(e.date, []);
    days.get(e.date).push(e);
  }
  list.innerHTML = [...days].map(([date, recs]) => `
      <div class="exp-day"><span>${words.length ? `${date.slice(0, 4)}/` : ''}${dayLabel(date)}</span><span>${expTotals(recs)}</span></div>` +
    recs.map(e => `
      <button type="button" class="exp-row exp-${e.type || 'expense'}" onclick="editExpense(${e.id})" aria-label="編輯 ${escapeAttr(catLabel(e.category))}">
        <span class="e-cat">${escapeHtml(catDisplay(e.category))}${e.note ? `<span class="e-meta">${escapeHtml(e.note)}</span>` : ''}</span>
        <span class="e-amt">${expAmountCell(e)}</span>
      </button>`).join('')).join('');
}

// ============================================================
// SECTION: LLM Analysis
// ============================================================

function getSelectedSections() {
  const sections = [];
  if (document.getElementById('llm-inc-assets')?.checked) sections.push('assets');
  if (document.getElementById('llm-inc-portfolio')?.checked) sections.push('portfolio');
  if (document.getElementById('llm-inc-realized')?.checked) sections.push('realized');
  if (document.getElementById('llm-inc-expenses')?.checked) sections.push('expenses');
  return sections;
}

async function generatePrompt() {
  const sections = getSelectedSections();
  if (sections.length === 0) {
    showToast('請至少勾選一項資料', 'error');
    return;
  }
  try {
    const result = await api('/api/llm/prompt', {
      method: 'POST',
      body: JSON.stringify({ sections }),
    });
    const prompt = result.prompt || '';
    document.getElementById('generated-prompt').value = prompt;
    document.getElementById('prompt-area').style.display = 'block';
    showToast('Prompt 已產生', 'success');
  } catch (err) {
    showToast('產生 Prompt 失敗: ' + err.message, 'error');
  }
}

// ============================================================
// SECTION: AI links + AI import
// ============================================================

// Encoded prompts longer than this aren't put in links: chat sites reject very long URLs.
const AI_LINK_MAX = 7000;

/** AI chat sites. prefill: ?q= on the url fills the chat box (without sending); the rest get the prompt by paste. */
const AI_SITES = [
  { name: 'ChatGPT', url: 'https://chatgpt.com/', prefill: true },
  { name: 'Claude', url: 'https://claude.ai/new', prefill: true },
  { name: 'Gemini', url: 'https://gemini.google.com/app' },
  { name: 'Copilot', url: 'https://copilot.microsoft.com/' },
  { name: 'Grok', url: 'https://grok.com/' },
  { name: 'DeepSeek', url: 'https://chat.deepseek.com/' },
];

let _aiImportPrompt = '';
/** The prompt each `.ai-actions[data-ai]` block hands to the AI, read when a button is clicked. */
const AI_PROMPTS = {
  analysis: () => document.getElementById('generated-prompt').value, // the user may have edited it
  import: () => _aiImportPrompt,
};

/** Every AI site button plus 只複製, always all of them (drawn once; the prompt is read on click). */
function renderAISites() {
  const buttons = AI_SITES.map(s =>
    `<a class="btn btn-outline btn-sm" data-site="${s.name}" href="${s.url}" target="_blank" rel="noopener noreferrer">${s.name}</a>`).join('') +
    '<button type="button" class="btn btn-outline btn-sm" data-copy>只複製</button>';
  document.querySelectorAll('.ai-actions[data-ai]').forEach(el => { el.innerHTML = buttons; });
}

// A click copies the prompt and opens the site, pre-filled where the site supports it and the prompt
// fits in a URL — so the buttons never come and go with the prompt's length, and the mobile apps
// that ignore ?q= still get it by paste. The href is set before the browser follows the link.
document.addEventListener('click', (e) => {
  const block = e.target.closest('.ai-actions[data-ai]');
  const button = block && e.target.closest('[data-site], [data-copy]');
  if (!button) return;
  const prompt = AI_PROMPTS[block.dataset.ai]();
  const site = AI_SITES.find(s => s.name === button.dataset.site);
  if (!site) return copyText(prompt);
  const q = encodeURIComponent(prompt);
  const prefilled = site.prefill && q.length <= AI_LINK_MAX;
  button.href = prefilled ? `${site.url}?q=${q}` : site.url;
  copyText(prompt, prefilled ? '已帶入提示詞（也複製了一份）' : '提示詞已複製，到 AI 對話框貼上即可');
});

function copyText(text, done = '已複製到剪貼簿') {
  navigator.clipboard.writeText(text)
    .then(() => showToast(done, 'success'))
    .catch(() => showToast('複製失敗，請手動選取複製', 'error'));
}

let _aiImportMode = 'add'; // 'replace' = 以對帳單取代 (stock trades)
let _aiImportKindLabels = {}; // kind id -> label, from /api/ai-import/kinds

/** Builds the kind checkboxes once, then refreshes the prompt and links. */
async function initAIImport(preselect) {
  try {
    if (!Object.keys(_aiImportKindLabels).length) {
      const kinds = await api('/api/ai-import/kinds');
      document.getElementById('ai-import-kinds').innerHTML = kinds.map(k => `
        <label class="llm-check"><input type="checkbox" value="${k.id}" checked onchange="refreshAIImportPrompt()"> ${escapeHtml(k.label)}</label>`).join('');
      _aiImportKindLabels = Object.fromEntries(kinds.map(k => [k.id, k.label]));
    }
    if (preselect) {
      document.querySelectorAll('#ai-import-kinds input').forEach(cb => { cb.checked = cb.value === preselect; });
    }
    await refreshAIImportPrompt();
  } catch (err) {
    showToast('AI 匯入初始化失敗: ' + err.message, 'error');
  }
}

const aiImportKinds = () => [...document.querySelectorAll('#ai-import-kinds input:checked')].map(cb => cb.value);

async function refreshAIImportPrompt() {
  const kinds = aiImportKinds();
  document.getElementById('ai-import-steps').style.display = kinds.length ? '' : 'none';
  if (!kinds.length) return;
  const { prompt } = await api('/api/ai-import/prompt', { method: 'POST', body: JSON.stringify({ kinds }) });
  _aiImportPrompt = prompt;
}

/** From another tab (e.g. 收支): open the AI page with only that kind checked. */
async function openAIImport(kind) {
  goToTab('llm');
  await initAIImport(kind);
  document.getElementById('ai-import-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function previewAIImport() {
  const text = document.getElementById('ai-import-text').value;
  const out = document.getElementById('ai-import-preview');
  if (!text.trim()) {
    showToast('請先貼上 AI 的回覆', 'error');
    return;
  }
  try {
    const parsed = await api('/api/ai-import/parse', { method: 'POST', body: JSON.stringify({ text, kinds: aiImportKinds(), mode: _aiImportMode }) });
    const replacing = _aiImportMode === 'replace' && Object.values(parsed).some(r => r.plan);
    const blocked = replacing && Object.values(parsed).some(r => r.plan && !r.plan.ok);
    const total = Object.values(parsed).reduce((n, r) => n + r.records.length, 0);
    out.innerHTML = Object.entries(parsed).map(([kind, r]) => renderImportSection(kind, r)).join('') +
      (blocked ? '<p class="import-error">上面列的問題解決前不能取代；可以取消勾選，改用一般匯入（只新增、略過重複）。</p>'
        : total ? `<button class="btn btn-primary" onclick="commitAIImport()">${replacing ? '確認取代並匯入' : '確認匯入'} ${total} 筆</button>`
        : '<p class="form-hint">沒有新的資料可以匯入。</p>');
  } catch (err) {
    out.innerHTML = `<p class="import-error">${escapeHtml(err.message)}</p>`;
  }
}

/** Preview columns per kind: [header, cell(row) -> html]. */
const IMPORT_COLUMNS = {
  expenses: [
    ['日期', e => e.date],
    ['類型', e => `<span class="tag-${e.type}">${e.type === 'income' ? '收入' : '支出'}</span>`],
    ['分類', e => escapeHtml(catDisplay(e.category))],
    ['金額', expAmountCell],
    ['備註', e => escapeHtml(e.note || '')],
  ],
  transactions: [
    ['日期', t => t.date],
    ['股票', t => escapeHtml(t.symbol)],
    ['買賣', t => `<span class="tag-${t.action === 'BUY' ? 'income' : 'expense'}">${t.action === 'BUY' ? '買進' : '賣出'}</span>`],
    ['股數', t => fmt(t.shares)],
    ['成交價', t => fmtPrice(t.price, t.currency)],
    ['手續費 / 稅', t => `${fmtCur(t.fee, t.currency)} / ${fmtCur(t.tax, t.currency)}`],
    ['損益', t => (t.history ? `<span class="${plClass(t.realized_pl)}">${fmtPLCur(t.realized_pl, t.currency)}</span>` : '<span class="text-muted">自動計算</span>')],
    ['備註', t => escapeHtml(t.note || '') + (t.flags || []).map(f => `<div class="import-flag">${escapeHtml(f)}</div>`).join('')],
  ],
};

/** Preview of one kind: counts, warnings, the rows to add (first 100) and the rows that were skipped. */
function renderImportSection(kind, r) {
  const label = _aiImportKindLabels[kind] || kind;
  const head = `<p class="import-summary"><strong>${escapeHtml(label)}</strong>：新增 ${r.records.length} 筆` +
    (r.duplicates ? `，略過 ${r.duplicates} 筆重複` : '') + (r.errors.length ? `，${r.errors.length} 筆無法匯入` : '') + '</p>';
  const warnings = (r.warnings || []).map(w => `<p class="import-warning">${escapeHtml(w)}</p>`).join('');
  const cols = IMPORT_COLUMNS[kind] || [];
  const table = r.records.length && cols.length ? `<div class="table-wrap"><table>
    <thead><tr>${cols.map(([h]) => `<th>${h}</th>`).join('')}</tr></thead>
    <tbody>${r.records.slice(0, 100).map(row => `<tr>${cols.map(([, cell]) => `<td>${cell(row)}</td>`).join('')}</tr>`).join('')}</tbody>
    </table></div>` + (r.records.length > 100 ? '<p class="form-hint">只顯示前 100 筆。</p>' : '') : '';
  const errors = r.errors.length ? `<ul class="import-errors">${r.errors.map(x => `<li>第 ${x.index + 1} 筆：${escapeHtml(x.error)}</li>`).join('')}</ul>` : '';
  return head + (r.plan ? renderReplacePlan(r.plan) : '') + warnings + table + errors;
}

/** The 「以對帳單取代」 option; when checked, what will be removed and the reworked 匯入持倉. */
function renderReplacePlan(plan) {
  const on = _aiImportMode === 'replace';
  const syms = plan.symbols.map(s => escapeHtml(s.symbol)).join('、');
  let html = `<div class="replace-box">
    <label class="llm-check"><input type="checkbox" ${on ? 'checked' : ''} onchange="setAIImportMode(this.checked)"> 以對帳單取代這幾檔股票的交易</label>
    <p class="form-hint">把 ${syms} 在下面各自期間內的舊交易換成這份對帳單；期間開始前的持股用一筆「匯入持倉」補上（由目前持股倒推）。
    同一檔股票如果在別的券商帳戶也有交易，請不要勾：那些交易會一起被刪掉。</p>`;
  if (on) {
    html += plan.problems.map(x => `<p class="replace-problem">✗ ${escapeHtml(x)}</p>`).join('') +
      plan.checks.map(x => `<p class="replace-check">✓ ${escapeHtml(x)}</p>`).join('');
    html += plan.symbols.map(s => {
      const before = s.transfers.length
        ? s.transfers.map(t => `${t.date} ${fmt(t.shares)} 股`).join('、') : '（沒有）';
      const after = s.transfer ? `${s.transfer.date} ${fmt(s.transfer.shares)} 股 @ ${fmtNum(s.transfer.price, 2)}` : '（刪除）';
      const rows = s.remove.map(t => `<li>${t.date} ${t.action === 'BUY' ? '買進' : '賣出'} ${fmt(t.shares)} 股 @ ${fmtNum(t.price, 2)}${t.history ? '（歷史損益）' : ''}${t.note ? ' · ' + escapeHtml(t.note) : ''}</li>`).join('');
      return `<details class="replace-symbol"><summary><strong>${escapeHtml(s.symbol)}</strong>（${s.start} ~ ${s.end}）：刪除 ${s.remove.length} 筆舊交易；
        匯入持倉 ${before} → ${after}；匯入後持股 ${fmt(s.current)} 股（不變）</summary>
        ${rows ? `<ul>${rows}</ul>` : '<p class="form-hint">期間內沒有舊交易。</p>'}</details>`;
    }).join('');
  }
  return html + '</div>';
}

function setAIImportMode(replace) {
  _aiImportMode = replace ? 'replace' : 'add';
  previewAIImport();
}

/** Settings: delete every self-account trade and holding (before re-importing full statements). */
async function clearStockData() {
  const market = document.getElementById('clear-stock-market').value;
  const name = { TW: '台股', US: '美股', ALL: '台股與美股' }[market];
  try {
    const c = await api('/api/stocks/clear', { method: 'POST', body: JSON.stringify({ market, dry: true }) });
    // An older copy of the delete code (mixed versions right after a deploy) ignores `market`
    if (c.market !== market) return showToast('網頁版本不一致，沒有刪除任何東西：請重新整理後再試', 'error');
    if (!c.transactions && !c.holdings) return showToast(`沒有${name}的交易或持倉可以清除`, 'info');
    if (!confirm(`將刪除自己帳戶${name}的 ${c.transactions} 筆交易（含匯入持倉、歷史損益）與 ${c.holdings} 檔持倉，並同步刪除試算表上的資料。
${market === 'ALL' ? '' : `${market === 'TW' ? '美股' : '台股'}、`}股利、資產快照、收支、代管帳戶不受影響。

建議先「下載備份」。確定要清除嗎？`)) return;
    await api('/api/stocks/clear', { method: 'POST', body: JSON.stringify({ market, expect: { transactions: c.transactions, holdings: c.holdings } }) });
    showToast(`已清除 ${c.transactions} 筆交易、${c.holdings} 檔持倉`, 'success');
  } catch (err) {
    showToast('清除失敗: ' + err.message, 'error');
  }
}

async function commitAIImport() {
  const text = document.getElementById('ai-import-text').value;
  try {
    const counts = await api('/api/ai-import/commit', { method: 'POST', body: JSON.stringify({ text, kinds: aiImportKinds(), mode: _aiImportMode }) });
    const n = Object.values(counts).reduce((a, b) => a + b, 0);
    showToast(`已匯入 ${n} 筆`, 'success');
    document.getElementById('ai-import-text').value = '';
    document.getElementById('ai-import-preview').innerHTML = '';
    _aiImportMode = 'add';
  } catch (err) {
    showToast('匯入失敗: ' + err.message, 'error');
  }
}

/** For a value inside a double-quoted attribute (escapeHtml leaves quotes alone). */
const escapeAttr = (text) => escapeHtml(text).replace(/"/g, '&quot;');

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ============================================================
// SECTION: Settings
// ============================================================

async function loadSettings() {
  try {
    window.renderCloudStatus?.();

    // Version
    try {
      const ver = await api('/api/version');
      document.getElementById('settings-version').textContent = 'v' + (ver.version || '?');
    } catch (_) {}

    loadGoalSettings();
    loadLiabilities();

    // Font size buttons
    const saved = localStorage.getItem('fontSize') || 'm';
    document.querySelectorAll('.font-btn').forEach(b => {
      b.classList.toggle('active', b.textContent.trim().toLowerCase().startsWith(saved));
    });
  } catch (err) {
    // Settings may not exist yet
  }
}

// ============================================================
// SECTION: Settings › 財務目標 / 負債
// ============================================================

async function loadGoalSettings() {
  const [s, ov] = await Promise.all([api('/api/settings'), api('/api/overview').catch(() => null)]);
  document.getElementById('goal-monthly-expense').value = s.monthly_expense || '';
  document.getElementById('goal-withdraw-rate').value = s.withdraw_rate || '';
  const est = ov && ov.fire && ov.fire.recorded_monthly_expense;
  document.getElementById('goal-monthly-expense').placeholder = est ? `依收支估 ${Math.round(est)}` : '例如 50000';
}

async function saveGoalSetting(key, value) {
  try {
    await api('/api/settings', { method: 'PUT', body: JSON.stringify({ [key]: value === '' ? '' : String(Number(value)) }) });
    showToast('已儲存', 'success');
  } catch (err) {
    showToast('儲存失敗: ' + err.message, 'error');
  }
}

let _liabilities = [];
async function loadLiabilities() {
  _liabilities = await api('/api/liabilities').catch(() => []);
  const el = document.getElementById('liab-list');
  el.innerHTML = _liabilities.length ? _liabilities.map(l => `
    <div class="settings-row">
      <div><strong>${escapeHtml(l.name)}</strong><p class="form-hint">更新於 ${l.updated || '--'}</p></div>
      <div class="liab-actions">
        <span class="liab-balance">${fmtTWD(l.balance)}</span>
        ${rowBtn('edit', `editLiability(${l.id})`)}
        ${rowBtn('delete', `deleteLiability(${l.id})`)}
      </div>
    </div>`).join('') : '';
  resetLiabilityForm();
}

function resetLiabilityForm() {
  const f = document.getElementById('liab-form');
  f.reset();
  f.liab_id.value = '';
  f.querySelector('[type=submit]').textContent = '新增';
  document.getElementById('liab-cancel').hidden = true;
}

function editLiability(id) {
  const l = _liabilities.find(x => x.id === id);
  if (!l) return;
  const f = document.getElementById('liab-form');
  f.liab_id.value = l.id;
  f.liab_name.value = l.name;
  f.liab_balance.value = l.balance;
  f.querySelector('[type=submit]').textContent = '更新';
  document.getElementById('liab-cancel').hidden = false;
  f.liab_balance.focus();
}

async function submitLiability(e) {
  e.preventDefault();
  const f = e.target;
  const id = f.liab_id.value;
  try {
    await api(id ? `/api/liabilities/${id}` : '/api/liabilities', {
      method: id ? 'PUT' : 'POST',
      body: JSON.stringify({ name: f.liab_name.value, balance: Number(f.liab_balance.value) }),
    });
    showToast(id ? '負債已更新' : '負債已新增', 'success');
    loadLiabilities();
  } catch (err) {
    showToast('儲存失敗: ' + err.message, 'error');
  }
}

async function deleteLiability(id) {
  if (!confirm('確定要刪除這筆負債嗎？')) return;
  try {
    await api(`/api/liabilities/${id}`, { method: 'DELETE' });
    loadLiabilities();
  } catch (err) {
    showToast('刪除失敗: ' + err.message, 'error');
  }
}

/** USD/TWD from the market, saved for every TWD conversion; refreshed in the background at startup (keeps the last rate when offline). */
async function refreshUSDTWDRate() {
  try {
    return (await api('/api/settings/refresh-rate', { method: 'POST' })).usd_twd_rate;
  } catch (err) {
    return null;
  }
}

// ============================================================
// SECTION: Initialization
// ============================================================

function setFontSize(size) {
  document.documentElement.className = document.documentElement.className.replace(/font-[sml]/g, '').trim();
  document.documentElement.classList.add('font-' + size);
  localStorage.setItem('fontSize', size);
  document.querySelectorAll('.font-btn').forEach(b => {
    b.classList.toggle('active', b.textContent.trim().toLowerCase() === size);
  });
}

function initFontSize() {
  const saved = localStorage.getItem('fontSize') || 'm';
  setFontSize(saved);
}

/**
 * js/main.js (the data layer) failed to load — almost always a page opened while a deploy was
 * landing, with files from two versions. Say so with a reload button instead of loading forever.
 */
function showLoadFailure() {
  document.body.dataset.loadFailed = ''; // tour.js doesn't start over it
  const box = document.createElement('div');
  box.className = 'load-failure';
  box.setAttribute('role', 'alert');
  box.innerHTML = '<p>⚠️ 網站剛更新，有部分檔案沒有載入完成</p><button type="button" class="btn btn-primary" onclick="location.reload()">重新整理</button>';
  document.body.appendChild(box);
}

document.addEventListener('DOMContentLoaded', () => {
  // Module scripts run before DOMContentLoaded, so no LocalAPI here means main.js failed
  if (!window.LocalAPI) return showLoadFailure();
  initFontSize();
  applyIcons();
  initTapTips();
  applyPrivacyUI();
  initTabs();
  initExpenseDefaults();
  renderAISites();

  // Set default date on transaction form
  const txDateInput = document.querySelector('#tx-form [name="date"]');
  if (txDateInput) txDateInput.value = todayStr();

  // Load dashboard data
  loadDashboard();

  initHoldingsView();

  // Silently refresh USD/TWD rate in background (best-effort, won't block UI)
  refreshUSDTWDRate().then(() => {
    // Re-render dashboard if rate changed so live numbers reflect new rate
    if (document.querySelector('#tab-dashboard.active')) loadDashboard();
  });
});

// ============================================================
// SECTION: Managed Accounts
// ============================================================

let _managedAccounts = [];
let _currentManagedAccountId = null;
let _currentManagedSummary = null;

async function loadManagedAccounts() {
  try {
    const accounts = await api('/api/managed/accounts');
    _managedAccounts = Array.isArray(accounts) ? accounts : [];
    renderManagedAccountTabs();
    if (_managedAccounts.length === 0) {
      document.getElementById('managed-empty-state').style.display = '';
      document.getElementById('managed-account-view').style.display = 'none';
      _currentManagedAccountId = null;
      return;
    }
    document.getElementById('managed-empty-state').style.display = 'none';
    // Keep current selection if still exists; otherwise pick first
    const stillExists = _managedAccounts.some(a => a.id === _currentManagedAccountId);
    if (!stillExists) _currentManagedAccountId = _managedAccounts[0].id;
    await loadManagedAccountSummary(_currentManagedAccountId);
  } catch (err) {
    showToast('載入代管帳戶失敗: ' + err.message, 'error');
  }
}

function renderManagedAccountTabs() {
  const tabsEl = document.getElementById('managed-account-tabs');
  if (_managedAccounts.length === 0) {
    tabsEl.innerHTML = '';
    return;
  }
  tabsEl.innerHTML = _managedAccounts.map(a => `
    <button class="sub-tab-btn ${a.id === _currentManagedAccountId ? 'active' : ''}" onclick="selectManagedAccount(${a.id})">${escapeHtml(a.name)}</button>
  `).join('');
}

async function selectManagedAccount(id) {
  _currentManagedAccountId = id;
  closeManagedSnapshotDetail();
  renderManagedAccountTabs();
  await loadManagedAccountSummary(id);
}

async function loadManagedAccountSummary(id) {
  try {
    const summary = await api('/api/managed/accounts/' + id + '/summary');
    _currentManagedSummary = summary;
    document.getElementById('managed-account-view').style.display = '';

    document.getElementById('mng-cash-twd').textContent = fmtTWD(summary.account.cash_twd);
    document.getElementById('mng-cash-usd').textContent = fmtUSD(summary.account.cash_usd);
    document.getElementById('mng-stock-value').textContent = fmtTWD(summary.stock_value_twd);
    document.getElementById('mng-unrealized').innerHTML = `<span class="${plClass(summary.unrealized_pl_twd)}">${fmtTWD(summary.unrealized_pl_twd)}</span>`;
    document.getElementById('mng-total').textContent = fmtTWD(summary.total_value_twd);
    document.getElementById('mng-realized').innerHTML = `<span class="${plClass(summary.realized_pl_twd)}">${fmtTWD(summary.realized_pl_twd)}</span>`;

    // Holdings
    const holdings = summary.holdings || [];
    const hBody = document.getElementById('mng-holdings-body');
    if (holdings.length === 0) {
      hBody.innerHTML = '<tr><td colspan="9" class="empty-state">尚無持倉</td></tr>';
    } else {
      hBody.innerHTML = holdings.map(h => {
        const curSym = h.currency === 'USD' ? '$' : 'NT$';
        return `<tr>
          <td>${escapeHtml(h.symbol)}</td>
          <td>${h.market}</td>
          <td>${fmt(h.shares, 2)}</td>
          <td>${fmtPrice(h.avg_cost, h.currency)}</td>
          <td>${fmtPrice(h.current_price, h.currency)}</td>
          <td>${curSym}${fmt(h.market_value, 2)}</td>
          <td>${fmtTWD(h.market_value_twd)}</td>
          <td><span class="${plClass(h.unrealized_pl_twd)}">${fmtTWD(h.unrealized_pl_twd)}</span></td>
          <td><span class="${plClass(h.pl_percent)}">${fmtPct(h.pl_percent)}</span></td>
        </tr>`;
      }).join('');
    }

    // Transactions
    const txns = summary.transactions || [];
    const tBody = document.getElementById('mng-tx-body');
    if (txns.length === 0) {
      tBody.innerHTML = '<tr><td colspan="9" class="empty-state">尚無交易</td></tr>';
    } else {
      tBody.innerHTML = txns.map(t => {
        const curSym = t.currency === 'USD' ? '$' : 'NT$';
        return `<tr>
          <td>${t.date}</td>
          <td>${escapeHtml(t.symbol)}</td>
          <td><span class="${t.action === 'BUY' ? 'tag-buy' : 'tag-sell'}">${t.action === 'BUY' ? '買' : '賣'}</span></td>
          <td>${fmt(t.shares, 2)}</td>
          <td>${fmtPrice(t.price, t.currency)}</td>
          <td>${curSym}${fmt(t.fee, 2)}</td>
          <td><span class="${plClass(t.realized_pl)}">${curSym}${fmt(t.realized_pl, 2)}</span></td>
          <td>${escapeHtml(t.note || '')}</td>
          <td>${rowBtn('delete', `deleteManagedTransaction(${t.id})`)}</td>
        </tr>`;
      }).join('');
    }

    // Cash movements
    const moves = summary.cash_movements || [];
    const cBody = document.getElementById('mng-cash-body');
    if (moves.length === 0) {
      cBody.innerHTML = '<tr><td colspan="6" class="empty-state">尚無紀錄</td></tr>';
    } else {
      cBody.innerHTML = moves.map(m => {
        const curSym = m.currency === 'USD' ? '$' : 'NT$';
        const isDeposit = m.type === 'deposit';
        const sign = isDeposit ? '+' : '-';
        const cls = isDeposit ? 'positive' : 'negative';
        const label = isDeposit ? '存入' : '提領';
        return `<tr>
          <td>${m.date}</td>
          <td><span class="${isDeposit ? 'tag-buy' : 'tag-sell'}">${label}</span></td>
          <td>${m.currency}</td>
          <td><span class="${cls}">${sign}${curSym}${fmt(m.amount, 2)}</span></td>
          <td>${escapeHtml(m.note || '')}</td>
          <td>${rowBtn('delete', `deleteManagedCashMovement(${m.id})`)}</td>
        </tr>`;
      }).join('');
    }
    await loadManagedSnapshots(id);
  } catch (err) {
    showToast('載入帳戶資料失敗: ' + err.message, 'error');
  }
}

// ---------- Managed account snapshots (per-account) ----------

let _mngSnapshotChart = null;
let _mngSnapshots = [];

async function takeManagedSnapshot() {
  if (!_currentManagedAccountId) {
    showToast('請先選擇帳戶', 'error');
    return;
  }
  try {
    const snap = await api('/api/managed/accounts/' + _currentManagedAccountId + '/snapshot', { method: 'POST' });
    showToast(`快照已記錄！總價值 ${fmtTWD(snap.total_value_twd)}`, 'success');
    // Rate may have been refreshed, so reload the whole account view
    await loadManagedAccountSummary(_currentManagedAccountId);
  } catch (err) {
    showToast('快照記錄失敗: ' + err.message, 'error');
  }
}

async function loadManagedSnapshots(id) {
  const tbody = document.getElementById('mng-snapshot-body');
  try {
    const list = await api('/api/managed/accounts/' + id + '/snapshots');
    _mngSnapshots = Array.isArray(list) ? list : [];

    // Chart wants chronological order (API returns DESC)
    renderManagedSnapshotChart([..._mngSnapshots].reverse());

    if (_mngSnapshots.length === 0) {
      tbody.innerHTML = '<tr><td colspan="8" class="empty-state">尚無快照，點擊上方按鈕記錄</td></tr>';
      return;
    }
    tbody.innerHTML = _mngSnapshots.map((s, idx) => `
      <tr>
        <td><a href="#" onclick="viewManagedSnapshotDetail(${idx});return false">${s.date}</a>${s.note ? ` <small class="text-muted">${escapeHtml(s.note)}</small>` : ''}</td>
        <td>${fmtTWD(s.cash_twd)}</td>
        <td>${fmtUSD(s.cash_usd)}</td>
        <td>${fmtTWD(s.stock_value_twd)}</td>
        <td class="${plClass(s.unrealized_pl_twd)}">${fmtTWD(s.unrealized_pl_twd)}</td>
        <td><strong>${fmtTWD(s.total_value_twd)}</strong></td>
        <td>${fmtNum(s.usd_twd_rate, 2)}</td>
        <td>
          ${rowBtn('view', `viewManagedSnapshotDetail(${idx})`)}
          ${rowBtn('delete', `deleteManagedSnapshot(${s.id})`)}
        </td>
      </tr>
    `).join('');
  } catch (err) {
    showToast('載入快照失敗: ' + err.message, 'error');
  }
}

function renderManagedSnapshotChart(list) {
  const ctx = document.getElementById('chart-mng-snapshot');
  if (_mngSnapshotChart) _mngSnapshotChart.destroy();
  if (!list || list.length === 0) {
    _mngSnapshotChart = null;
    return;
  }

  _mngSnapshotChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: list.map(s => s.date),
      datasets: [
        {
          label: '總價值',
          data: list.map(s => s.total_value_twd),
          borderColor: '#4e8cff',
          backgroundColor: 'rgba(78, 140, 255, 0.08)',
          fill: true,
          tension: 0.35,
          pointRadius: 4,
          pointHoverRadius: 6,
          borderWidth: 2,
        },
        {
          label: '現金 (TWD計)',
          data: list.map(s => s.cash_total_twd),
          borderColor: '#34d399',
          backgroundColor: 'transparent',
          tension: 0.35,
          pointRadius: 3,
          borderWidth: 1.5,
          borderDash: [4, 2],
        },
        {
          label: '股票市值',
          data: list.map(s => s.stock_value_twd),
          borderColor: '#fbbf24',
          backgroundColor: 'transparent',
          tension: 0.35,
          pointRadius: 3,
          borderWidth: 1.5,
          borderDash: [4, 2],
        },
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          display: true,
          position: 'top',
          labels: { color: '#8a9ab5', usePointStyle: true, pointStyle: 'line', font: { size: 11 } }
        },
        tooltip: {
          callbacks: { label: c => `${c.dataset.label}: ${fmtTWD(c.parsed.y)}` }
        }
      },
      scales: {
        x: { ticks: { color: '#5c6f8a', font: { size: 11 } }, grid: { color: 'rgba(42,58,78,0.4)' } },
        y: {
          ticks: { color: '#5c6f8a', font: { size: 11 }, callback: v => fmt(v) },
          grid: { color: 'rgba(42,58,78,0.4)' },
        }
      }
    }
  });
}

function viewManagedSnapshotDetail(idx) {
  const s = _mngSnapshots[idx];
  if (!s) return;

  let details = [];
  try { details = JSON.parse(s.detail_json); } catch (_) {}

  const card = document.getElementById('mng-snapshot-detail-card');
  document.getElementById('mng-snapshot-detail-title').textContent = `快照明細 - ${s.date}（匯率 ${fmtNum(s.usd_twd_rate, 2)}）`;

  const tbody = document.getElementById('mng-snapshot-detail-body');
  if (!details || details.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty-state">此快照無持倉</td></tr>';
  } else {
    const groups = [
      { key: 'TW', label: '\u{1F1F9}\u{1F1FC} 台股', rows: details.filter(d => d.market === 'TW') },
      { key: 'US', label: '\u{1F1FA}\u{1F1F8} 美股', rows: details.filter(d => d.market !== 'TW') },
    ];
    let html = '';
    groups.forEach(g => {
      if (g.rows.length === 0) return;
      html += `<tr class="market-group-header"><td colspan="7">${g.label}</td></tr>`;
      html += g.rows.map(d => renderSnapshotDetailRow(d)).join('');
      const total = g.rows.reduce((a, d) => a + d.value_twd, 0);
      const pl = g.rows.reduce((a, d) => a + d.pl_twd, 0);
      html += `<tr class="market-subtotal"><td colspan="5">${g.key === 'TW' ? '台股' : '美股'}小計</td><td>${fmtTWD(total)}</td><td class="${plClass(pl)}">${fmtTWD(pl)}</td></tr>`;
    });
    tbody.innerHTML = html;
  }

  card.style.display = 'block';
  card.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function closeManagedSnapshotDetail() {
  document.getElementById('mng-snapshot-detail-card').style.display = 'none';
}

async function deleteManagedSnapshot(id) {
  if (!confirm('確定要刪除此快照嗎？')) return;
  try {
    await api('/api/managed/snapshots/' + id, { method: 'DELETE' });
    showToast('快照已刪除', 'success');
    closeManagedSnapshotDetail();
    await loadManagedSnapshots(_currentManagedAccountId);
  } catch (err) {
    showToast('刪除失敗: ' + err.message, 'error');
  }
}

function openManagedCashModal(type) {
  if (!_currentManagedAccountId || !_currentManagedSummary) {
    showToast('請先選擇帳戶', 'error');
    return;
  }
  const form = document.getElementById('managed-cash-form');
  form.reset();
  form.type.value = type;
  form.date.value = todayStr();
  form.currency.value = 'TWD';
  const isDeposit = type === 'deposit';
  document.getElementById('managed-cash-modal-title').textContent = isDeposit ? '存入現金' : '提領現金';
  document.getElementById('managed-cash-submit-btn').textContent = isDeposit ? '確認存入' : '確認提領';
  updateCashHint();
  form.currency.onchange = updateCashHint;
  openModal('modal-managed-cash');
}

function updateCashHint() {
  if (!_currentManagedSummary) return;
  const form = document.getElementById('managed-cash-form');
  const cur = form.currency.value;
  const bal = cur === 'TWD' ? _currentManagedSummary.account.cash_twd : _currentManagedSummary.account.cash_usd;
  const symbol = cur === 'TWD' ? 'NT$' : '$';
  document.getElementById('mng-cash-current-hint').textContent = `目前 ${cur} 餘額: ${symbol}${fmt(bal, 2)}`;
}

async function submitManagedCash(e) {
  e.preventDefault();
  if (!_currentManagedAccountId) return;
  const form = e.target;
  const amount = parseFloat(form.amount.value);
  if (!(amount > 0)) {
    showToast('金額必須大於 0', 'error');
    return;
  }
  const payload = {
    type: form.type.value,
    currency: form.currency.value,
    amount: amount,
    date: form.date.value,
    note: form.note.value.trim(),
  };
  try {
    await api('/api/managed/accounts/' + _currentManagedAccountId + '/cash', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    showToast(payload.type === 'deposit' ? '已存入' : '已提領');
    closeModal('modal-managed-cash');
    await loadManagedAccountSummary(_currentManagedAccountId);
  } catch (err) {
    showToast('失敗: ' + err.message, 'error');
  }
}

async function deleteManagedCashMovement(id) {
  if (!confirm('確定刪除這筆現金紀錄? 對應的餘額會自動回沖。')) return;
  try {
    await api('/api/managed/cash/' + id, { method: 'DELETE' });
    showToast('紀錄已刪除');
    await loadManagedAccountSummary(_currentManagedAccountId);
  } catch (err) {
    showToast('刪除失敗: ' + err.message, 'error');
  }
}

function openManagedAccountModal(edit = false) {
  const form = document.getElementById('managed-account-form');
  form.reset();
  const delBtn = document.getElementById('managed-account-delete-btn');
  if (edit && _currentManagedSummary) {
    document.getElementById('managed-account-modal-title').textContent = '編輯代管帳戶';
    form.id.value = _currentManagedSummary.account.id;
    form.name.value = _currentManagedSummary.account.name;
    form.cash_twd.value = _currentManagedSummary.account.cash_twd;
    form.cash_usd.value = _currentManagedSummary.account.cash_usd;
    form.note.value = _currentManagedSummary.account.note || '';
    delBtn.style.display = '';
  } else {
    document.getElementById('managed-account-modal-title').textContent = '新增代管帳戶';
    form.id.value = '';
    delBtn.style.display = 'none';
  }
  openModal('modal-managed-account');
}

async function submitManagedAccount(e) {
  e.preventDefault();
  const form = e.target;
  const payload = {
    name: form.name.value.trim(),
    cash_twd: parseFloat(form.cash_twd.value) || 0,
    cash_usd: parseFloat(form.cash_usd.value) || 0,
    note: form.note.value.trim(),
  };
  if (!payload.name) {
    showToast('請輸入帳戶名稱', 'error');
    return;
  }
  try {
    const id = form.id.value;
    if (id) {
      await api('/api/managed/accounts/' + id, { method: 'PUT', body: JSON.stringify(payload) });
      showToast('帳戶已更新');
    } else {
      const created = await api('/api/managed/accounts', { method: 'POST', body: JSON.stringify(payload) });
      _currentManagedAccountId = created.id;
      showToast('帳戶已新增');
    }
    closeModal('modal-managed-account');
    await loadManagedAccounts();
  } catch (err) {
    showToast('儲存失敗: ' + err.message, 'error');
  }
}

async function deleteManagedAccount() {
  if (!_currentManagedSummary) {
    showToast('請先選擇帳戶', 'error');
    return;
  }
  const id = _currentManagedSummary.account.id;
  const name = _currentManagedSummary.account.name;
  const txCount = (_currentManagedSummary.transactions || []).length;
  const cashCount = (_currentManagedSummary.cash_movements || []).length;
  let msg = `確定刪除帳戶「${name}」?`;
  const warnings = [];
  if (txCount > 0) warnings.push(`${txCount} 筆交易紀錄`);
  if (cashCount > 0) warnings.push(`${cashCount} 筆現金紀錄`);
  if (warnings.length > 0) msg += `\n此帳戶有 ${warnings.join('、')}，會一併刪除（無法復原）。`;
  if (!confirm(msg)) return;
  try {
    const url = '/api/managed/accounts/' + id + (txCount > 0 ? '?force=1' : '');
    await api(url, { method: 'DELETE' });
    showToast('帳戶已刪除');
    closeModal('modal-managed-account');
    _currentManagedAccountId = null;
    _currentManagedSummary = null;
    await loadManagedAccounts();
  } catch (err) {
    showToast('刪除失敗: ' + err.message, 'error');
  }
}

function openManagedTradeModal(action) {
  if (!_currentManagedAccountId) {
    showToast('請先選擇帳戶', 'error');
    return;
  }
  const form = document.getElementById('managed-trade-form');
  form.reset();
  form.action.value = action;
  form.date.value = todayStr();
  document.getElementById('managed-trade-modal-title').textContent = action === 'BUY' ? '買入' : '賣出';
  document.getElementById('managed-trade-submit-btn').textContent = action === 'BUY' ? '確認買入' : '確認賣出';
  onManagedTradeMarketChange(form.market);
  openModal('modal-managed-trade');
}

function onManagedTradeMarketChange(select) {
  const market = select.value;
  document.getElementById('mng-trade-currency-label').textContent = market === 'TW' ? 'TWD' : 'USD';
}

async function submitManagedTrade(e) {
  e.preventDefault();
  if (!_currentManagedAccountId) return;
  const form = e.target;
  const market = form.market.value;
  let symbol = form.symbol.value.trim();
  // For TW market, auto-append .TW if user only entered numeric code
  if (market === 'TW' && /^\d+$/.test(symbol) && !symbol.endsWith('.TW')) {
    symbol = symbol + '.TW';
  }
  const payload = {
    symbol: symbol,
    market: market,
    action: form.action.value,
    shares: parseFloat(form.shares.value),
    price: parseFloat(form.price.value),
    fee: parseFloat(form.fee.value) || 0,
    currency: market === 'TW' ? 'TWD' : 'USD',
    date: form.date.value,
    note: form.note.value.trim(),
  };
  try {
    await api('/api/managed/accounts/' + _currentManagedAccountId + '/transactions', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    showToast(payload.action === 'BUY' ? '買入已記錄' : '賣出已記錄');
    closeModal('modal-managed-trade');
    await loadManagedAccountSummary(_currentManagedAccountId);
  } catch (err) {
    showToast('交易失敗: ' + err.message, 'error');
  }
}

async function deleteManagedTransaction(id) {
  if (!confirm('確定刪除這筆交易? 對應的現金變動會自動回沖。')) return;
  try {
    await api('/api/managed/transactions/' + id, { method: 'DELETE' });
    showToast('交易已刪除');
    await loadManagedAccountSummary(_currentManagedAccountId);
  } catch (err) {
    showToast('刪除失敗: ' + err.message, 'error');
  }
}
