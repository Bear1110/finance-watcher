// Service worker：快取網站本身的檔案，讓「加到主畫面」與離線開啟可用。
// Google 的 API、登入、Yahoo 代理一律不經快取。
// 採「網路優先」，一般部署會自動拿到新版；SHELL 清單有增減時請把 VERSION 加一。

const VERSION = 'v11'; // 網站版本見 js/version.js
const CACHE = `finance-watcher-${VERSION}`;
const SHELL = [
  './',
  'index.html',
  'css/style.css',
  'js/app.js',
  'js/tour.js',
  'js/main.js',
  'js/config.js',
  'js/version.js',
  'js/update.js',
  'js/cloud/auth.js',
  'js/cloud/sheets.js',
  'js/cloud/sync.js',
  'js/server/aiimport.js',
  'js/server/assets.js',
  'js/server/datacheck.js',
  'js/server/db.js',
  'js/server/dividends.js',
  'js/server/expenses.js',
  'js/server/ledger.js',
  'js/server/llm.js',
  'js/server/lookthrough.js',
  'js/server/lots.js',
  'js/server/managed.js',
  'js/server/names.js',
  'js/server/market.js',
  'js/server/other_assets.js',
  'js/server/overview.js',
  'js/server/performance.js',
  'js/server/profile.js',
  'js/server/portfolio.js',
  'js/server/router.js',
  'js/server/settings.js',
  'js/server/stocks.js',
  'js/server/twr.js',
  'js/server/twr_calc.js',
  'js/server/util.js',
  'js/server/amount.js',
  'manifest.webmanifest',
  // 只放頁面上會顯示的圖示；安裝用的 192／512／maskable／apple-touch 由瀏覽器自己抓
  'icons/favicon-32.png',
  'icons/logo-64.png',
];

self.addEventListener('install', (event) => {
  // 安裝時略過 HTTP 快取（cache: 'reload'），避免把舊檔存進新版本的快取
  const fresh = SHELL.map((u) => new Request(u, { cache: 'reload' }));
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(fresh)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// 同源檔案：先用網路（拿到最新版並更新快取），失敗才用快取。
// 頁面與程式檔一律向伺服器確認（no-cache：沒變只回 304），避免新舊檔案混用。
const MUST_MATCH = /(?:\/|\.html|\.js|\.css)$/;
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  let request = event.request;
  if (MUST_MATCH.test(url.pathname)) {
    request = request.mode === 'navigate' ? new Request(url, { cache: 'no-cache' }) : new Request(request, { cache: 'no-cache' });
  }
  event.respondWith(
    fetch(request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(event.request, copy));
        return res;
      })
      .catch(() => caches.match(event.request, { ignoreSearch: true })),
  );
});
