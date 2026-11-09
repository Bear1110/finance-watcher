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
  const f = 10 ** decimals;
  const v = Math.round(Number(n) * f) / f || 0; // −0.4 → 0, not "-0"
  return v.toLocaleString('en-US', {
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
  const v = Math.round(n * 100) / 100 || 0; // −0.001 → +0.00%, not "-0.00%"
  return (v >= 0 ? '+' : '') + v.toFixed(2) + '%';
}

/** Get CSS class for positive/negative */
function plClass(n) {
  if (n == null || isNaN(n) || n === 0) return '';
  return n > 0 ? 'positive' : 'negative';
}

/** Value wrapped in a span coloured green/red by its sign. */
const plSpan = (v, f = fmtTWD) => `<span class="${plClass(v)}">${f(v)}</span>`;

/** Stat card: big value plus the optional `${id}-sub` line under it. */
function setStat(id, html, sub = '') {
  document.getElementById(id).innerHTML = html;
  const subEl = document.getElementById(id + '-sub');
  if (subEl) subEl.innerHTML = sub;
}

/** 12.5 萬 style amount for short summaries. */
function fmtWan(n) {
  if (n == null || isNaN(n)) return '--';
  if (privacyMode) return MASK;
  return n >= 10000 ? `${+(n / 10000).toFixed(n >= 1e6 ? 0 : 1)} 萬` : fmtNum(n);
}

/** +12.5 萬 / −3,000: a change in 萬. */
const signedWan = (v) => (v < 0 ? '−' : '+') + fmtWan(Math.abs(v));

/** A large expense ahead (關於你): 2029 買房 300 萬. */
const bigExpenseLabel = (e) => `${e.year} ${escapeHtml(e.what || '支出')} ${fmtWan(e.amount)}`;

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
/** YYYY-MM-DD → YYYY/MM/DD */
const fullDate = (d) => (d || '').replace(/-/g, '/');
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

/** Today's local date YYYY-MM-DD (not UTC: in Taiwan that is still yesterday until 08:00), like db.today() */
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
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
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
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
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
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
// SECTION: Segmented selects — a short <select data-segmented> shown as a row of buttons
// ============================================================

const SELECT_VALUE = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');

/**
 * Shows a select with a few short options as buttons: everything is visible and one tap picks it.
 * The select stays (hidden) as the source of truth, so forms, `onchange`, edit forms setting
 * `.value` and form.reset() all keep working. Call again after replacing the options.
 * Button text: the option's data-short, else its text (the full text becomes the tooltip).
 * A list that grows (years): `data-segmented="6"` shows the first 6 options as buttons and folds
 * the rest into a 「更多 ▾」 dropdown (label from data-more), which shows a picked value on itself.
 */
/**
 * Year buttons for a list: 全部 (allLabel; null = none, the newest year by default) + every year in
 * `dates`, newest first; keeps the chosen year if it's still there.
 */
function fillYearFilter(sel, dates, allLabel = '全部') {
  const prev = sel.value;
  const years = [...new Set(dates.map(d => (d || '').slice(0, 4)).filter(Boolean))].sort().reverse();
  sel.innerHTML = (allLabel == null ? '' : `<option value="">${allLabel}</option>`) + years.map(y => `<option value="${y}">${y}</option>`).join('');
  segmentSelect(sel);
  sel.value = years.includes(prev) ? prev : allLabel == null ? years[0] || '' : '';
}

// ---- Stock names next to symbols ("2330 台積電"; js/server/names.js looks them up and caches them) ----
let _stockNames = {}; // symbol -> name
const _namesAsked = new Set(); // shown symbols that had no name (looked up once per visit)

/** Yahoo's .TW / .TWO suffixes mean 台股. */
const isTW = (s) => /\.TWO?$/.test(s);

/** 台股 code without the .TW / .TWO suffix (2330.TW → 2330); other symbols unchanged. */
const symCode = (s) => String(s || '').replace(/\.TWO?\b/g, '');

/**
 * Startup: the cached names before the first tab draws, then the user's own symbols that are
 * missing or old are looked up in the background (the tab redraws if any name changed).
 */
async function loadStockNames() {
  try {
    _stockNames = await api('/api/stocks/names');
  } catch (e) { return; }
  api('/api/stocks/names?refresh=1').then(setStockNames, () => {});
}

/** New names from the server; redraws the current tab when one of them changes what is shown. */
function setStockNames(names, symbols = Object.keys(names)) {
  const changed = symbols.some(s => (names[s] || '') !== (_stockNames[s] || ''));
  _stockNames = names;
  if (changed) onTabActivated(document.body.dataset.tab || 'dashboard');
}

/**
 * The name of a symbol ('' until known); an unknown one is looked up (in one batch with others).
 * `fallback`: a name already at hand (Yahoo's, for ETF holdings) — 台股 still get the Chinese one.
 */
function stockName(sym, fallback = '') {
  if (_stockNames[sym]) return _stockNames[sym];
  if (sym && !_namesAsked.has(sym) && (!fallback || isTW(sym))) {
    _namesAsked.add(sym);
    requestStockNames();
  }
  return fallback;
}

const requestStockNames = debounce(() => {
  const syms = [..._namesAsked].filter(s => !_stockNames[s]);
  api(`/api/stocks/names?symbols=${encodeURIComponent(syms.join(','))}`)
    .then(names => setStockNames(names, syms), () => {}); // names are extra: the code alone still works
}, 50);

/** "2330 台積電" as plain text (toasts, titles, summaries); escape it where it goes into HTML. */
const stockText = (sym) => [symCode(sym), stockName(sym)].filter(Boolean).join(' ');

/** The code, then the name small and gray (tables and lists). */
function stockHTML(sym) {
  const n = stockName(sym);
  return `${escapeHtml(symCode(sym) || '--')}${n ? ` <span class="sym-name" title="${escapeAttr(n)}">${escapeHtml(n)}</span>` : ''}`;
}

/** A search box's words, lowercased (every one must match). */
const searchWords = (inputId) => document.getElementById(inputId).value.trim().toLowerCase().split(/\s+/).filter(Boolean);

/** Call fn once calls stop for `ms` (search boxes re-render when typing pauses). */
function debounce(fn, ms = 150) {
  let timer = null;
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
}

function segmentSelect(sel) {
  let box = sel._seg;
  if (!box) {
    box = sel._seg = document.createElement('div');
    box.className = 'chart-type-toggle seg-select';
    box.setAttribute('role', 'radiogroup'); // one choice among several
    if (sel.getAttribute('aria-label')) box.setAttribute('aria-label', sel.getAttribute('aria-label'));
    sel.after(box);
    sel.style.display = 'none';
    const pick = (v) => {
      if (v === sel.value) return; // like a select: no change event when nothing changed
      sel.value = v;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    };
    box.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) pick(b.dataset.v); });
    box.addEventListener('change', (e) => { e.stopPropagation(); pick(e.target.value); }); // the 更多 list
    // Code that sets .value directly (edit forms) moves the highlight too
    Object.defineProperty(sel, 'value', {
      configurable: true,
      get() { return SELECT_VALUE.get.call(this); },
      set(v) { SELECT_VALUE.set.call(this, v); syncSegments(this); },
    });
  }
  const options = [...sel.options];
  const limit = Number(sel.dataset.segmented) || options.length;
  const folded = options.length > limit + 1 ? options.slice(limit) : []; // one extra isn't worth a list
  box.innerHTML = options.slice(0, options.length - folded.length).map(o => {
    const short = o.dataset.short;
    return `<button type="button" role="radio" class="chart-type-btn" data-v="${escapeAttr(o.value)}"${short ? ` title="${escapeAttr(o.textContent)}"` : ''}>${escapeHtml(short || o.textContent)}</button>`;
  }).join('') + (folded.length ? `<label class="chart-type-btn seg-more"><span></span>
    <select aria-label="${escapeAttr(sel.dataset.more || '更多')}"><option value="" disabled>${escapeHtml(sel.dataset.more || '更多')}</option>${
      folded.map(o => `<option value="${escapeAttr(o.value)}">${escapeHtml(o.textContent)}</option>`).join('')}</select></label>` : '');
  box.hidden = options.length < 2; // one option is no choice
  syncSegments(sel);
}

function syncSegments(sel) {
  const box = sel._seg;
  if (!box) return;
  box.querySelectorAll('button').forEach(b => {
    const on = b.dataset.v === sel.value;
    b.classList.toggle('active', on);
    b.setAttribute('aria-checked', String(on));
  });
  const more = box.querySelector('.seg-more');
  if (!more) return;
  const list = more.querySelector('select');
  const picked = [...list.options].some(o => o.value && o.value === sel.value);
  more.classList.toggle('active', picked);
  more.firstElementChild.textContent = `${picked ? sel.selectedOptions[0].textContent : sel.dataset.more || '更多'} ▾`;
  list.value = picked ? sel.value : '';
}

/** Every `select[data-segmented]` under root (like applyIcons). */
function initSegmented(root = document) {
  root.querySelectorAll('select[data-segmented]').forEach(segmentSelect);
}

// form.reset() sets the selects without a value assignment: resync once it has run
document.addEventListener('reset', (e) => setTimeout(() => e.target.querySelectorAll('select[data-segmented]').forEach(syncSegments)));

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
  bubble.setAttribute('popover', 'manual');
  bubble.hidden = true;
  document.body.appendChild(bubble);
  let anchor = null;
  const hide = () => {
    if (bubble.hidden) return;
    bubble.hidden = true;
    if (bubble.matches?.(':popover-open')) bubble.hidePopover();
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
    raise(bubble); // above an open dialog when the tip is inside one
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
  holdings: [loadHoldings],
  // loadPerformance first: it refreshes the shared performance data that loadHoldingsTrend reuses
  performance: [loadXirr, loadPerformance, loadDataCheckBadge, loadHoldingsTrend],
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
    case 'llm': loadProfile(); initAIImport(); break;
    case 'settings': loadSettings(); loadDataCheck(); break;
  }
}

// ============================================================
// SECTION: Modal Helpers
// ============================================================

// Modals are native <dialog>s opened with showModal() (Esc, focus kept inside, page behind inert).
// They sit in the browser's top layer, above any z-index: whatever must float over them (toasts,
// the tap-tip bubble) is a popover that raise() puts back on top.

/** Puts a popover element at the front of the top layer; a no-op where popovers aren't supported. */
function raise(el) {
  if (!el.showPopover) return;
  if (el.matches(':popover-open')) el.hidePopover();
  el.showPopover();
}

function openModal(id) {
  const d = document.getElementById(id);
  if (!d.open) d.showModal();
  raise(document.getElementById('toast-container')); // messages from the form show above it
}

function closeModal(id) {
  document.getElementById(id).close();
}

// A click on the dimmed area (the dialog itself, outside its .modal box) closes it
document.addEventListener('click', (e) => {
  if (e.target.matches('dialog.modal-overlay[open]')) e.target.close();
});

// ============================================================
// SECTION: Dashboard
// ============================================================

let _cachedAssets = [];
let _overview = null; // /api/overview; its carried-forward cash also prefills a new snapshot
let _netWorthChart = null;
let _nwYears = 3; // net worth chart window, 0 = all

/** Net worth parts in the hero's bar */
const COMP_PARTS = [
  { key: 'cash_twd', label: '台幣現金', color: '#4e8cff' },
  { key: 'cash_usd', label: '美金現金', color: '#a78bfa' },
  { key: 'tw', label: '台股', color: '#34d399' },
  { key: 'us', label: '美股', color: '#fbbf24' },
  { key: 'other', label: '其他資產', color: '#94a3b8' },
];

/** 總覽: the numbers come from /api/overview (js/server/overview.js); this renders them. */
async function loadDashboard() {
  try {
    const [ov, assets, transactions] = await Promise.all([
      api('/api/overview'),
      api('/api/assets').catch(() => []),
      api('/api/transactions?limit=5').catch(() => []),
    ]);
    _overview = ov;
    _cachedAssets = assets;
    renderHero(ov);
    renderMonth(ov.month, ov.spending);
    renderGrowthYears(ov.years);
    renderSnapshots(assets);
    renderSnapshotStrip(ov.snapshot_months, ov.snapshot_streak);
    renderRecentTx(transactions);
    // The data check is slower (price history): its warnings join once it is done
    renderAlerts(ov.alerts);
    // (a stale snapshot shows on the 資產快照 strip instead)
    getDataCheck().then(d => renderAlerts([...ov.alerts, ...dataCheckWarnings(d).filter(c => c.action !== 'assets').map(c => ({ ...c, text: c.title }))])).catch(() => {});
    renderNetWorthChart(); // snapshots now; daily once the performance series arrives
    loadPerformance('dash');
    getPerf().then(renderNetWorthChart).catch(() => {});
  } catch (err) {
    showToast('載入總覽資料失敗: ' + err.message, 'error');
  }
}

/** The most important alert shows; the others fold under「還有 N 項提醒」so 淨資產 stays near the top. */
function renderAlerts(alerts) {
  const el = document.getElementById('dash-alerts');
  el.hidden = !alerts.length;
  const one = a => {
    const action = CHECK_ACTIONS[a.action];
    return `<div class="dash-alert dash-alert-${a.level}">
      <span class="dash-alert-icon" aria-hidden="true">${CHECK_ICONS[a.level]}</span>
      <span class="dash-alert-text">${escapeHtml(a.text)}</span>
      ${action ? `<button type="button" class="btn btn-outline btn-sm" onclick="CHECK_ACTIONS['${a.action}'][1]()">${action[0]}</button>` : ''}
      ${checkItemsHtml(a, true)}
    </div>`;
  };
  const [first, ...rest] = alerts;
  el.innerHTML = !first ? '' : one(first) + (rest.length
    ? `<details class="dash-alerts-more"><summary>還有 ${rest.length} 項提醒</summary>${rest.map(one).join('')}</details>` : '');
}

/** Net worth, this year's change by source, what it is made of, today's move. */
function renderHero(ov) {
  const $ = id => document.getElementById(id);
  const year = ov.years.find(y => y.current);
  if (ov.net_worth == null) {
    $('dash-net-worth').textContent = '--';
    ['dash-year', 'dash-year-parts', 'dash-comp-bar', 'dash-comp-legend'].forEach(id => { $(id).innerHTML = ''; });
    $('dash-net-date').textContent = '尚無快照，請新增';
    return;
  }
  $('dash-net-worth').textContent = fmtTWD(ov.net_worth);
  $('dash-year').innerHTML = year && year.start > 0 ? `今年 ${changeHtml(year.start + year.change, year.start)}` : '';
  $('dash-year').title = `今年 1/1（或之前最後一筆快照）到現在，淨資產多了多少：\n${growthLegend()}`;
  $('dash-year-parts').innerHTML = year ? growthPartsText(year) : '';

  const parts = COMP_PARTS.map(p => ({ ...p, v: Math.max(0, ov.parts[p.key]) })).filter(p => p.v > 0);
  const total = parts.reduce((sum, p) => sum + p.v, 0);
  $('dash-comp-bar').innerHTML = segmentsHtml(parts);
  $('dash-comp-legend').innerHTML = parts.map(p =>
    `<span class="legend-item"><span class="legend-dot" style="background:${p.color}"></span>${p.label} ${(p.v / total * 100).toFixed(0)}%</span>`).join('') +
    '';

  const c = ov.cash;
  const counted = [c.trades && `${c.trades} 筆交易`, c.dividends && `${c.dividends} 筆股利`].filter(Boolean);
  const d = ov.day;
  const sub = $('dash-net-date');
  sub.innerHTML = [
    d ? `今日 <span class="${plClass(d.pl)}">${fmtPL(d.pl)}${d.prev_value > 0 ? ` (${fmtPct(d.pl / d.prev_value * 100)})` : ''}</span>` : '',
    `現金：${c.date} 快照${counted.length ? `＋之後 ${counted.join('、')}` : ''}`,
  ].filter(Boolean).join(' · ');
  const dayParts = [ov.parts.tw > 0 && `台股 ${fmtPL(d && d.tw)}`, ov.parts.us > 0 && `美股 ${fmtPL(d && d.us)}`].filter(Boolean);
  sub.title = (d && dayParts.length > 1 ? `今日：${dayParts.join('、')}（最近一個交易日，不含匯率）\n` : '') +
    (counted.length ? `現金調整：台幣 ${fmtPL(c.moved_twd)}、美金 ${fmtPLCur(c.moved_usd, 'USD')}` : '');
}

/** "每月 NT$ 44,333，依收支估算" — where the monthly spending figure came from. */
const monthlyExpenseNote = (f) => `每月 ${fmtTWD(f.monthly_expense)}${f.source === 'records' ? '，依收支紀錄估算' : ''}`;

/** This month (whole month, planned entries included): spending, income, top categories, cash runway. Hidden when 收支 isn't in use. */
function renderMonth(m, f) {
  // Not using 收支 (nothing this month or last): the card would only say "no records"
  document.getElementById('dash-month').hidden = !m.in_use;
  if (!m.in_use) return;
  document.getElementById('dash-month-range').textContent = `${shortDate(m.from)}–${shortDate(m.to)}`;
  const cashLine = f.cash_months != null
    ? `<p class="month-foot">現金可撐 <strong>${Math.max(0, f.cash_months).toFixed(1)}</strong> 個月生活費（${monthlyExpenseNote(f)}）</p>`
    : '';
  const body = document.getElementById('dash-month-body');
  if (!m.count) {
    body.innerHTML = '<p class="form-hint">這個月還沒有收支紀錄。</p>' + cashLine;
    return;
  }
  // Pace: spending so far against the same days of last month
  const vs = m.prev_expense > 0 ? (m.expense_to_date - m.prev_expense) / m.prev_expense * 100 : null;
  const planned = m.expense - m.expense_to_date;
  const pace = vs == null ? '上月同期沒有紀錄' : `到今天比上月同期 <span class="${plClass(-vs)}">${fmtPct(vs)}</span>`;
  const plannedLine = planned > 0 ? `<br>含 ${shortDate(m.today)} 之後預計 ${fmtTWD(planned)}` : '';
  const net = m.income - m.expense;
  const max = m.top.length ? m.top[0].amount : 0;
  body.innerHTML = `
    <div class="month-grid">
      <div><span>支出</span><strong>${fmtTWD(m.expense)}</strong>
        <small title="到今天為止 ${fmtTWD(m.expense_to_date)}，對比上月同期 ${m.prev_from}～${m.prev_to}">${pace}${plannedLine}</small></div>
      <div><span>收入</span><strong>${fmtTWD(m.income)}</strong>
        <small>結餘 <span class="${plClass(net)}">${fmtPL(net)}</span>${m.income > 0 ? ` · 儲蓄率 ${(net / m.income * 100).toFixed(0)}%` : ''}</small></div>
    </div>
    ${m.top.length ? `<div class="month-top">${m.top.map(t => `<div class="month-cat">
      <span class="cat-name">${escapeHtml(t.category)}</span>
      <span class="source-bar cat-track"><span style="width:${t.amount / max * 100}%"></span></span>
      <span class="cat-amt">${fmtTWD(t.amount)}</span></div>`).join('')}</div>` : ''}
    ${cashLine}`;
}

function renderGrowthYears(years) {
  // the colors, each explained on hover / tap
  document.getElementById('nw-legend').innerHTML = growthPartList().map(p =>
    `<span class="legend-item" title="${escapeAttr(p.desc)}"><span class="legend-dot" style="background:${p.color || 'var(--up)'}"></span>${p.label} ⓘ</span>`).join('');
  document.getElementById('nw-years').innerHTML = years.length ? years.map(y => `<div class="nw-year">
      <div class="nw-year-head">
        <strong${y.partial ? ` title="從 ${y.from} 第一筆快照開始算"` : ''}>${y.year}${y.current ? '（至今）' : ''}${y.partial ? '*' : ''}</strong>
        <span>${y.start > 0 ? changeHtml(y.start + y.change, y.start) : fmtPL(y.change)}</span>
      </div>
      ${growthBarHtml(y)}
      <div class="nw-year-parts">${growthPartsText(y)}</div>
    </div>`).join('')
    : '<p class="form-hint">要有兩個時間點的快照（或一筆快照加上今天）才算得出成長。</p>';
}

function renderRecentTx(txList) {
  const body = document.getElementById('dash-tx-body');
  body.innerHTML = txList.length ? txList.slice(0, 5).map(t => `
    <tr>
      <td>${t.date || '--'}</td>
      <td>${stockHTML(t.symbol)}</td>
      <td><span class="${t.action === 'BUY' ? 'tag-buy' : 'tag-sell'}">${t.action === 'BUY' ? '買' : '賣'}</span></td>
      <td>${fmt(t.shares)}</td>
      <td>${fmtNum(t.price, 2)}</td>
    </tr>`).join('') : '<tr><td colspan="5" class="empty-state">尚無交易紀錄</td></tr>';
}

/** 淨資產走勢 card: show one view ('trend' | 'years' | 'history'), with the controls tagged for it. */
function setNetWorthView(view) {
  document.querySelectorAll('#nw-views .chart-type-btn').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  document.querySelectorAll('[data-nw-view]').forEach(el => { el.hidden = el.dataset.nwView !== view; });
}

function setNetWorthPeriod(years) {
  _nwYears = years;
  document.querySelectorAll('#nw-periods .chart-type-btn').forEach(b => b.classList.toggle('active', Number(b.dataset.years) === years));
  renderNetWorthChart();
}

/**
 * Net worth line: per weekday from the performance series (assets.js netWorthSeries), else per
 * snapshot. The last point is today's net worth from the hero.
 */
function renderNetWorthChart() {
  const s = _perfData && _perfData.series;
  let points = s && s.net_worth
    ? weekdayIndexes(s.dates, 0).filter(i => s.net_worth[i] != null).map(i => [s.dates[i], s.net_worth[i]])
    : [..._cachedAssets].reverse().map(a => [a.date, a.net_worth]);
  const today = _overview && _overview.today;
  if (today && _overview.net_worth != null) {
    if (points.length && points[points.length - 1][0] === today) points.pop();
    points.push([today, _overview.net_worth]);
  }
  if (_nwYears && today) {
    const from = `${Number(today.slice(0, 4)) - _nwYears}${today.slice(4)}`;
    points = points.filter(p => p[0] >= from);
  }

  if (_netWorthChart) _netWorthChart.destroy();
  _netWorthChart = null;
  if (points.length < 2) return;
  _netWorthChart = new Chart(document.getElementById('chart-asset-trend'), {
    type: 'line',
    data: {
      labels: points.map(p => p[0]),
      datasets: [{
        label: '淨資產', data: points.map(p => p[1]), borderColor: '#4e8cff', backgroundColor: 'rgba(78, 140, 255, 0.08)',
        fill: true, borderWidth: 2, pointRadius: s ? 0 : 3, pointHitRadius: 8, tension: 0,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => `淨資產: ${fmtTWD(c.parsed.y)}` } } },
      scales: {
        x: { ticks: { ...CHART_AXIS.ticks, maxTicksLimit: 6, maxRotation: 0, callback(v) { return this.getLabelForValue(v).slice(0, 7); } }, grid: { display: false } },
        y: { ticks: { ...CHART_AXIS.ticks, callback: v => fmt(v) }, grid: CHART_AXIS.grid },
      },
    },
  });
}

/** A growthBetween result (js/server/overview.js) as colored parts: 股價 / 股利 / (其他資產) / 存入與其他. */
const GROWTH_PARTS = [
  { key: 'price', label: '股價漲跌', desc: '手上股票漲跌賺賠的錢（拿現金買股票不算賺）' },
  { key: 'dividends', label: '股利', desc: '領到的現金股利', color: 'var(--yellow)' },
  { key: 'other', label: '其他資產', desc: '你在設定填的房子、車子等的價值變化', color: '#94a3b8' },
  { key: 'savings', label: '存入與其他', desc: '不是投資賺來的增加：存下的薪水、別人給的錢、美金現金的匯差等（替別人付出去的錢會讓它變少）', color: 'var(--accent)' },
];
/** 其他資產 only shows when counted and present */
const showOther = () => !!(_overview && _overview.parts.other > 0) || (_overview?.years || []).some(y => y.other);
const growthPartList = () => GROWTH_PARTS.filter(p => p.key !== 'other' || showOther());
function growthParts(g) {
  return growthPartList().map(p => ({ ...p, v: g[p.key] || 0, color: p.color || (g.price < 0 ? 'var(--down)' : 'var(--up)') }));
}
/** The parts explained, as a plain-text tooltip. */
const growthLegend = () => growthPartList().map(p => `${p.label}：${p.desc}`).join('\n');

const growthPartsText = (g) => growthParts(g).map(p => `${p.label} <span class="${plClass(p.v)}">${fmtPL(p.v)}</span>`).join(' · ');

/** Proportional colored segments for a .source-bar, by |v| (so a loss still shows). */
function segmentsHtml(parts) {
  const total = parts.reduce((sum, p) => sum + Math.abs(p.v), 0);
  return total > 0
    ? parts.map(p => `<span style="width:${Math.abs(p.v) / total * 100}%;background:${p.color}" title="${p.label} ${fmtPL(p.v)}"></span>`).join('')
    : '';
}

/** Each part's share of the year's movement. */
const growthBarHtml = (g) => `<div class="source-bar" aria-hidden="true">${segmentsHtml(growthParts(g))}</div>`;

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

/**
 * 每月快照 on the 淨資產走勢 card (overview.js snapshotMonths / snapshotStreak): a stamp card, one stamp
 * a month. A stamped month opens that snapshot; an empty one records that month (dated its last day).
 */
function renderSnapshotStrip(months, streak) {
  const cur = months.at(-1); // this month
  const done = cur?.snapshot;
  const month = cur && Number(cur.ym.slice(5));
  const meta = !cur ? '' : done ? `✓ 本月 ${shortDate(done.date)} 已記` : `${month} 月還沒記`;
  document.getElementById('snap-strip-meta').textContent = meta;
  const badge = document.getElementById('snap-streak');
  badge.hidden = !(streak >= 2);
  badge.textContent = `🔥 連續 ${streak} 個月`;
  const hint = document.getElementById('snap-strip-hint');
  hint.hidden = !!done; // done this month: just the stamps
  hint.textContent = cur
    ? '看一下銀行和券商的現金餘額填進來就好，股票市值 App 會自己算。'
    : '填一次銀行和券商裡的現金餘額，就算得出你的淨資產；之後每個月記一次，這裡會集滿一排章。';
  document.getElementById('snap-strip-btn').textContent = !cur ? '記第一筆快照' : done ? '+ 新增快照' : `記 ${month} 月快照`;
  document.getElementById('snap-months').innerHTML = months.map(({ ym, date, snapshot: s }, i) => {
    const m = Number(ym.slice(5));
    const label = m === 1 || i === 0 ? `${ym.slice(2, 4)}/${m}` : `${m}月`; // the year where it changes
    const [cls, onclick, title, glyph] = s
      ? ['done', `editSnapshot(${s.id})`, `${s.date} 的快照，點一下查看或修改`, '✓']
      : [i === months.length - 1 ? 'now' : '', `openSnapshotModal('${date}')`, `${m} 月沒有快照，點一下補記`, '+'];
    return `<button type="button" class="snap-month ${cls}" onclick="${onclick}" title="${title}"><span class="snap-dot">${glyph}</span>${label}</button>`;
  }).join('');
}

/** 快照紀錄 view: one year at a time (year buttons), newest first; rows expand. */
function renderSnapshots(assets) {
  fillYearFilter(document.getElementById('snap-year'), assets.map(a => a.date), null);
  renderSnapshotYear();
}

function renderSnapshotYear() {
  const assets = _cachedAssets;
  const list = document.getElementById('snapshot-history');
  const meta = document.getElementById('snap-year-meta');
  if (!assets.length) {
    list.innerHTML = '<div class="empty-state">還沒有快照，按右上角記第一筆</div>';
    meta.textContent = '';
    return;
  }
  const y = document.getElementById('snap-year').value;
  // assets are newest first: the previous snapshot of assets[i] is assets[i + 1]
  const rows = assets.map((a, i) => [a, assets[i + 1]]).filter(([a]) => a.date.startsWith(y));
  // the year's change lives on the 年度成長 tab (overview.js yearlyGrowth), not recomputed here
  meta.innerHTML = `${y} 年 ${rows.length} 筆 · ${y === todayStr().slice(0, 4) ? '最新' : '年末'} ${fmtTWD(rows[0][0].net_worth)}`;
  list.innerHTML = rows.map(([a, prev]) => snapshotRowHtml(a, prev)).join('');
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
    autoInfo.textContent = '系統將自動擷取：那一天的股票市值、USD/TWD 匯率';
  }
}

/** New snapshot, dated today unless backfilling a month (date). */
function openSnapshotModal(date = todayStr()) {
  const form = document.getElementById('snapshot-form');
  form.reset();
  form.querySelector('[name="id"]').value = '';
  form.querySelector('[name="date"]').value = date;
  const carried = date === todayStr() && _overview?.cash; // today's cash estimate; a past month starts empty
  if (carried) { // the user corrects it to the real balance
    form.querySelector('[name="cash_twd"]').value = Math.max(0, Math.round(carried.twd));
    form.querySelector('[name="cash_usd"]').value = Math.max(0, Math.round(carried.usd * 100) / 100);
  }
  document.getElementById('snapshot-modal-title').textContent = '新增資產快照';
  setSnapshotMode('auto');
  document.getElementById('snapshot-cash-hint').hidden = !carried;
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

/**
 * The stock's page on Google Finance. Listed Taiwan stocks are CODE:TPE; Google has no
 * 上櫃 (.TWO) quotes, and a US quote needs the exchange (from the Yahoo quote), so those
 * fall back to a Google search, which shows the price card.
 */
function quoteURL(s) {
  const code = symCode(s.symbol);
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
      <td class="c-sym"><a class="sym-link" href="${quoteURL(s)}" target="_blank" rel="noopener" title="在 Google 財經查看"><strong>${stockHTML(s.symbol)}</strong></a></td>
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

let _holdings = []; // last /api/stocks holdings, for the search box

async function loadHoldings() {
  try {
    const [stockData, divData] = await Promise.all([
      api('/api/stocks'),
      api('/api/dividends/by-symbol').catch(() => ({ items: [], usd_twd_rate: 32 })),
    ]);
    _divBySymbol = {};
    (divData.items || []).forEach(d => { _divBySymbol[d.symbol] = d; });
    _holdings = (stockData && stockData.holdings) || [];
    renderHoldingsSummary(stockData);
    renderHoldingsTable();
    const fetchedEl = document.getElementById('quote-fetched-at');
    if (fetchedEl && stockData.quote_fetched_at) fetchedEl.textContent = `報價 ${stockData.quote_fetched_at}`;
  } catch (err) {
    showToast('載入持倉失敗: ' + err.message, 'error');
  }
}

const MARKET_LABEL = { TW: '台股', US: '美股' };
const MARKET_FLAG = { TW: '\u{1F1F9}\u{1F1FC}', US: '\u{1F1FA}\u{1F1F8}' };
const UNREALIZED_TIP = '台股已扣掉現在賣出要付的手續費（依設定的折扣）和證交稅（股票 0.3%、ETF 0.1%），和券商 App 的預估損益算法一樣';

/** Totals above the table (js/server/stocks.js `markets`): a card per market held in its own currency, plus 合計 in NT$ when both. */
function renderHoldingsSummary(data) {
  const box = document.getElementById('holdings-summary');
  const markets = data.markets || [];
  box.hidden = !markets.length;
  const card = ({ label, count, cur, value, cost, pl, plPct, day, dayPct, ret }) => `<div class="stat-card">
      <div class="stat-label">${label} · ${count} 檔</div>
      <div class="stat-value">${fmtCur(value, cur)}</div>
      <div class="holdings-summary-parts">
        <div><span title="${UNREALIZED_TIP}">未實現損益</span><strong class="${plClass(pl)}">${fmtPLCur(pl, cur)}</strong><small class="${plClass(plPct)}">${fmtPct(plPct)}</small></div>
        <div><span title="較前一交易日收盤">今日</span><strong class="${plClass(day)}">${fmtPLCur(day, cur)}</strong><small class="${plClass(dayPct)}">${fmtPct(dayPct)}</small></div>
        <div><span title="(未實現損益 + 這些持股累計已領股利) ÷ 投入金額">含股利報酬</span><strong class="${plClass(ret)}">${fmtPct(ret)}</strong><small>投入 ${fmtCur(cost, cur)}</small></div>
      </div>
    </div>`;
  const cards = markets.map(m => card({
    label: MARKET_LABEL[m.market], count: m.count, cur: m.currency, value: m.value, cost: m.cost,
    pl: m.pl, plPct: m.pl_percent, day: m.day, dayPct: m.day_percent, ret: m.div_return_percent,
  }));
  if (markets.length > 1) {
    cards.unshift(card({
      label: '合計（台幣）', count: data.holdings.length, cur: 'TWD', value: data.total_value_twd, cost: data.total_cost_twd,
      pl: data.total_pl_twd, plPct: data.total_pl_percent, day: data.total_day_twd, dayPct: data.total_day_percent,
      ret: data.total_div_return_percent,
    }));
  }
  box.classList.toggle('holdings-summary-1', cards.length === 1);
  box.innerHTML = cards.join('');
}

const onHoldingsSearch = debounce(() => renderHoldingsTable());

/** The holdings table (or cards), grouped by market when both, narrowed by the search box. */
function renderHoldingsTable() {
  const tbody = document.getElementById('holdings-body');
  // The search box only shows once the list is long enough to need it
  const searchable = _holdings.length >= 6;
  document.getElementById('holdings-search-wrap').hidden = !searchable;
  const words = searchable ? searchWords('holdings-search') : [];
  const list = words.length
    ? _holdings.filter(s => words.every(w => [s.symbol, stockName(s.symbol), MARKET_LABEL[s.market]].join(' ').toLowerCase().includes(w)))
    : _holdings;
  const summary = document.getElementById('holdings-search-summary');
  summary.hidden = !words.length;
  summary.textContent = `找到 ${list.length} 檔`;

  if (!list.length) {
    tbody.innerHTML = `<tr><td colspan="10" class="empty-state">${_holdings.length ? '找不到符合的股票' : '尚無持倉資料'}</td></tr>`;
    return;
  }
  const both = new Set(_holdings.map(s => s.market)).size > 1;
  tbody.innerHTML = ['US', 'TW'].map(market => {
    const rows = list.filter(s => s.market === market);
    if (!rows.length) return '';
    return (both ? `<tr class="market-group-header"><td colspan="10">${MARKET_FLAG[market]} ${MARKET_LABEL[market]}</td></tr>` : '') +
      rows.map(renderHoldingRow).join('');
  }).join('');
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
    note: form.querySelector('[name="note"]').value.trim(),
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
    renderRplMarketButtons();
    renderRealizedSummary();
  } catch (err) {
    showToast('載入已實現損益失敗: ' + err.message, 'error');
  }
}

function renderRplYearButtons() {
  const sel = document.getElementById('rpl-year-filter');
  sel.innerHTML = ['ALL', ..._rplYears].map(y => `<option value="${y}">${y === 'ALL' ? '全部年度' : y}</option>`).join('');
  segmentSelect(sel);
  sel.value = _rplYear;
}

/** 全部／台股／美股 only when both markets have sales or dividends: with one market 全部 is the same thing */
function renderRplMarketButtons() {
  const markets = new Set([...(_rplData.by_stock || []), ...(_rplData.dividends || [])].map(r => r.market));
  const sel = document.getElementById('rpl-market');
  const single = markets.size < 2;
  sel._seg.hidden = single; // the button row segmentSelect built at startup
  if (single) sel.value = _rplFilter = 'ALL';
}

function filterRealizedYear(year) {
  _rplYear = year;
  loadRealizedSummary();
}

function filterRealizedPL(market) {
  _rplFilter = market;
  renderRealizedSummary();
}

/** 勝率、獲利因子、平均賺／平均賠、每筆期望值: how big the wins are next to the losses, not just how many. */
function renderTradeQuality(ts) {
  setStat('rpl-winrate',
    ts.trades ? `${ts.win_rate.toFixed(1)}%` : '--',
    `${ts.trades} 筆：勝 ${ts.wins} / 負 ${ts.losses}${ts.flat ? ' / 平 ' + ts.flat : ''}`);
  const any = ts.wins || ts.losses; // only flat trades (or none): nothing to compare
  // Profit factor: < 1 loses money overall, 1–1.5 thin, ≥ 2 strong
  const pf = ts.profit_factor;
  const pfCls = pf < 1 ? 'negative' : pf >= 2 ? 'positive' : '';
  setStat('rpl-pf',
    !any ? '--' : pf == null ? '<span class="positive">無虧損</span>' : `<span class="${pfCls}">${pf.toFixed(2)}</span>`,
    !any ? '' : ts.losses ? `總賺 ${fmt(ts.gross_profit)} ÷ 總賠 ${fmt(ts.gross_loss)}` : '還沒有賠錢的交易');
  const win = ts.wins ? `<span class="positive">+${fmt(ts.avg_win)}</span>` : '--';
  const loss = ts.losses ? `<span class="negative">−${fmt(ts.avg_loss)}</span>` : '--';
  setStat('rpl-payoff',
    any ? `${win} <span class="text-muted">/</span> ${loss}` : '--',
    ts.payoff != null ? `賺賠比 ${ts.payoff.toFixed(2)}${ts.payoff < 1 ? '：平均賺的比賠的少' : ''}` : '');
  setStat('rpl-exp',
    ts.trades ? plSpan(ts.expectancy, fmtPL) : '--',
    ts.trades ? '平均每筆賣出（NT$）' : '');
}

function renderRealizedSummary() {
  if (!_rplData) return;

  const allStocks = _rplData.by_stock || [];
  const stocks = _rplFilter === 'ALL' ? allStocks : allStocks.filter(s => s.market === _rplFilter);

  // Recalculate stats for filtered data
  let totalPLTwd = 0, totalCostTwd = 0;
  let bestTrade = null, worstTrade = null;

  // We need the exchange rate for USD→TWD conversion
  const rate = _rplData.overall?.usd_twd_rate || 32;

  stocks.forEach(s => {
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

  // Per-trade figures for the selected market (js/server/stocks.js tradeStats)
  const ts = _rplData.trade_stats[_rplFilter];

  // Render stats cards
  const totalPct = totalCostTwd > 0 ? (totalPLTwd / totalCostTwd) * 100 : 0;
  setStat('rpl-total',
    plSpan(totalPLTwd), `報酬率 ${plSpan(totalPct, fmtPct)}`);
  renderTradeQuality(ts);

  const divTwd = (_rplData.dividends || [])
    .filter(d => _rplFilter === 'ALL' || d.market === _rplFilter)
    .reduce((sum, d) => sum + toTWD(d.total, d.currency, rate), 0);
  setStat('rpl-div', divTwd ? `<span class="positive">${fmtTWD(divTwd)}</span>` : '--');
  const withDiv = totalPLTwd + divTwd;
  setStat('rpl-total-div', plSpan(withDiv), '已實現損益 ＋ 股利');
  if (bestTrade) {
    const worst = worstTrade ? ` · 最差 ${escapeHtml(stockText(worstTrade.symbol))} ${plSpan(worstTrade.pct, fmtPct)}` : '';
    setStat('rpl-best', plSpan(bestTrade.pct, fmtPct), escapeHtml(stockText(bestTrade.symbol)) + worst);
  } else {
    setStat('rpl-best', '--');
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
        <td><strong>${stockHTML(s.symbol)}</strong></td>
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

let _txAll = []; // own-account transactions, newest first (the API's order)
let _txEditing = null; // the record open in the modal, null when adding
let _txSaved = false;  // saved since the modal opened: refresh holdings once it closes

/** 補登交易 (no id) or edit a row: same modal, delete only when editing. */
function openTxModal(id) {
  const form = document.getElementById('tx-form');
  const t = _txEditing = id != null ? _txAll.find(x => x.id === id) : null;
  form.reset();
  // Editing keeps the stored fee/tax (auto_fee off)
  fillForm(form, t ? { ...t, fee: t.fee || 0, tax: t.tax || 0, auto_fee: false } : { action: 'BUY', date: todayStr() });
  document.getElementById('tx-modal-title').textContent = t ? `編輯交易 · ${stockText(t.symbol)}` : '補登交易';
  document.getElementById('tx-continue-btn').style.display = t ? 'none' : '';
  document.getElementById('tx-delete-btn').style.display = t ? '' : 'none';
  openModal('modal-tx');
  if (!t) form.querySelector('[name="symbol"]').focus();
}

/** After saving: the list right away; holdings and realized P&L once, when the modal closes. */
function onTxSaved() {
  _txSaved = true;
  loadTransactions();
}

document.getElementById('modal-tx')?.addEventListener('close', () => {
  if (!_txSaved) return;
  _txSaved = false;
  loadHoldings();
  loadRealizedSummary();
});

async function submitTransaction(e) {
  e.preventDefault();
  const form = e.target;
  const val = (name) => form.querySelector(`[name="${name}"]`).value;
  const data = {
    symbol: val('symbol').trim().toUpperCase(),
    action: val('action'),
    shares: Number(val('shares')),
    price: Number(val('price')),
    fee: Number(val('fee')) || 0,
    tax: Number(val('tax')) || 0,
    auto_fee: form.querySelector('[name="auto_fee"]').checked,
    date: val('date'),
    note: val('note'),
  };
  const old = _txEditing;

  try {
    if (old) {
      data.market = old.market;
      data.realized_pl = old.realized_pl || 0;
      const result = await api(`/api/transactions/${old.id}`, { method: 'PUT', body: JSON.stringify(data) });
      showToast('交易已更新，持倉與已實現損益已重新計算', 'success');
      showLedgerWarnings(result);
    } else {
      const result = await api('/api/transactions', { method: 'POST', body: JSON.stringify(data) });
      const pl = data.action === 'SELL' && result && result.realized_pl != null
        ? `，已實現損益 ${fmtPLCur(result.realized_pl, result.currency)}` : '';
      showToast(`已記錄 ${stockText(data.symbol)} ${data.action === 'BUY' ? '買入' : '賣出'} ${fmt(data.shares)} 股${pl}`, 'success');
    }
    onTxSaved();
    if (!old && e.submitter?.dataset.continue) {
      // Keep the stock, action and date; clear the rest for the next one
      fillForm(form, { shares: '', price: '', fee: 0, tax: 0, note: '' });
      form.querySelector('[name="shares"]').focus();
    } else {
      closeModal('modal-tx');
    }
  } catch (err) {
    showToast('儲存失敗: ' + err.message, 'error');
  }
}

async function deleteTransaction() {
  if (!_txEditing || !confirm('確定要刪除此筆交易嗎？')) return;
  try {
    const result = await api(`/api/transactions/${_txEditing.id}`, { method: 'DELETE' });
    showToast('交易已刪除，持倉與已實現損益已重新計算', 'success');
    showLedgerWarnings(result);
    onTxSaved();
    closeModal('modal-tx');
  } catch (err) {
    showToast('刪除失敗: ' + err.message, 'error');
  }
}

async function loadTransactions() {
  try {
    const list = await api('/api/transactions');
    _txAll = Array.isArray(list) ? list : [];
    fillYearFilter(document.getElementById('tx-year-filter'), _txAll.map(t => t.date));
    renderTransactions();
  } catch (err) {
    showToast('載入交易紀錄失敗: ' + err.message, 'error');
  }
}

const onTxSearch = debounce(() => renderTransactions());

/** Search: every word must appear in the symbol, its name, note, date or 買／賣 (台股 / 美股 too). */
function txMatches(t, words) {
  const text = [t.symbol, stockName(t.symbol), t.note, t.date, t.action === 'BUY' ? '買入' : '賣出', t.market === 'TW' ? '台股' : '美股']
    .join(' ').toLowerCase();
  return words.every(w => text.includes(w));
}

function renderTransactions() {
  const year = document.getElementById('tx-year-filter').value;
  const words = searchWords('tx-search');
  const inYear = _txAll.filter(t => !year || (t.date || '').startsWith(year));
  const list = words.length ? inYear.filter(t => txMatches(t, words)) : inYear;
  document.getElementById('tx-count').textContent = _txAll.length ? `${year ? `${year} 年 ` : ''}${inYear.length} 筆` : '';

  const summary = document.getElementById('tx-search-summary');
  summary.hidden = !words.length;
  if (words.length) {
    const buys = list.filter(t => t.action === 'BUY').length;
    const sells = list.length - buys;
    // One stock: how many shares the shown records add up to (bought − sold)
    const net = new Set(list.map(t => t.symbol)).size === 1
      ? list.reduce((s, t) => s + (t.action === 'BUY' ? t.shares : -t.shares), 0) : null;
    summary.textContent = [`找到 ${list.length} 筆`, buys && sells ? `買 ${buys} · 賣 ${sells}` : '',
      net != null ? `合計${net >= 0 ? '買進' : '賣出'} ${fmt(Math.abs(net))} 股` : ''].filter(Boolean).join(' · ');
  }

  const tbody = document.getElementById('tx-body');
  if (list.length === 0) {
    const msg = words.length ? '找不到符合的交易' : _txAll.length ? '這一年沒有交易' : '尚無交易紀錄。平常買賣在「持倉總覽」記；過去的交易按「+ 補登交易」或用 AI 匯入對帳單';
    tbody.innerHTML = `<tr><td colspan="8" class="empty-state">${msg}</td></tr>`;
    return;
  }
  tbody.innerHTML = list.map(t => {
    const fees = (t.fee || 0) + (t.tax || 0);
    const feeTitle = t.tax ? ` title="手續費 ${fmt(t.fee, 0)}＋證交稅 ${fmt(t.tax, 0)}"` : '';
    return `
        <tr class="tx-row" tabindex="0" title="點一下編輯或刪除" onclick="openTxModal(${t.id})" onkeydown="if (event.key === 'Enter') openTxModal(${t.id})">
          <td>${t.date || '--'}</td>
          <td><strong>${stockHTML(t.symbol)}</strong></td>
          <td><span class="${t.action === 'BUY' ? 'tag-buy' : 'tag-sell'}">${t.action === 'BUY' ? '買' : '賣'}</span></td>
          <td>${fmt(t.shares)}</td>
          <td>${fmtNum(t.price, 2)}</td>
          <td${feeTitle}>${fees ? fmt(fees, 0) : '--'}</td>
          <td class="${plClass(t.realized_pl)}">${t.realized_pl ? fmtPLCur(t.realized_pl, t.currency) : '--'}</td>
          <td>${escapeHtml(t.note || '')}</td>
        </tr>`;
  }).join('');
}

// ============================================================
// SECTION: Portfolio Analysis
// ============================================================

const MKT = { TW: { cls: 'tw', short: '台' }, US: { cls: 'us', short: '美' } };
const CONCENTRATION = { warn: ['偏高', 'risk-warn'], danger: ['高度集中', 'risk-danger'] };

/** 組合分析: numbers come from /api/stocks/portfolio (js/server/portfolio.js); this only renders. */
async function loadPortfolioAnalysis() {
  loadLookThrough(); // separate: it needs the Yahoo proxy and can fail on its own
  loadStressTest();
  try {
    const p = await api('/api/stocks/portfolio');
    if (!p) {
      document.getElementById('pf-weights').innerHTML = '<div class="empty-state">尚無持股（或還沒抓到報價）</div>';
      return;
    }
    renderPortfolioStats(p);
    renderPortfolioWeights(p.rows);
  } catch (err) {
    showToast('載入投資組合分析失敗: ' + err.message, 'error');
  }
}

function renderPortfolioStats(p) {
  const top = p.rows[0];
  setStat('pf-top', `<span class="${top.level ? CONCENTRATION[top.level][1] : ''}">${top.weight.toFixed(1)}%</span>`,
    `${escapeHtml(stockText(top.symbol))}${p.rows.length > 3 ? ` · 前 3 大 ${p.top3.toFixed(1)}%` : ''}`);
  setStat('pf-effective', `${p.effective.toFixed(1)} 檔`, `實際持有 ${p.rows.length} 檔；越小越集中`);
  const usdTotal = p.usd.stock + (p.usd.cash || 0);
  document.getElementById('pf-usd-card').hidden = !(usdTotal > 0); // no US stock or USD cash
  setStat('pf-usd', p.usd.pct == null ? '--' : `${p.usd.pct.toFixed(1)}%`,
    `淨資產中美金計價的比例<br>美股 ${fmtTWD(p.usd.stock)}${p.usd.cash == null ? '（尚無快照，只算股票）' : ` ＋ 美金現金 ${fmtTWD(p.usd.cash)}`}<br>台幣升值 1% ≈ ${fmtPL(-usdTotal / 100)}`);
  const d = p.dividends;
  setStat('pf-div', fmtTWD(d.ttm), d.ttm > 0 ? `月均 ${fmtTWD(d.ttm / 12)} · 殖利率 ${fmtYield(d.yield_cost)}` : '近 12 個月沒有股利紀錄');
}

/** 股市大跌時 (/api/profile/stress): each drop's hit to net worth, against the drop the user can take (AI 分析 › 關於你). */
async function loadStressTest() {
  let st = null;
  try {
    st = await api('/api/profile/stress');
  } catch (err) { /* the card just stays hidden */ }
  const card = document.getElementById('stress-card');
  card.hidden = !st;
  if (!st) return;
  const max = st.max_drawdown;
  // Scale so the biggest drop and the user's limit both fit
  const scale = Math.max(st.drops.at(-1).nw_pct, max || 0) * 1.15;
  const mark = max ? `<span class="stress-mark" style="left:${max / scale * 100}%" title="你能接受的跌幅 ${max}%"></span>` : '';
  document.getElementById('stress-rows').innerHTML = st.drops.map((d) => `
    <div class="stress-row${d.over ? ' over' : ''}">
      <div class="stress-label">股市跌 ${d.drop}%</div>
      <div class="stress-track"><span class="stress-fill" style="width:${d.nw_pct / scale * 100}%"></span>${mark}</div>
      <div class="stress-value">淨資產 <strong class="negative">−${d.nw_pct.toFixed(1)}%</strong><span class="stress-sub">少 ${fmtWan(d.loss)}，剩 ${fmtWan(d.remaining)}${d.over ? ` · 超過你能接受的 ${max}%` : ''}</span></div>
    </div>`).join('');

  const hints = [max
    ? `細線是你能接受的跌幅（淨資產 −${max}%）。`
    : '到 <a href="#" onclick="goToTab(\'llm\'); return false">AI 分析 › 關於你</a> 填「可接受的最大跌幅」，這裡會標出超過的情境。'];
  if (st.big.length) {
    const list = st.big.map(bigExpenseLabel).join('、');
    hints.push(`${st.years} 年內的大筆支出：${list}。` + (
      st.cash == null ? ''
        : st.shortfall > 0 ? `現金 ${fmtWan(st.cash)}，不夠的 ${fmtWan(st.shortfall)} 得從股票來；如果那時剛好股市跌 ${st.sale_drop}%，要賣掉跌前價值約 ${fmtWan(st.sale_at_drop)} 的股票才湊得到。`
          : '現金就夠付，股市大跌也不用被迫賣股。'));
  }
  document.getElementById('stress-hint').innerHTML = hints.join('<br>');
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
        <span class="pf-sym">${stockHTML(r.symbol)}</span>
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

// ---- 穿透持股: numbers from /api/stocks/lookthrough (js/server/lookthrough.js); this only renders.

const LT_ROWS = 15; // rows shown before 顯示全部
let _lt = null;
let _ltMode = 'all'; // 'all' | 'etf'
let _ltAll = false;
try { if (localStorage.getItem('lookThroughMode') === 'etf') _ltMode = 'etf'; } catch (e) { /* ignore */ }


async function loadLookThrough() {
  try {
    _lt = await api('/api/stocks/lookthrough');
  } catch (err) {
    _lt = null;
    ['lt-compare', 'lt-legend', 'lt-hint'].forEach(id => { document.getElementById(id).innerHTML = ''; });
    document.getElementById('lt-rows').innerHTML = `<div class="empty-state">查不到 ETF 成分股：${escapeHtml(err.message)}</div>`;
    document.getElementById('lt-more').hidden = true;
    return;
  }
  renderLookThrough();
}

function setLookThroughMode(mode) {
  _ltMode = mode;
  try { localStorage.setItem('lookThroughMode', mode); } catch (e) { /* ignore */ }
  renderLookThrough();
}

function toggleLookThroughAll() {
  _ltAll = !_ltAll;
  renderLookThrough();
}

function renderLookThrough() {
  document.querySelectorAll('#lt-card [data-lt-mode]').forEach(b => b.classList.toggle('active', b.dataset.ltMode === _ltMode));
  const box = document.getElementById('lt-rows');
  const more = document.getElementById('lt-more');
  const p = _lt;
  if (!p) {
    box.innerHTML = '<div class="empty-state">尚無持股（或還沒抓到報價）</div>';
    more.hidden = true;
    return;
  }
  const etfMode = _ltMode === 'etf';
  const pct = (w) => `${w.toFixed(1)}%`;
  // Source colors: direct, then each ETF in size order (cycling)
  const colors = new Map([['direct', 'var(--lt-direct)'], ...p.etfs.map((e, i) => [e.symbol, `var(--lt-${i % 6})`])]);
  const ltColor = (src) => colors.get(src) || 'var(--lt-5)';

  // Before → after
  const a = p.after;
  const item = (label, before, after, cls = '') => `<div class="lt-compare-item">
    <div class="lt-compare-label">${label}</div>
    <div class="lt-compare-value"><span>${before}</span><span class="lt-arrow">→</span><span class="${cls}">${after}</span></div>
  </div>`;
  const topFlag = a && CONCENTRATION[a.top.level];
  document.getElementById('lt-compare').innerHTML = p.etfs.length && a ? [
    item('最大單一持股（穿透前 → 後）', `${escapeHtml(stockText(p.before.top.symbol))} ${pct(p.before.top.weight)}`,
      `${escapeHtml(stockText(a.top.symbol))} ${pct(a.top.weight)}`, topFlag ? topFlag[1] : ''),
    item('等效持股（穿透前 → 後）', `${p.before.effective.toFixed(1)} 檔`, `${a.effective.toFixed(1)} 檔`),
  ].join('') : '';

  const hints = [];
  if (!p.etfs.length) hints.push('目前沒有持有 ETF，穿透結果跟上面的持股權重一樣。');
  else {
    hints.push(etfMode
      ? `只拆 ETF 的 ${fmtTWD(p.etf_total)}：這些 ETF 合起來等於押在哪些公司。「另有直接持有」表示你也自己買了這檔。`
      : `ETF ${fmtTWD(p.etf_total)} 拆成成分股，再加上直接持有的 ${fmtTWD(p.direct_total)}。長條顏色是這筆錢的來源。`);
    hints.push('Yahoo 只提供各 ETF 的前十大持股，其餘歸在「其他成分股」，等效持股不計這一列。');
  }
  if (p.unresolved.length) hints.push(`查不到 ${p.unresolved.map(s => escapeHtml(symCode(s))).join('、')} 的成分股，暫以本身計算。`);
  document.getElementById('lt-hint').innerHTML = hints.join('<br>');

  const legend = (etfMode ? [] : [['direct', '直接持有']])
    .concat(p.etfs.map(e => [e.symbol, `${stockText(e.symbol)}（前十大佔 ${pct(e.listed * 100)}）`]));
  document.getElementById('lt-legend').innerHTML = p.etfs.length ? legend.map(([src, label]) =>
    `<span class="legend-item"><span class="legend-dot" style="background:${ltColor(src)}"></span>${escapeHtml(label)}</span>`).join('') : '';

  const rows = p.rows
    .map(r => ({ r, value: etfMode ? r.from_etf : r.value, weight: etfMode ? r.etf_weight : r.weight }))
    .filter(x => x.value > 0)
    .sort((x, y) => (x.r.lumped - y.r.lumped) || (y.value - x.value)); // the ETF view ranks by ETF money
  if (!rows.length) {
    box.innerHTML = '<div class="empty-state">沒有持有 ETF</div>';
    more.hidden = true;
    return;
  }
  const named = rows.filter(x => !x.r.lumped);
  const shown = (_ltAll ? named : named.slice(0, LT_ROWS)).concat(rows.filter(x => x.r.lumped));
  const scale = Math.max(...rows.map(x => x.value));

  box.innerHTML = shown.map(({ r, value, weight }) => {
    const sources = (etfMode || !(r.direct > 0) ? [] : [['direct', r.direct]])
      .concat(Object.entries(r.via).sort((x, y) => y[1] - x[1]));
    const isStock = !r.lumped;
    const ltName = isStock ? stockName(r.key, r.name) : '';
    const mkt = MKT[r.market];
    const flag = etfMode ? null : CONCENTRATION[r.level];
    let badge = '';
    if (isStock && etfMode && r.direct > 0) badge = `<span class="lt-badge lt-badge-direct" title="另外直接持有 ${fmtTWD(r.direct)}">另有直接持有</span>`;
    else if (isStock && !etfMode && r.from_etf > 0 && !(r.direct > 0)) badge = '<span class="lt-badge">僅 ETF</span>';
    // Held directly under another listing (TSM for 2330): name every listing held
    const heldElsewhere = r.held_as.some(s => s !== r.key);
    const srcText = (src) => (src === 'direct' ? `直接${heldElsewhere ? ` ${r.held_as.map(symCode).join('＋')}` : ''}` : symCode(src));
    const sub = sources.map(([src, v]) =>
      `<span class="lt-src" style="--c:${ltColor(src)}">${escapeHtml(srcText(src))} ${fmtTWD(v)}</span>`).join(' · ');
    return `<div class="pf-row${mkt ? ` pf-mkt-${mkt.cls}` : ''}">
      <div class="pf-row-head">
        <span class="pf-sym">${escapeHtml(isStock ? symCode(r.key) : r.name)}</span>
        ${mkt ? `<span class="pf-mkt">${mkt.short}</span>` : ''}
        ${isStock && ltName ? `<span class="sym-name" title="${escapeAttr(ltName)}">${escapeHtml(ltName)}</span>` : ''}
        ${badge}
        ${flag ? `<span class="pf-flag ${flag[1]}">${flag[0]}</span>` : ''}
        <span class="pf-weight">${pct(weight)}</span>
      </div>
      <div class="source-bar cat-track lt-stack" aria-hidden="true" style="width:${value / scale * 100}%">${sources.map(([src, v]) =>
        `<span style="width:${v / value * 100}%;background:${ltColor(src)}"></span>`).join('')}</div>
      <div class="pf-row-sub">${fmtTWD(value)}${r.from_etf > 0 ? `：${sub}` : r.kind === 'unresolved' ? '（查不到成分股）' : ''}</div>
    </div>`;
  }).join('');

  more.hidden = named.length <= LT_ROWS;
  more.textContent = _ltAll ? `只顯示前 ${LT_ROWS} 檔` : `顯示全部 ${named.length} 檔`;
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
    title.textContent = `買入 ${stockText(symbol)}`;
    submitBtn.textContent = '確認買入';
    submitBtn.className = 'btn btn-buy';
    info.innerHTML = `<strong>${stockHTML(symbol)}</strong> 目前持有 ${fmt(currentShares)} 股`;
  } else {
    title.textContent = `賣出 ${stockText(symbol)}`;
    submitBtn.textContent = '確認賣出';
    submitBtn.className = 'btn btn-sell';
    info.innerHTML = `<strong>${stockHTML(symbol)}</strong> 目前持有 <strong>${fmt(currentShares)} 股</strong>（可賣出上限）`;
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
      showToast(`${stockText(data.symbol)} 賣出 ${data.shares} 股完成`, 'success');
    } else {
      showToast(`${stockText(data.symbol)} 買入 ${data.shares} 股完成`, 'success');
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
/** Set named form fields (checkboxes take a boolean); keys with no field (a record's id…) are skipped. */
function fillForm(form, values) {
  Object.entries(values).forEach(([name, v]) => {
    const el = form.querySelector(`[name="${name}"]`);
    if (!el) return;
    if (el.type === 'checkbox') el.checked = !!v;
    else el.value = v;
  });
}

function enterEditMode(form, { id, values, extra = {}, submitLabel, onCancel }) {
  fillForm(form, values);
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

// Server reports SELLs that lost their BUY records after an edit/delete
function showLedgerWarnings(result) {
  const warnings = result && result.warnings;
  if (warnings && warnings.length) showToast(warnings.join('\n'), 'error');
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
    if (!el) return;
    el.innerHTML = xirrHtml(data[market]);
    // A market never traded has only today's (zero) value as a flow
    if (market !== 'ALL') el.parentElement.hidden = !(data[market] && data[market].flows > 1);
  });
}

// ============================================================
// SECTION: Performance (time-weighted return by period)
// ============================================================

let _perfData = null;
let _heatmapSeg = 'ALL';

/** The performance card appears twice: on 總覽 without the risk table, and on 績效 in full. */
const PERF_VIEWS = {
  dash: { root: 'perf-dash', risk: false, period: 'YTD', chart: null },
  main: { root: 'perf-main', risk: true, period: '1Y', chart: null },
};
const perfEl = (view, name) => document.querySelector(`#${PERF_VIEWS[view].root} [data-perf="${name}"]`);

const PERF_ROWS = [
  { seg: 'ALL', name: '全部', color: '#4e8cff', width: 2 },
  { seg: 'TW', name: '台股', color: '#34d399', width: 1.5, dash: [4, 2] },
  { seg: 'US', name: '美股', color: '#fbbf24', width: 1.5, dash: [4, 2] },
];

/** 全部 plus each market that was ever held; with one market, 全部 already is it. */
function perfRows() {
  const m = (_perfData && _perfData.markets) || ['TW', 'US'];
  return m.length > 1 ? PERF_ROWS.filter(r => r.seg === 'ALL' || m.includes(r.seg)) : PERF_ROWS.slice(0, 1);
}

const PERF_TITLE = '時間加權報酬（TWR，同 IB「業績」）：每天算 (收盤市值 + 當日賣出所得與股利) ÷ (前一日市值 + 當日買入成本) − 1，再把每天串乘起來。&#10;' +
  '它衡量「投資的選擇」好不好：買賣的時點與金額不影響報酬率，已實現、未實現、股利、手續費、匯率都包含在內。&#10;' +
  '+100% 代表期初的 1 元變成 2 元，不是「賺的錢 ÷ 投入成本」。年化 = 換算成每年平均的複利報酬。&#10;' +
  '只算股票部位（不含現金），以台幣計；歷史市值用 Yahoo 日收盤價與當日匯率重建，股利以除息日計。&#10;' +
  '下方金額才是實際賺賠的錢：期末市值 − 期初市值 − 買入 + 賣出 + 股利。錢大多在下跌前才投入時，報酬率可能是正的、金額卻是負的。';

function perfCardHtml(view) {
  const { risk } = PERF_VIEWS[view];
  return `<div class="card">
    <div class="card-header">
      <h3 title="${PERF_TITLE}">投資績效（時間加權報酬）ⓘ</h3>
    </div>
    <p class="form-hint card-hint"><span data-perf="note"></span>${view === 'main' ? '<span id="perf-check-badge"></span>' : ''}</p>
    <div class="chart-controls perf-controls">
      <div class="chart-type-toggle" data-perf="periods"></div>
      <select data-perf="bench" class="input-sm" data-segmented aria-label="比較大盤" onchange="renderPerfChart(PERF_VIEWS.${view}.period, '${view}')" title="比較基準用含息還原價（股利再投入），美股換算成台幣">
        <option value="">不比較大盤</option>
      </select>
    </div>
    <div class="chart-container-md"><canvas data-perf="chart"></canvas></div>
    <div class="table-wrap">
      <table class="perf-table">
        <thead><tr data-perf="head"><th></th></tr></thead>
        <tbody data-perf="body"><tr><td class="text-muted">載入中…</td></tr></tbody>
      </table>
    </div>
    ${risk ? `<div class="table-wrap">
      <table class="perf-risk-table">
        <thead><tr data-perf="risk-head"></tr></thead>
        <tbody data-perf="risk-body"></tbody>
      </table>
    </div>` : ''}
  </div>`;
}

function initPerfCards() {
  for (const view of Object.keys(PERF_VIEWS)) {
    const el = document.getElementById(PERF_VIEWS[view].root);
    if (el) el.innerHTML = perfCardHtml(view);
  }
}

/** The benchmark picked in the view's dropdown, or undefined */
function selectedBench(view) {
  const sym = perfEl(view, 'bench').value;
  return ((_perfData && _perfData.benchmarks) || []).find(b => b.symbol === sym);
}

let _perfPromise = null;
let _perfAt = 0; // when _perfPromise was started

/** /api/stocks/performance, fetched once and shared until data changes (invalidatePerf). */
function getPerf() {
  if (!_perfPromise) _perfAt = Date.now();
  _perfPromise ||= api('/api/stocks/performance')
    .then(d => (_perfData = d))
    .catch(err => { _perfPromise = null; throw err; });
  return _perfPromise;
}

/** Called by main.js on every data change, and when the data is over 5 minutes old (today's quotes). */
function invalidatePerf() {
  _perfPromise = null;
  _perfData = null;
}

/** Fill one performance card (and, on 績效, the monthly heatmap). */
async function loadPerformance(view = 'main') {
  const head = perfEl(view, 'head');
  const body = perfEl(view, 'body');
  if (!head || !body) return;
  let data;
  try {
    if (Date.now() - _perfAt > 5 * 60 * 1000) invalidatePerf(); // pick up today's quotes, but not on every visit
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

  const benchSel = perfEl(view, 'bench');
  const benchKept = benchSel.value;
  // Buttons show the ticker (0050, SPY…); the full name is the tooltip
  benchSel.innerHTML = '<option value="" data-short="不比較大盤">不比較大盤</option>' +
    (data.benchmarks || []).map(b => `<option value="${b.symbol}" data-short="${escapeAttr(symCode(b.symbol))}">比較 ${b.label}</option>`).join('');
  segmentSelect(benchSel);
  benchSel.value = benchKept;

  head.innerHTML = '<th></th>' + periods.map(p => {
    const title = `${p.start} 收盤 → ${data.as_of}（${p.days} 天）` +
      (p.partial ? '\n期間起點早於起算日，從起算日開始算' : '');
    return `<th data-period="${p.key}" class="perf-period-th" title="${title}" onclick="renderPerfChart('${p.key}', '${view}')">${p.label}${p.partial ? '*' : ''}</th>`;
  }).join('');
  perfEl(view, 'periods').innerHTML = periods.map(p =>
    `<button class="chart-type-btn" data-period="${p.key}" onclick="renderPerfChart('${p.key}', '${view}')">${p.label}</button>`).join('');

  const notes = [`自 ${data.inception} 起`];
  if (data.start_setting) notes.push('起算日可在設定頁調整');
  if (data.missing && data.missing.length) notes.push(`${data.missing.join(', ')} 無 Yahoo 歷史價，以成交價估`);
  perfEl(view, 'note').textContent = notes.join(' · ');
  renderPerfChart(PERF_VIEWS[view].period, view);
  if (view === 'main') {
    const rows = perfRows();
    const seg = document.getElementById('heatmap-seg');
    seg.hidden = rows.length < 2;
    seg.innerHTML = rows.map(r => `<button class="chart-type-btn" data-seg="${r.seg}" onclick="renderHeatmap('${r.seg}')">${r.name}</button>`).join('');
    renderHeatmap(rows.some(r => r.seg === _heatmapSeg) ? _heatmapSeg : 'ALL');
    renderRolling();
  }
}

/** Benchmark line colors (the first one is the one compared by default). */
const BENCH_COLORS = ['#c3cede', '#a78bfa', '#f472b6'];

/** One line of a % chart. */
const pctLine = (label, data, color, width, dash, hidden = false) => ({
  label, data, borderColor: color, backgroundColor: 'transparent', hidden,
  borderWidth: width, borderDash: dash || [], pointRadius: 0, pointHoverRadius: 5, pointHitRadius: 8, tension: 0,
});

/** A % line chart (績效, 滾動一年報酬): legend on top, the 0% gridline emphasized. Replaces `old`. */
function pctLineChart(canvas, old, labels, datasets, tooltipTitle) {
  if (old) old.destroy();
  return new Chart(canvas, {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: true, position: 'top', labels: { color: '#8a9ab5', usePointStyle: true, pointStyle: 'line', font: { size: 11 } } },
        tooltip: { callbacks: { ...(tooltipTitle && { title: tooltipTitle }), label: c => c.parsed.y == null ? null : `${c.dataset.label}: ${fmtPct(c.parsed.y)}` } },
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

let _rollingChart = null;

/** 滾動一年報酬: the markets' 1-year windows against the benchmarks (only the first shown at first). */
function renderRolling() {
  const data = _perfData;
  const s = data.series;
  const rows = perfRows();
  const benches = data.benchmarks || [];
  const head = document.getElementById('rolling-head');
  const body = document.getElementById('rolling-body');
  if (!data.rolling || !data.rolling.ALL) {
    head.innerHTML = '';
    body.innerHTML = '<tr><td class="text-muted">要有一年以上的紀錄才算得出來。</td></tr>';
    if (_rollingChart) { _rollingChart.destroy(); _rollingChart = null; }
    return;
  }
  const cols = [...rows.map(r => ({ key: r.seg, name: r.name })), ...benches.map(b => ({ key: b.symbol, name: b.label }))];
  head.innerHTML = '<th></th>' + cols.map(c => `<th>${c.name}</th>`).join('');
  const cells = fn => cols.map(c => { const r = data.rolling[c.key]; return `<td>${r ? fn(r) : '--'}</td>`; }).join('');
  const pct = v => plSpan(v, fmtPct);
  body.innerHTML = `
    <tr><td>最好的一年</td>${cells(r => `${pct(r.best)}<span class="cell-sub">到 ${r.best_date}</span>`)}</tr>
    <tr><td>最差的一年</td>${cells(r => `${pct(r.worst)}<span class="cell-sub">到 ${r.worst_date}</span>`)}</tr>
    <tr><td title="把所有一年期的報酬排序後的中間值：比平均更不受極端值影響">中位數 ⓘ</td>${cells(r => pct(r.median))}</tr>
    <tr><td title="所有一年期中，報酬是負的比例">抱一年會虧錢的機率 ⓘ</td>${cells(r => `${r.negative_pct.toFixed(0)}%`)}</tr>`;

  const first = s.dates.findIndex((_, i) => s.rolling.ALL[i] != null);
  const idx = weekdayIndexes(s.dates, Math.max(first, 0));
  const at = vals => idx.map(i => (vals || [])[i]);
  const datasets = [
    ...rows.map(r => pctLine(r.name, at(s.rolling[r.seg]), r.color, r.width, r.dash)),
    ...benches.map((b, i) => pctLine(b.label, at(s.rolling[b.symbol]), BENCH_COLORS[i % BENCH_COLORS.length], 1.5, [1, 3], i > 0)),
  ];
  _rollingChart = pctLineChart(document.getElementById('chart-rolling'), _rollingChart, idx.map(i => s.dates[i]), datasets,
    c => `${c[0].label} 往回一年`);
}

/** Return rows per market, plus the selected benchmark's row */
function renderPerfTableBody(view) {
  const data = _perfData;
  const periods = data.periods || [];
  let html = perfRows().map(({ seg, name }) => `<tr><td><strong>${name}</strong></td>` + periods.map(p => {
    const r = p.markets[seg];
    if (!r || r.twr == null) return '<td>--</td>';
    const title = `期初市值 ${fmtTWD(r.start_value)}\n期末市值 ${fmtTWD(r.end_value)}`;
    const annual = r.annualized != null ? ` · 年化 ${fmtPct(r.annualized)}` : '';
    return `<td title="${title}"><span class="${plClass(r.twr)}">${fmtPct(r.twr)}</span>` +
      `<span class="cell-sub ${plClass(r.pnl)}">${fmtTWD(r.pnl)}${annual}</span></td>`;
  }).join('') + '</tr>').join('');

  const bench = selectedBench(view);
  if (bench) {
    html += `<tr class="perf-bench-row"><td>${bench.label}</td>` + periods.map(p => {
      const v = p.bench[bench.symbol];
      return `<td>${v == null ? '--' : `<span class="${plClass(v)}">${fmtPct(v)}</span>`}</td>`;
    }).join('') + '</tr>';
  }
  perfEl(view, 'body').innerHTML = html;
}

/** Cumulative TWR line chart for one period: the daily growth index rebased to 0% at the period's start close. */
function renderPerfChart(key, view = 'main') {
  const data = _perfData;
  const p = data && (data.periods || []).find(x => x.key === key);
  const s = data && data.series;
  const v = PERF_VIEWS[view];
  if (!p || !s) return;
  v.period = key;
  renderPerfTableBody(view);
  document.querySelectorAll(`#${v.root} [data-perf="periods"] .chart-type-btn, #${v.root} .perf-period-th`).forEach(el =>
    el.classList.toggle('active', el.dataset.period === key));
  if (v.risk) renderPerfRisk(p, view);

  // Window from the period's base close to today; weekends are flat, drop them.
  let b = s.dates.findIndex(d => d >= p.start);
  if (b < 0) b = 0;
  const idx = weekdayIndexes(s.dates, b);
  // A line that starts mid-window is rebased at its own first point.
  const rebased = vals => {
    const base = idx.map(i => vals[i]).find(v => v != null);
    return idx.map(i => (vals[i] == null || !base) ? null : (vals[i] / base - 1) * 100);
  };
  const datasets = perfRows().map(r => pctLine(r.name, rebased(s.growth[r.seg] || []), r.color, r.width, r.dash));
  const bench = selectedBench(view);
  if (bench) datasets.push(pctLine(bench.label, rebased(s.bench[bench.symbol] || []), BENCH_COLORS[0], 1.5, [1, 3]));
  v.chart = pctLineChart(perfEl(view, 'chart'), v.chart, idx.map(i => s.dates[i]), datasets);
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
// SECTION: 績效 — market value trend (from the performance series, no manual snapshots)
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

const TREND_SEG_LABEL = { ALL: '合計', ...MARKET_LABEL };
const compColor = (key) => COMP_PARTS.find(p => p.key === key).color;
/** Series colors: 市值 per market (as in the 總覽 composition bar), 未實現 / 已實現 as the CVD-checked blue / orange pair */
const trendColor = (key) => ({ ALL: '#4e8cff', TW: compColor('tw'), US: compColor('us') }[key] || seriesColor(key));
const trendPick = (name) => document.querySelector(`[data-trend="${name}"] .active`)?.dataset.v;
const unrealPct = (pl, cost) => (cost > 0 ? fmtPct(pl / cost * 100) : '--');
let _trendPeriod = '1Y';

function renderHoldingsTrend() {
  const s = _perfData && _perfData.series;
  if (!s || !s.dates || !s.dates.length) return;
  const segToggle = document.querySelector('[data-trend="seg"]');
  const shown = perfRows().map(r => r.seg);
  segToggle.hidden = shown.length < 2;
  segToggle.querySelectorAll('.chart-type-btn').forEach(b => { b.hidden = !shown.includes(b.dataset.v); });
  if (!shown.includes(trendPick('seg'))) segToggle.querySelectorAll('.chart-type-btn').forEach(b => b.classList.toggle('active', b.dataset.v === 'ALL'));
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
  const unreal = (i) => s.unrealized[seg][i]; // net of estimated 台股 sell fee + tax, like the holdings page

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

/** Sortino: negative loses money, 2 and up is strong. */
const sortinoClass = (v) => (v < 0 ? 'negative' : v >= 2 ? 'positive' : '');

/** Max drawdown and volatility of the selected period, per market */
function renderPerfRisk(p, view) {
  const rows = perfRows();
  perfEl(view, 'risk-head').innerHTML =
    `<th>風險（${p.label}）</th>` + rows.map(r => `<th>${r.name}</th>`).join('');
  const cells = fn => rows.map(({ seg }) => {
    const r = p.markets[seg];
    return `<td>${r && r.twr != null ? fn(r) : '--'}</td>`;
  }).join('');
  const md = d => d.slice(5);
  perfEl(view, 'risk-body').innerHTML = `
    <tr><td title="期間內從最高點到之後最低點的最大跌幅">最大回撤 ⓘ</td>${cells(r => r.max_drawdown ? `<span class="negative">${fmtPct(r.max_drawdown)}</span>` : '0%')}</tr>
    <tr><td>回撤期間</td>${cells(r => !r.dd_peak ? '--' :
      `${md(r.dd_peak)} → ${md(r.dd_trough)}<span class="cell-sub">${r.dd_recovered ? `${md(r.dd_recovered)} 回到高點` : '尚未回到高點'}</span>`)}</tr>
    <tr><td title="每日報酬的標準差 × √252，越大代表波動越劇烈。0050 長期約 15–20%">年化波動度 ⓘ</td>${cells(r => r.volatility == null ? '--' : r.volatility.toFixed(1) + '%')}</tr>
    <tr><td title="年化報酬 ÷ 下跌日的波動（只把下跌算成風險，上漲的波動不扣分；無風險利率以 0 計）。&#10;每承受一單位「下跌」換到多少報酬：1 以上不錯、2 以上很好，負的代表期間在賠錢。">Sortino 比率 ⓘ</td>${cells(r => r.sortino == null ? '--' : `<span class="${sortinoClass(r.sortino)}">${r.sortino.toFixed(2)}</span>`)}</tr>`;
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
    return `<td style="background:rgba(var(${v >= 0 ? '--up-rgb' : '--down-rgb'}),${a.toFixed(2)})">${fmtPct(v)}</td>`;
  };
  body.innerHTML = years.map(y =>
    `<tr><td><strong>${y.year}</strong></td>${y.months.map(v => cell(v, 10)).join('')}${cell(y.total, 30)}</tr>`).join('');
}

// ============================================================
// SECTION: Data health check
// ============================================================

/** /api/data-check (price history, Yahoo dividends: slow), shared until data changes (invalidateDataCheck). */
let _dataCheckPromise = null;
function getDataCheck() {
  _dataCheckPromise ||= api('/api/data-check').catch(err => { _dataCheckPromise = null; throw err; });
  return _dataCheckPromise;
}
function invalidateDataCheck() { _dataCheckPromise = null; }
const dataCheckWarnings = (d) => (d.checks || []).filter(c => c.level === 'warn');

/** A data check's affected records, collapsed. withDetail: put the explanation inside (the dashboard has no room for it). */
function checkItemsHtml(c, withDetail = false) {
  if (!c.items || !c.items.length) return '';
  return `<details class="check-items"><summary>看明細（${c.items.length}）</summary>
    ${withDetail && c.detail ? `<p>${escapeHtml(c.detail)}</p>` : ''}<ul>${c.items.map(x => `<li>${escapeHtml(x)}</li>`).join('')}</ul></details>`;
}

/** Warning count next to the performance note, linking to the settings page */
async function loadDataCheckBadge() {
  const badge = document.getElementById('perf-check-badge');
  if (!badge) return;
  let d;
  try {
    d = await getDataCheck();
  } catch (_) { return; }
  const warns = dataCheckWarnings(d).length;
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
  assets: ['新增快照', () => openSnapshotModal()],
  portfolio: ['看組合分析', () => goToTab('stocks', 'portfolio')],
  expenses: ['去記帳', () => goToTab('expenses')],
  settings: ['去設定', () => goToTab('settings')],
};

async function loadDataCheck() {
  const list = document.getElementById('data-check-list');
  if (!list) return;
  list.innerHTML = '<p class="text-muted">檢查中…</p>';
  let d;
  try {
    invalidateDataCheck(); // the settings page always rechecks
    d = await getDataCheck();
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
      <div class="check-title"><span class="check-icon">${CHECK_ICONS[c.level] || ''}</span><span>${escapeHtml(c.title)}</span>
        ${action ? `<button type="button" class="btn btn-outline btn-sm" onclick="CHECK_ACTIONS['${c.action}'][1]()">${action[0]}</button>` : ''}</div>
      ${c.detail ? `<div class="check-detail">${escapeHtml(c.detail)}</div>` : ''}
      ${checkItemsHtml(c)}
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
  loadDividendSources();
  try {
    _dividends = await api('/api/dividends');
    fillYearFilter(document.getElementById('div-year-filter'), _dividends.map(d => d.date), '全部年度');
    const form = document.getElementById('div-form');
    if (form && !form.querySelector('[name="date"]').value) form.querySelector('[name="date"]').value = todayStr();
    renderDividends();
  } catch (err) {
    showToast('載入股利失敗: ' + err.message, 'error');
  }
}

/** 「比前一年 +X：哪幾檔」 under a 股利來源 year; nothing for the first year. */
function changeLine(y, drivers) {
  if (y.change == null) return '';
  if (Math.abs(y.change) < 1) return '<br>和前一年一樣';
  return `<br>比前一年 <span class="${plClass(y.change)}">${signedWan(y.change)}</span>${drivers ? `：${drivers}` : ''}`;
}

/** 股利來源 (js/server/dividends.js dividendSources): each year split by stock, and what moved it. */
async function loadDividendSources() {
  let r;
  try {
    r = await api('/api/dividends/sources');
  } catch (err) {
    return; // the records below still show
  }
  const card = document.getElementById('div-sources-card');
  card.hidden = !r.years.length;
  if (!r.years.length) return;
  // The biggest payers overall keep a color across years (same palette as 穿透持股); 其他 is gray
  const color = (sym) => { const i = r.symbols.indexOf(sym); return i >= 0 ? `var(--lt-${i})` : 'var(--lt-5)'; };
  document.getElementById('div-sources-legend').innerHTML = [...r.symbols, ...(r.has_other ? ['其他'] : [])]
    .map(s => `<span class="legend-item"><span class="legend-dot" style="background:${color(s)}"></span>${escapeHtml(s === '其他' ? s : stockText(s))}</span>`).join('');

  const max = Math.max(...r.years.map(y => y.total));
  document.getElementById('div-sources-rows').innerHTML = r.years.map(y => {
    const drivers = y.drivers.map(x => `${escapeHtml(stockText(x.symbol))} <span class="${plClass(x.delta)}">${signedWan(x.delta)}</span>`).join('、');
    return `<div class="pf-row">
      <div class="pf-row-head"><strong>${y.year}</strong><span class="pf-weight">${fmtTWD(y.total)}</span></div>
      <div class="source-bar cat-track lt-stack" aria-hidden="true" style="width:${y.total / max * 100}%">${y.parts.map(p =>
        `<span style="width:${p.amount / y.total * 100}%;background:${color(p.symbol)}" title="${escapeAttr(stockText(p.symbol))} ${fmtTWD(p.amount)}"></span>`).join('')}</div>
      <div class="pf-row-sub">${y.parts.slice(0, 3).map(p => `${escapeHtml(stockText(p.symbol))} ${(p.amount / y.total * 100).toFixed(0)}%`).join(' · ')}${
        changeLine(y, drivers)}</div>
    </div>`;
  }).join('');

  const t = r.ttm;
  document.getElementById('div-sources-hint').innerHTML = t.total > 0
    ? `近 12 個月 ${fmtTWD(t.total)}，${escapeHtml(stockText(t.parts[0].symbol))} 佔 ${t.top_share.toFixed(0)}%` +
      (t.top_share >= 50 ? '：股利現金流大多靠這一檔，它的配息政策一改變，整體股利就會跟著變。' : '。')
    : '近 12 個月沒有股利。';
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
        <td><strong>${stockHTML(d.symbol)}</strong></td>
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
    market = isTW(sym) || !sym ? 'TW' : 'US';
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
        <td><strong>${stockHTML(s.symbol)}</strong></td>
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
  loadRecentTags();
  renderExpenseTagChips();
  // _expAll can be stale or empty when opened from the dashboard (loadExpenses fills it on the 收支
  // page): re-read the records (local, fast) for the recent tags
  api('/api/expenses').then(r => {
    if (!Array.isArray(r)) return;
    _expAll = r;
    loadRecentTags();
    renderExpenseTagChips();
  }, () => {});
  openModal('modal-expense');
  document.querySelector('#expense-form [name="amount"]').focus();
}

// --- 收支 #tags: "#日本2026" in the note groups records (a trip, a project). Tapping a tag in the list
// searches for it, which ignores the month, so a trip from 11/27 to 12/10 is one list with its totals.
// Phone keyboards often type the full-width ＃; both count. A tag ends at a space or punctuation
// ("（#日本2026）" is #日本2026); text right after it without a space belongs to the tag.

const TAG_RE = /[#＃]([^\s#＃,，、。.;；:：!！?？()（）[\]【】「」『』《》<>"'“”]+)/g;
const noteTags = (note) => [...String(note || '').matchAll(TAG_RE)].map(m => `#${m[1]}`);
const sameTag = (a, b) => a.toLowerCase() === b.toLowerCase();
const MAX_TAG_CHIPS = 8;

/** Up to `max` distinct tags (any iterable), in order; case-insensitive, the first spelling wins. */
function uniqueTags(tags, max = MAX_TAG_CHIPS) {
  const seen = new Map();
  for (const t of tags) {
    if (seen.size >= max) break;
    if (!seen.has(t.toLowerCase())) seen.set(t.toLowerCase(), t);
  }
  return [...seen.values()];
}

let _recentTags = []; // newest first; worked out when the dialog opens, not on every keystroke

function loadRecentTags() {
  // Lazy: uniqueTags stops reading once it has enough, so only the newest records are parsed
  _recentTags = uniqueTags((function* () { for (const e of _expAll) yield* noteTags(e.note); })());
}

/** The dialog's tag chips: tags in the note (selected) + recently used ones; tap toggles. */
function renderExpenseTagChips() {
  const inNote = noteTags(expField('note').value);
  const tags = uniqueTags([...inNote, ..._recentTags]);
  const box = document.getElementById('expense-tag-chips');
  box.hidden = !tags.length;
  document.getElementById('expense-tag-hint').hidden = tags.length > 0;
  box.innerHTML = tags.map(t => {
    const on = inNote.some(x => sameTag(x, t));
    return `<button type="button" class="cat-chip${on ? ' active' : ''}" aria-pressed="${on}" data-tag="${escapeAttr(t)}" onclick="toggleExpenseTag(this.dataset.tag)">${escapeHtml(t)}</button>`;
  }).join('');
}

/** The note without `tag` (and one space next to it); the rest of the text is left as typed. */
function removeTag(note, tag) {
  for (const m of [...note.matchAll(TAG_RE)].reverse()) { // from the end: earlier indexes stay valid
    if (!sameTag(`#${m[1]}`, tag)) continue;
    let a = m.index, b = a + m[0].length;
    if (note[a - 1] === ' ') a--; else if (note[b] === ' ') b++;
    note = note.slice(0, a) + note.slice(b);
  }
  return note.trim();
}

function toggleExpenseTag(tag) {
  const note = expField('note');
  const has = noteTags(note.value).some(t => sameTag(t, tag));
  note.value = has ? removeTag(note.value, tag) : `${note.value.trim()} ${tag}`.trim();
  renderExpenseTagChips();
}

/** Note text with its #tags as tappable chips (inside the row button: the tap searches instead of editing). */
function noteHTML(note) {
  note = String(note || '');
  let html = '', last = 0;
  for (const m of note.matchAll(TAG_RE)) {
    html += escapeHtml(note.slice(last, m.index)) +
      `<span class="e-tag" data-tag="#${escapeAttr(m[1])}" onclick="searchExpenseTag(event, this.dataset.tag)" title="看這個標籤的所有紀錄">${escapeHtml(m[0])}</span>`;
    last = m.index + m[0].length;
  }
  return html + escapeHtml(note.slice(last));
}

/** Tapping a tag: the whole trip, so a category picked in the ranking is cleared too. */
function searchExpenseTag(event, tag) {
  event.stopPropagation();
  const input = document.getElementById('exp-search');
  input.value = tag;
  if (_expCatFilter !== null) setCategoryFilter(null);
  renderExpenseTable(expMonth());
  input.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

/** The ✕ in a search box: empty it, re-run its search (oninput) and keep typing there. */
function clearSearch(btn) {
  const input = btn.previousElementSibling;
  input.value = '';
  input.dispatchEvent(new Event('input'));
  input.focus();
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
      // Keep type, category, date and the note's #tags; clear the rest for the next entry
      form.querySelector('[name="amount"]').value = '';
      form.querySelector('[name="note"]').value = noteTags(data.note).join(' ');
      updateExpenseFxHint();
      form.querySelector('[name="amount"]').focus();
    } else {
      closeModal('modal-expense');
    }
    onTabActivated(document.body.dataset.tab || 'expenses'); // also opened from the dashboard
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
const onExpenseSearch = debounce(() => renderExpenseTable(expMonth()));

/**
 * Search: every word must appear in the note, category or currency (code / name / aliases), or equal the
 * amount; a #word must be one of the note's tags (#日本 doesn't match #日本2026 or a note just saying 日本).
 */
function expenseMatches(e, words) {
  const c = expCurrency(e.currency);
  const text = [e.note, catLabel(e.category), c.code, c.symbol, c.name, ...c.aliases].join(' ').toLowerCase();
  let tags; // parsed only for a #word
  return words.every(w => (/^[#＃]./.test(w)
    ? (tags ??= noteTags(e.note).map(t => t.toLowerCase())).includes(`#${w.slice(1)}`)
    : text.includes(w) || Number(w.replace(/,/g, '')) === e.amount));
}

/**
 * Search results summary: count and totals, the date range (2026/11/27–12/10) and, when the spending
 * has several categories, the top three ("住宿 NT$ 20,000 · 餐飲 NT$ 8,000 · 交通 NT$ 5,000").
 */
function searchSummaryHTML(records) {
  if (!records.length) return '找到 0 筆';
  const dates = records.map(e => e.date).sort();
  const first = dates[0];
  const last = dates.at(-1);
  let range = fullDate(first);
  if (last !== first) range += `–${last.startsWith(first.slice(0, 4)) ? shortDate(last) : fullDate(last)}`;
  const byCat = new Map();
  for (const e of records) {
    if (e.type === 'income') continue;
    const k = catLabel(e.category);
    byCat.set(k, (byCat.get(k) || 0) + e.amount_twd);
  }
  const top = byCat.size > 1 ? [...byCat].sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([k, v]) => `${escapeHtml(k)} ${fmtTWD(v)}`).join(' · ') : '';
  return `<div>${[`找到 ${records.length} 筆`, expTotals(records), range].filter(Boolean).join(' · ')}</div>${top ? `<div>${top}</div>` : ''}`;
}

/** Income / expense totals in TWD: "收入 +NT$ 1,500 · 支出 NT$ 1,283" (parts with nothing are left out). */
function expTotals(records) {
  let inc = 0, out = 0;
  for (const e of records) if (e.type === 'income') inc += e.amount_twd; else out += e.amount_twd;
  return [inc ? `收入 +${fmtTWD(inc)}` : '', out ? `支出 ${fmtTWD(out)}` : ''].filter(Boolean).join(' · ');
}

/**
 * The 收支明細 list: the selected month / year, or every record matching the search box. By date:
 * grouped by day (header: date, weekday, the day's totals); by amount: one list, largest first, the
 * date under the category. Each row: category with note, amount; tap to edit.
 */
function renderExpenseTable(month) {
  const prefix = month ? `${expYear()}-${String(month).padStart(2, '0')}` : String(expYear());
  const words = searchWords('exp-search');
  const filtered = _expAll.filter(e => e.date && (words.length ? expenseMatches(e, words) : e.date.startsWith(prefix)) &&
    (_expCatFilter === null || (e.category || '') === _expCatFilter));
  const summary = document.getElementById('exp-search-summary');
  summary.hidden = !words.length;
  if (words.length) {
    summary.innerHTML = searchSummaryHTML(filtered) +
      (_expCatFilter === null ? '' : `<div>只看「${escapeHtml(catLabel(_expCatFilter))}」分類，點上方「分類：… ✕」看全部</div>`);
  }
  const list = document.getElementById('expense-list');
  if (filtered.length === 0) {
    list.innerHTML = `<div class="empty-state">${words.length ? '找不到符合的紀錄' : month ? '這個月尚無紀錄' : '此年度尚無紀錄'}</div>`;
    return;
  }
  const dateText = (date) => `${words.length ? `${date.slice(0, 4)}/` : ''}${dayLabel(date)}`;
  const row = (e, meta) => `
      <button type="button" class="exp-row exp-${e.type || 'expense'}" onclick="editExpense(${e.id})" aria-label="編輯 ${escapeAttr(catLabel(e.category))}">
        <span class="e-cat">${escapeHtml(catDisplay(e.category))}${meta ? `<span class="e-meta">${meta}</span>` : ''}</span>
        <span class="e-amt">${expAmountCell(e)}</span>
      </button>`;
  if (document.getElementById('exp-sort').value === 'amount') {
    list.innerHTML = filtered.sort((a, b) => b.amount_twd - a.amount_twd)
      .map(e => row(e, [escapeHtml(dateText(e.date)), noteHTML(e.note)].filter(Boolean).join(' · '))).join('');
    return;
  }
  const days = new Map(); // date -> records, newest first (the API's order)
  for (const e of filtered) {
    if (!days.has(e.date)) days.set(e.date, []);
    days.get(e.date).push(e);
  }
  list.innerHTML = [...days].map(([date, recs]) => `
      <div class="exp-day"><span>${dateText(date)}</span><span>${expTotals(recs)}</span></div>` +
    recs.map(e => row(e, noteHTML(e.note))).join('')).join('');
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
// SECTION: AI 分析 › 關於你 (js/server/profile.js: fields, choices and what is missing come from there)
// ============================================================

let _profile = null; // { profile, missing, field_count, choices }
let _pfSavedTimer = null;

async function loadProfile() {
  try {
    _profile = await api('/api/profile');
  } catch (err) {
    return; // the card stays empty; the prompt works without it
  }
  const p = _profile.profile;
  const form = document.getElementById('profile-form');
  if (!form.dataset.bound) {
    form.dataset.bound = '1';
    form.addEventListener('change', onProfileChange);
  }
  form.querySelectorAll('[data-pf]').forEach((el) => { el.value = p[el.dataset.pf] ?? ''; });
  const est = _overview && _overview.spending.recorded_monthly_expense;
  document.getElementById('pf-living').placeholder = est ? `依收支估 ${Math.round(est)}` : '例如 30000';
  form.querySelectorAll('[data-pf-chips]').forEach((box) => {
    const key = box.dataset.pfChips;
    box.innerHTML = _profile.choices[key].map(([v, label]) =>
      `<button type="button" class="chip-btn chip-sm${p[key] === v ? ' active' : ''}" data-v="${v}" onclick="pickProfileChip('${key}', '${v}')">${label}</button>`).join('');
  });
  document.getElementById('pf-big-none').checked = Array.isArray(p.big_expenses) && p.big_expenses.length === 0;
  document.getElementById('pf-big-rows').innerHTML = (p.big_expenses || []).map(bigExpenseRow).join('');
  renderProfileSummary();
  // First visit: open the form; afterwards show the one-line summary
  setProfileOpen(_profile.missing.length === _profile.field_count);
}

function setProfileOpen(open) {
  document.getElementById('profile-form').hidden = !open;
  document.getElementById('profile-summary').hidden = open;
  document.getElementById('profile-head').setAttribute('aria-expanded', String(open));
  document.getElementById('profile-card').classList.toggle('open', open);
}

function toggleProfile() {
  setProfileOpen(document.getElementById('profile-form').hidden);
}

function renderProfileSummary() {
  const { profile: p, missing, field_count: total, choices } = _profile;
  const year = new Date().getFullYear();
  document.getElementById('profile-count').textContent = `已填 ${total - missing.length}/${total}`;
  const choice = (key) => choices[key].find(([v]) => v === p[key])?.[1];
  const bits = [
    p.birth_year && `${year - p.birth_year} 歲`,
    p.income && `月收 ${fmtWan(p.income)}`,
    p.monthly_expense && `生活費 ${fmtWan(p.monthly_expense)}`,
    p.stability && `收入${choice('stability')}`,
    p.goal && choice('goal'),
    p.max_drawdown && `可接受跌 ${p.max_drawdown}%`,
    ...(p.big_expenses || []).map(bigExpenseLabel),
    p.big_expenses && p.big_expenses.length === 0 && '近年無大筆支出',
  ].filter(Boolean);
  document.getElementById('profile-summary').innerHTML =
    (bits.length ? `<div>${bits.join(' · ')}</div>` : '<div class="text-muted">還沒填，AI 會先假設或問你</div>') +
    (bits.length && missing.length ? `<div class="profile-missing">沒填：${missing.join('、')} → AI 會先假設或問你</div>` : '');
  // Hints that react to what was typed
  document.getElementById('pf-age-hint').textContent = p.birth_year ? `今年約 ${year - p.birth_year} 歲` : '用來判斷投資期限';
  const nw = _overview && _overview.net_worth;
  document.getElementById('pf-dd-hint').textContent = p.max_drawdown && nw > 0
    ? `以目前淨資產算，大約是帳面少 ${fmtTWD(nw * p.max_drawdown / 100)} 時，你還能照常投入、不會賣出`
    : '淨資產跌這麼多，你還能照常投入、不會賣出';
}

async function saveProfile(changes) {
  try {
    _profile = await api('/api/profile', { method: 'PUT', body: JSON.stringify(changes) });
    renderProfileSummary();
    // Saved on every change, so a quiet inline note instead of a toast each time
    const el = document.getElementById('profile-saved');
    el.textContent = '已儲存';
    clearTimeout(_pfSavedTimer);
    _pfSavedTimer = setTimeout(() => { el.textContent = ''; }, 1500);
  } catch (err) {
    showToast('儲存失敗: ' + err.message, 'error');
  }
}

function pickProfileChip(key, v) {
  const next = _profile.profile[key] === v ? '' : v; // tap again to clear
  document.querySelectorAll(`[data-pf-chips="${key}"] button`).forEach((b) => b.classList.toggle('active', b.dataset.v === next));
  saveProfile({ [key]: next });
}

function onProfileChange(e) {
  const t = e.target;
  if (t.dataset.pf) saveProfile({ [t.dataset.pf]: t.value.trim() });
  else if (t.closest('.profile-big-row')) saveBigExpenses();
}

// ---- 未來大筆支出: the rows on screen are the source; incomplete ones (no year or amount) aren't saved yet

function bigExpenseRow(e = {}) {
  const year = new Date().getFullYear();
  return `
    <div class="profile-big-row">
      <input type="number" class="input-sm pf-year" data-big="year" min="${year}" max="${year + 50}" placeholder="年份" value="${e.year ?? ''}" aria-label="年份">
      <input type="text" class="input-sm" data-big="what" maxlength="40" placeholder="用途，例如買房" value="${escapeHtml(e.what || '')}" aria-label="用途">
      <label class="settings-input">NT$ <input type="number" class="input-sm pf-amount" data-big="amount" min="0" step="100000" placeholder="金額" value="${e.amount ?? ''}" aria-label="金額"></label>
      <button type="button" class="profile-del" onclick="removeBigExpense(this)" aria-label="刪除" title="刪除">×</button>
    </div>`;
}

function saveBigExpenses() {
  const done = [...document.querySelectorAll('#pf-big-rows .profile-big-row')].map((row) => {
    const v = (k) => row.querySelector(`[data-big="${k}"]`).value.trim();
    return { year: Number(v('year')), what: v('what'), amount: Number(v('amount')) };
  }).filter((e) => e.year && e.amount > 0);
  // Nothing complete and 「沒有」 not ticked: not answered yet
  saveProfile({ big_expenses: done.length || document.getElementById('pf-big-none').checked ? done : null });
}

function addBigExpense() {
  document.getElementById('pf-big-none').checked = false;
  document.getElementById('pf-big-rows').insertAdjacentHTML('beforeend', bigExpenseRow({ year: new Date().getFullYear() + 3 }));
  document.querySelector('#pf-big-rows .profile-big-row:last-child [data-big=what]')?.focus();
}

function removeBigExpense(btn) {
  btn.closest('.profile-big-row').remove();
  saveBigExpenses();
}

function setNoBigExpense(none) {
  if (none) document.getElementById('pf-big-rows').innerHTML = '';
  saveBigExpenses();
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

/** 複製提示詞 plus every AI site button, always all of them (drawn once; the prompt is read on click),
 *  and a status line that stays: a toast is gone by the time the user is back from the AI's tab. */
function renderAISites() {
  const buttons = '<button type="button" class="btn btn-primary btn-sm" data-copy><span class="i" data-icon="copy"></span>複製提示詞</button>' +
    AI_SITES.map(s =>
      `<a class="btn btn-outline btn-sm" data-site="${s.name}" href="${s.url}" target="_blank" rel="noopener noreferrer">${s.name}</a>`).join('') +
    '<p class="ai-status" aria-live="polite"></p>';
  document.querySelectorAll('.ai-actions[data-ai]').forEach(el => { el.innerHTML = buttons; applyIcons(el); });
}

function setAIStatus(block, text, ok = true) {
  const el = block.querySelector('.ai-status');
  el.textContent = text;
  el.classList.toggle('error', !ok);
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
  const q = encodeURIComponent(prompt);
  const prefilled = site && site.prefill && q.length <= AI_LINK_MAX;
  if (site) button.href = prefilled ? `${site.url}?q=${q}` : site.url;
  const time = new Date().toTimeString().slice(0, 5);
  let msg;
  if (!site) msg = `✓ 已複製提示詞（${time}），到 AI 對話框貼上即可`;
  else if (prefilled) msg = `✓ 已開啟 ${site.name} 並帶入提示詞，也複製了一份（${time}）`;
  else msg = `✓ 已開啟 ${site.name} 並複製提示詞（${time}）：${site.prefill ? '提示詞太長帶不進去，' : ''}在對話框貼上即可`;
  navigator.clipboard.writeText(prompt)
    .then(() => setAIStatus(block, msg))
    .catch(() => setAIStatus(block, '複製失敗：請在下面的文字框全選後手動複製', false));
});

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
    ['股票', t => stockHTML(t.symbol)],
    ['買賣', t => `<span class="tag-${t.action === 'BUY' ? 'income' : 'expense'}">${t.action === 'BUY' ? '買進' : '賣出'}</span>`],
    ['股數', t => fmt(t.shares)],
    ['成交價', t => fmtPrice(t.price, t.currency)],
    ['手續費 / 稅', t => `${fmtCur(t.fee, t.currency)} / ${fmtCur(t.tax, t.currency)}`],
    ['損益', t => (t.history ? `<span class="${plClass(t.realized_pl)}">${fmtPLCur(t.realized_pl, t.currency)}</span>` : '<span class="text-muted">自動計算</span>')],
    ['備註', t => escapeHtml(t.note || '') + (t.flags || []).map(f => `<div class="import-flag">${escapeHtml(f)}</div>`).join('')],
  ],
  asset_snapshots: [
    ['日期', s => s.date],
    ['台幣現金', s => fmtTWD(s.cash_twd)],
    ['美金現金', s => fmtUSD(s.cash_usd)],
    ['股票市值（當天）', s => fmtTWD(s.stock_value_twd)],
    ['合計', s => `<strong>${fmtTWD(s.total_asset)}</strong>`],
    ['備註', s => escapeHtml(s.note || '')],
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
  const syms = plan.symbols.map(s => escapeHtml(stockText(s.symbol))).join('、');
  let html = `<div class="replace-box">
    <label class="inline-check"><input type="checkbox" ${on ? 'checked' : ''} onchange="setAIImportMode(this.checked)"> 以對帳單取代這幾檔股票的交易</label>
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
      return `<details class="replace-symbol"><summary><strong>${stockHTML(s.symbol)}</strong>（${s.start} ~ ${s.end}）：刪除 ${s.remove.length} 筆舊交易；
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

    loadLivingCostSetting();
    loadOtherAssets();

    // Font size buttons
    const saved = localStorage.getItem('fontSize') || 'm';
    document.querySelectorAll('.font-btn[onclick^="setFontSize"]').forEach(b => {
      b.classList.toggle('active', b.textContent.trim().toLowerCase().startsWith(saved));
    });
  } catch (err) {
    // Settings may not exist yet
  }
}

// ============================================================
// SECTION: Settings › 生活費 / 其他資產
// ============================================================

async function loadLivingCostSetting() {
  const s = await api('/api/settings');
  document.getElementById('living-cost').value = s.monthly_expense || '';
  const est = _overview && _overview.spending.recorded_monthly_expense; // from the dashboard, if it was opened
  document.getElementById('living-cost').placeholder = est ? `依收支估 ${Math.round(est)}` : '例如 50000';
}

async function saveSetting(key, value) {
  try {
    await api('/api/settings', { method: 'PUT', body: JSON.stringify({ [key]: value === '' ? '' : String(Number(value)) }) });
    showToast('已儲存', 'success');
  } catch (err) {
    showToast('儲存失敗: ' + err.message, 'error');
  }
}

let _otherAssets = [];
async function loadOtherAssets() {
  const [list, settings] = await Promise.all([api('/api/other-assets').catch(() => []), api('/api/settings').catch(() => ({}))]);
  _otherAssets = list;
  const include = settings.include_other_assets !== '0';
  document.getElementById('other-include').checked = include;
  // Each row's own tick only matters while the setting above is on
  document.getElementById('other-list').innerHTML = list.map(a => { const on = a.counted !== 0; return `
    <div class="settings-row">
      <label class="inline-check other-name">
        <input type="checkbox" ${on ? 'checked' : ''} ${include ? '' : 'disabled'} onchange="setOtherCounted(${a.id}, this.checked)" aria-label="${escapeAttr(a.name)} 計入淨資產">
        <span><strong>${escapeHtml(a.name)}</strong><span class="form-hint">${on ? '' : '不計入淨資產 · '}更新於 ${a.updated || '--'}</span></span>
      </label>
      <div class="other-actions">
        <span class="other-value${on && include ? '' : ' text-muted'}">${fmtTWD(a.value)}</span>
        ${rowBtn('edit', `editOtherAsset(${a.id})`)}
        ${rowBtn('delete', `deleteOtherAsset(${a.id})`)}
      </div>
    </div>`; }).join('');
  resetOtherAssetForm();
}

async function saveOtherInclude(on) {
  await saveSetting('include_other_assets', on ? '1' : '0');
  loadOtherAssets();
}

async function setOtherCounted(id, on) {
  try {
    await api(`/api/other-assets/${id}/counted`, { method: 'PUT', body: JSON.stringify({ counted: on }) });
    showToast(on ? '已計入淨資產' : '已改成不計入淨資產', 'success');
    loadOtherAssets();
  } catch (err) {
    showToast('儲存失敗: ' + err.message, 'error');
  }
}

function resetOtherAssetForm() {
  const f = document.getElementById('other-form');
  f.reset();
  f.other_id.value = '';
  f.querySelector('[type=submit]').textContent = '新增';
  document.getElementById('other-cancel').hidden = true;
}

function editOtherAsset(id) {
  const a = _otherAssets.find(x => x.id === id);
  if (!a) return;
  const f = document.getElementById('other-form');
  f.other_id.value = a.id;
  f.other_name.value = a.name;
  f.other_value.value = a.value;
  f.querySelector('[type=submit]').textContent = '更新';
  document.getElementById('other-cancel').hidden = false;
  f.other_value.focus();
}

async function submitOtherAsset(e) {
  e.preventDefault();
  const f = e.target;
  const id = f.other_id.value;
  try {
    await api(id ? `/api/other-assets/${id}` : '/api/other-assets', {
      method: id ? 'PUT' : 'POST',
      body: JSON.stringify({ name: f.other_name.value, value: Number(f.other_value.value) }),
    });
    showToast(id ? '已更新' : '已新增', 'success');
    loadOtherAssets();
  } catch (err) {
    showToast('儲存失敗: ' + err.message, 'error');
  }
}

async function deleteOtherAsset(id) {
  if (!confirm('確定要刪除這筆資產嗎？')) return;
  try {
    await api(`/api/other-assets/${id}`, { method: 'DELETE' });
    loadOtherAssets();
  } catch (err) {
    showToast('刪除失敗: ' + err.message, 'error');
  }
}

/**
 * USD/TWD from the market, saved for every TWD conversion; refreshed in the background at startup
 * (keeps the last rate when offline). Returns { usd_twd_rate, previous } or null.
 */
async function refreshUSDTWDRate() {
  try {
    return await api('/api/settings/refresh-rate', { method: 'POST' });
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
  document.querySelectorAll('.font-btn[onclick^="setFontSize"]').forEach(b => {
    b.classList.toggle('active', b.textContent.trim().toLowerCase() === size);
  });
}

function initFontSize() {
  const saved = localStorage.getItem('fontSize') || 'm';
  setFontSize(saved);
}

/** Up/down colors: 'green-up' (default) or 'red-up' (Taiwan / Asia). Pure CSS: <html data-updown>. */
function setUpDown(mode) {
  if (mode === 'red-up') document.documentElement.dataset.updown = 'red-up';
  else delete document.documentElement.dataset.updown;
  try { localStorage.setItem('upDown', mode); } catch (e) { /* ignore */ }
  document.querySelectorAll('#updown-ctrl .font-btn').forEach(b => b.classList.toggle('active', b.dataset.updown === mode));
}

function initUpDown() {
  let saved = null;
  try { saved = localStorage.getItem('upDown'); } catch (e) { /* ignore */ }
  setUpDown(saved || 'green-up');
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
  initUpDown();
  applyIcons();
  initTapTips();
  applyPrivacyUI();
  initTabs();
  initPerfCards();
  initSegmented();
  initExpenseDefaults();
  renderAISites();

  // Load dashboard data (once the cached stock names are in, so it draws with them)
  loadStockNames().finally(loadDashboard);

  initHoldingsView();

  // Refresh USD/TWD in the background (best-effort, won't block the first paint). Redraw the
  // dashboard only when the rate moved enough to show (≥ 0.1%), not on every start.
  refreshUSDTWDRate().then(r => {
    const moved = r && r.previous > 0 && Math.abs(r.usd_twd_rate / r.previous - 1) >= 0.001;
    if (moved && document.querySelector('#tab-dashboard.active')) loadDashboard();
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
          <td>${stockHTML(h.symbol)}</td>
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
          <td>${stockHTML(t.symbol)}</td>
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
