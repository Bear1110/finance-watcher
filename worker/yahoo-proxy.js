// Cloudflare Worker：把 Yahoo Finance chart API 轉送給瀏覽器（Yahoo 本身沒有 CORS）。
//
// 只轉送公開行情（股票代號、日期範圍），不經手任何使用者的金額或紀錄。
// 部署：Cloudflare 後台 → Workers → 建立 → 貼上這個檔案 → 部署，
// 把 https://<名稱>.<帳號>.workers.dev 填進 js/config.js 的 DEFAULT_YAHOO_PROXY。
//
// 請求格式：GET https://<worker>/v8/finance/chart/2330.TW?interval=1d&range=1d

// 允許的網站來源；自己的 GitHub Pages 網域與本機開發。
const ALLOWED_ORIGINS = [
  'https://bear1110.github.io',
  'http://localhost:8000',
  'http://127.0.0.1:8000',
];
const ALLOWED_PARAMS = new Set(['interval', 'range', 'period1', 'period2', 'events']);
const SYMBOL_RE = /^[A-Za-z0-9.^=\-]{1,20}$/;

function cors(origin) {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors(origin) });
    if (request.method !== 'GET') return new Response('method not allowed', { status: 405, headers: cors(origin) });
    if (origin && !ALLOWED_ORIGINS.includes(origin)) return new Response('forbidden', { status: 403 });

    const url = new URL(request.url);
    const m = url.pathname.match(/^\/v8\/finance\/chart\/([^/]+)$/);
    const symbol = m ? decodeURIComponent(m[1]) : '';
    if (!SYMBOL_RE.test(symbol)) return new Response('bad symbol', { status: 400, headers: cors(origin) });

    const upstream = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`);
    for (const [k, v] of url.searchParams) if (ALLOWED_PARAMS.has(k)) upstream.searchParams.set(k, v);

    // 同一個網址短暫快取，減少打到 Yahoo 的次數
    const cache = caches.default;
    const cacheKey = new Request(upstream.toString());
    let resp = await cache.match(cacheKey);
    if (!resp) {
      resp = await fetch(upstream, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' } });
      if (resp.ok) {
        const ttl = upstream.searchParams.get('range') === '1d' ? 60 : 1800;
        resp = new Response(resp.body, resp);
        resp.headers.set('Cache-Control', `public, max-age=${ttl}`);
        ctx.waitUntil(cache.put(cacheKey, resp.clone()));
      }
    }
    const out = new Response(resp.body, resp);
    for (const [k, v] of Object.entries(cors(origin))) out.headers.set(k, v);
    return out;
  },
};
