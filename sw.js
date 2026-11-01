// Service worker：快取網站本身的檔案，讓「加到主畫面」與離線開啟可用。
// Google 的 API、登入、Yahoo 代理一律不經快取。
// 採「網路優先」，一般部署會自動拿到新版；SHELL 清單有增減時請把 VERSION 加一。

const VERSION = 'v2'; // 網站版本見 js/version.js
const CACHE = `finance-watcher-${VERSION}`;
const SHELL = [
  './',
  'index.html',
  'css/style.css',
  'js/app.js',
  'js/main.js',
  'js/config.js',
  'js/version.js',
  'js/cloud/auth.js',
  'js/cloud/sheets.js',
  'js/cloud/sync.js',
  'js/server/assets.js',
  'js/server/datacheck.js',
  'js/server/db.js',
  'js/server/dividends.js',
  'js/server/expenses.js',
  'js/server/export.js',
  'js/server/ledger.js',
  'js/server/llm.js',
  'js/server/managed.js',
  'js/server/market.js',
  'js/server/performance.js',
  'js/server/reports.js',
  'js/server/router.js',
  'js/server/settings.js',
  'js/server/stocks.js',
  'js/server/twr.js',
  'js/server/twr_calc.js',
  'js/server/util.js',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/apple-touch-icon.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
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
