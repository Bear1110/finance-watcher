// 新手導覽：聚光燈框住畫面上的一塊，旁邊的說明卡有「上一步／下一步」。
// 第一次開啟網站自動跑一次（localStorage 'tourSeen'），之後可從設定頁的「使用導覽」重新開始。
// 每一步可指定要切到哪個分頁（tab / subtab）與要框住的元素（target = index.html 裡的 data-tour 值）；
// 找不到元素或元素沒顯示時，說明卡改放畫面中央。

const TOUR_STEPS = [
  {
    title: '歡迎使用 Finance Watcher',
    body: '這裡記錄你的資產、股票和收支。用導覽列切換<b>總覽</b>、<b>股票</b>、<b>收支</b>、<b>設定</b>（手機在畫面最下方）。<br>資料先存在這台裝置；右上角的雲朵可以登入 Google，同步到你自己雲端硬碟的試算表。',
  },
  {
    tab: 'dashboard',
    target: 'net-worth',
    title: '淨資產',
    body: '淨資產 = 現金（最新快照加計之後的股票買賣與股利）+ 即時股票市值（+ 其他資產，可在設定選擇是否計入）。<br>下面是今年的變化與資產組成；往下是淨資產走勢與每月快照、投資績效、本月收支。最上方出現黃色提醒時，代表有事值得處理。',
  },
  {
    tab: 'dashboard',
    target: 'snapshots',
    title: '資產快照（建議第一步）',
    body: '每個月記一次快照：只要填銀行和券商裡的台幣、美金現金，股票市值會自動帶入；之後的股票買賣與股利會自動推算進現金。<br>像集點卡一樣，每個月一格：打勾的是記過了，空的點一下就能補記。',
  },
  {
    tab: 'stocks', subtab: 'holdings',
    target: 'holdings-actions',
    title: '股票：先匯入持倉',
    body: '用「匯入持倉」把現在手上的股票（代號、股數、均價）建好就能開始，不用補登過去的交易。<br>之後的買賣用每一列的 ＋／－ 記錄。',
  },
  {
    tab: 'stocks', subtab: 'holdings',
    target: 'stock-subtabs',
    title: '股票的其他分頁',
    body: '<b>績效</b>：報酬率、市值走勢、月報酬、和大盤比較<br><b>組合分析</b>：持股集中度、美元資產佔比、股利現金流<br><b>已實現損益</b>、<b>交易紀錄</b>、<b>股利</b>（可從 Yahoo 查除息紀錄，勾一勾就記好）',
  },
  {
    tab: 'expenses',
    target: 'add-expense',
    title: '收支',
    body: '右下角的 ＋ 記一筆收入或支出（總覽也有「記一筆」）。已經在別的 App 記帳？用「AI 匯入」把截圖或報表整理後一次匯入。',
  },
  {
    tab: 'settings',
    target: 'cloud',
    title: '設定：同步與備份',
    body: '登入後會在你的雲端硬碟建立「Finance Watcher 財務紀錄」試算表，網站只能存取這份檔案。沒登入時資料只在這個瀏覽器，記得偶爾到下方「備份與還原」下載備份。',
  },
  {
    tab: 'dashboard',
    title: '開始吧',
    body: '建議順序：<br>1. 股票 › 匯入持倉<br>2. 總覽 › 新增一筆資產快照<br>3. 登入 Google 開始同步<br><br>想再看一次，到設定頁按「使用導覽」。',
  },
];

const tour = { i: -1, el: null, els: null, raf: 0, ro: null };

function startTour() {
  endTour();
  const shade = document.createElement('div');
  shade.className = 'tour-shade';
  const spot = document.createElement('div');
  spot.className = 'tour-spot';
  const card = document.createElement('div');
  card.className = 'tour-card';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-live', 'polite');
  card.innerHTML = `
    <div class="tour-step"></div>
    <h3 class="tour-title"></h3>
    <div class="tour-body"></div>
    <div class="tour-actions">
      <button type="button" class="btn btn-sm tour-skip">略過</button>
      <button type="button" class="btn btn-outline btn-sm tour-prev">上一步</button>
      <button type="button" class="btn btn-primary btn-sm tour-next">下一步</button>
    </div>`;
  const q = (sel) => card.querySelector(sel);
  tour.els = { shade, spot, card, step: q('.tour-step'), title: q('.tour-title'), body: q('.tour-body'), prev: q('.tour-prev'), next: q('.tour-next') };
  q('.tour-skip').onclick = endTour;
  tour.els.prev.onclick = () => showTourStep(tour.i - 1);
  tour.els.next.onclick = () => showTourStep(tour.i + 1);
  shade.onclick = (e) => e.stopPropagation(); // the page underneath stays inert
  document.body.append(shade, spot, card);
  // Tabs load their data asynchronously; re-place whenever the layout shifts.
  tour.ro = new ResizeObserver(placeTour);
  document.addEventListener('keydown', onTourKey);
  addEventListener('resize', placeTour);
  addEventListener('scroll', placeTour, { passive: true, capture: true });
  try { localStorage.setItem('tourSeen', '1'); } catch (e) { /* ignore */ }
  showTourStep(0);
}

function endTour() {
  if (!tour.els) return;
  const { shade, spot, card } = tour.els;
  [shade, spot, card].forEach(el => el.remove());
  tour.ro.disconnect();
  cancelAnimationFrame(tour.raf);
  Object.assign(tour, { i: -1, el: null, els: null, ro: null });
  document.removeEventListener('keydown', onTourKey);
  removeEventListener('resize', placeTour);
  removeEventListener('scroll', placeTour, { capture: true });
}

function onTourKey(e) {
  if (e.key === 'Escape') endTour();
  else if (e.key === 'ArrowRight' || e.key === 'Enter') { e.preventDefault(); showTourStep(tour.i + 1); }
  else if (e.key === 'ArrowLeft') showTourStep(tour.i - 1);
}

/** The step's element, or null when it is missing or not displayed (e.g. on another tab). */
function tourTarget(step) {
  const el = step.target && document.querySelector(`[data-tour="${step.target}"]`);
  const r = el?.getBoundingClientRect();
  return r?.width && r.height ? el : null;
}

function showTourStep(i) {
  if (!tour.els) return;
  if (i >= TOUR_STEPS.length) return endTour();
  if (i < 0) return;
  tour.i = i;
  const step = TOUR_STEPS[i];
  if (step.tab && step.tab !== (document.body.dataset.tab || 'dashboard')) goToTab(step.tab, step.subtab);
  else if (step.subtab) document.querySelector(`.sub-tab-btn[data-subtab="${step.subtab}"]:not(.active)`)?.click();

  const { els } = tour;
  els.step.textContent = `${i + 1} / ${TOUR_STEPS.length}`;
  els.title.textContent = step.title;
  els.body.innerHTML = step.body;
  els.prev.style.visibility = i ? '' : 'hidden';
  els.next.textContent = i === TOUR_STEPS.length - 1 ? '完成' : '下一步';

  tour.el = tourTarget(step);
  tour.ro.disconnect();
  tour.ro.observe(document.body);
  if (tour.el) tour.ro.observe(tour.el);
  // Fixed elements (nav, FAB) don't need scrolling; everything else is centred first.
  if (tour.el && getComputedStyle(tour.el).position !== 'fixed') tour.el.scrollIntoView({ block: 'center', behavior: 'instant' });
  placeTour();
  els.next.focus({ preventScroll: true });
}

function placeTour() {
  cancelAnimationFrame(tour.raf);
  tour.raf = requestAnimationFrame(() => {
    const { spot, card } = tour.els;
    const pad = 6;
    card.style.width = Math.min(340, innerWidth - 32) + 'px';
    const r = tour.el?.getBoundingClientRect();
    // No target: a zero-size hole in the middle, so only the dimmed backdrop shows.
    const hole = r
      ? { left: r.left - pad, top: r.top - pad, width: r.width + pad * 2, height: r.height + pad * 2 }
      : { left: innerWidth / 2, top: innerHeight / 2, width: 0, height: 0 };
    spot.classList.toggle('tour-spot-none', !r);
    for (const k in hole) spot.style[k] = hole[k] + 'px';
    placeNear(card, { ...hole, bottom: hole.top + hole.height }, r ? 12 : -card.offsetHeight / 2, 16);
  });
}

// First visit; registered after app.js's own DOMContentLoaded init, so the tabs are set up.
document.addEventListener('DOMContentLoaded', () => {
  let seen = true;
  try { seen = localStorage.getItem('tourSeen') === '1'; } catch (e) { /* ignore */ }
  if (!seen && !('loadFailed' in document.body.dataset)) startTour(); // not over app.js's showLoadFailure screen
});
