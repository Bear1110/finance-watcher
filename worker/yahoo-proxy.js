// Cloudflare Worker：把 Yahoo Finance API 轉送給瀏覽器（Yahoo 本身沒有 CORS）。
//
// 只轉送公開行情（股票代號、日期範圍），不經手任何使用者的金額或紀錄。
// 部署：Cloudflare 後台 → Workers → 建立 → 貼上這個檔案 → 部署，
// 把 https://<名稱>.<帳號>.workers.dev 填進 js/config.js 的 DEFAULT_YAHOO_PROXY。
//
// 請求格式：
//   GET https://<worker>/v8/finance/chart/2330.TW?interval=1d&range=1d
//   GET https://<worker>/v10/finance/quoteSummary/0050.TW?modules=topHoldings,quoteType
//     （ETF 前十大成分股；Yahoo 這支要 cookie + crumb，由 Worker 代為取得）
//   GET https://<worker>/tw-names?codes=2330,0050,00679B
//     （台股中文名稱，來自證交所的公開資料（上市清單＋ISIN 查詢）；回傳 { "2330": "台積電", ... }）

// 允許的網站來源；自己的 GitHub Pages 網域與本機開發。
const ALLOWED_ORIGINS = [
  'https://bear1110.github.io',
  'http://localhost:8000',
  'http://127.0.0.1:8000',
];
const ALLOWED_PARAMS = new Set(['interval', 'range', 'period1', 'period2', 'events']);
const ALLOWED_MODULES = new Set(['topHoldings', 'quoteType']);
const SYMBOL_RE = /^[A-Za-z0-9.^=\-]{1,20}$/;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
const SUMMARY_TTL = 12 * 3600; // 成分股一天變不了多少

// ---- 台股中文名稱：上市用證交所每日收盤清單（整份整理成 { 代號: 名稱 } 快取一天）；
// 清單裡沒有的（上櫃、興櫃）逐一查證交所 ISIN 單筆頁（Big5），每個代號各快取一天。
// 櫃買中心的 openapi 會擋 Cloudflare 的連線，所以不用它。
const TWSE_LIST = 'https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL';
const ISIN_SINGLE = 'https://isin.twse.com.tw/isin/single_main.jsp?owncode=';
const TW_NAMES_TTL = 24 * 3600;
const TW_CODE_RE = /^[0-9A-Z]{4,6}$/;
const MAX_SINGLE = 20; // 一次最多逐一查幾檔

function cacheJSON(ctx, key, data) {
  ctx.waitUntil(caches.default.put(key, new Response(JSON.stringify(data), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${TW_NAMES_TTL}` },
  })));
}

async function cachedJSON(key) {
  const hit = await caches.default.match(key);
  return hit ? hit.json() : undefined;
}

async function listedNames(ctx) {
  const key = 'https://tw-names.cache/twse-v1';
  const hit = await cachedJSON(key);
  if (hit) return hit;
  const names = {};
  try {
    const r = await fetch(TWSE_LIST, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
    if (r.ok) {
      for (const row of await r.json()) {
        const code = String(row.Code || '').trim();
        const name = String(row.Name || '').trim();
        if (TW_CODE_RE.test(code) && name) names[code] = name;
      }
    }
  } catch (e) { console.log('tw-names list', e.message); }
  if (Object.keys(names).length) cacheJSON(ctx, key, names);
  return names;
}

/** One code from the ISIN page ('' when not found; cached either way so a typo isn't asked again all day). */
async function singleName(code, ctx) {
  const key = `https://tw-names.cache/isin-v1/${code}`;
  const hit = await cachedJSON(key);
  if (hit !== undefined) return hit.name;
  try {
    const r = await fetch(ISIN_SINGLE + encodeURIComponent(code), { headers: { 'User-Agent': UA } });
    if (!r.ok) return '';
    const html = new TextDecoder('big5').decode(await r.arrayBuffer());
    const m = html.match(new RegExp(`<td[^>]*>${code}</td>\\s*<td[^>]*>([^<]+)</td>`));
    const name = m ? m[1].trim() : '';
    cacheJSON(ctx, key, { name });
    return name;
  } catch (e) {
    console.log('tw-names isin', code, e.message);
    return '';
  }
}

async function twNames(codes, ctx) {
  const listed = await listedNames(ctx);
  const out = {};
  const rest = [];
  for (const c of codes) if (listed[c]) out[c] = listed[c]; else rest.push(c);
  await Promise.all(rest.slice(0, MAX_SINGLE).map(async (c) => {
    const name = await singleName(c, ctx);
    if (name) out[c] = name;
  }));
  return out;
}

async function twNamesResponse(url, origin, ctx) {
  const codes = (url.searchParams.get('codes') || '').toUpperCase().split(',').filter((c) => TW_CODE_RE.test(c)).slice(0, 300);
  if (!codes.length) return new Response('bad request', { status: 400, headers: cors(origin) });
  const out = await twNames(codes, ctx);
  return new Response(JSON.stringify(out), {
    headers: { ...cors(origin), 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=3600' },
  });
}

function cors(origin) {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

// ---- quoteSummary 需要的 cookie + crumb（同一個 Worker 實例內重用；同時進來的請求共用一次取得）
let sessionP = null; // Promise<{ cookie, crumb }>

async function newSession() {
  const r = await fetch('https://fc.yahoo.com/', { headers: { 'User-Agent': UA }, redirect: 'manual' });
  const raw = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : [r.headers.get('Set-Cookie') || ''];
  const cookie = raw.map((c) => c.split(';')[0]).filter(Boolean).join('; ');
  if (!cookie) throw new Error('no yahoo cookie');
  const c = await fetch('https://query2.finance.yahoo.com/v1/test/getcrumb', { headers: { 'User-Agent': UA, Cookie: cookie } });
  const crumb = (await c.text()).trim();
  if (!c.ok || !crumb || crumb.includes('<')) throw new Error(`no yahoo crumb (${c.status})`);
  return { cookie, crumb };
}

function getSession() {
  sessionP ??= newSession().catch((e) => { sessionP = null; throw e; });
  return sessionP;
}

async function fetchSummary(upstream) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const s = await getSession();
    const u = new URL(upstream);
    u.searchParams.set('crumb', s.crumb);
    const r = await fetch(u, { headers: { 'User-Agent': UA, Cookie: s.cookie } });
    if (r.status !== 401 && r.status !== 403) return r;
    sessionP = null; // crumb 過期：重拿一次
  }
  return new Response('yahoo auth failed', { status: 502 });
}

/** Maps a request path to { upstream, ttl, summary } or null. */
function route(url) {
  let m = url.pathname.match(/^\/v8\/finance\/chart\/([^/]+)$/);
  if (m) {
    const symbol = decodeURIComponent(m[1]);
    if (!SYMBOL_RE.test(symbol)) return null;
    const upstream = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`);
    for (const [k, v] of url.searchParams) if (ALLOWED_PARAMS.has(k)) upstream.searchParams.set(k, v);
    return { upstream, ttl: upstream.searchParams.get('range') === '1d' ? 60 : 1800, summary: false };
  }
  m = url.pathname.match(/^\/v10\/finance\/quoteSummary\/([^/]+)$/);
  if (m) {
    const symbol = decodeURIComponent(m[1]);
    const modules = (url.searchParams.get('modules') || '').split(',').filter((x) => ALLOWED_MODULES.has(x));
    if (!SYMBOL_RE.test(symbol) || !modules.length) return null;
    const upstream = new URL(`https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}`);
    upstream.searchParams.set('modules', modules.sort().join(','));
    return { upstream, ttl: SUMMARY_TTL, summary: true };
  }
  return null;
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors(origin) });
    if (request.method !== 'GET') return new Response('method not allowed', { status: 405, headers: cors(origin) });
    if (origin && !ALLOWED_ORIGINS.includes(origin)) return new Response('forbidden', { status: 403 });

    const url = new URL(request.url);
    if (url.pathname === '/tw-names') return twNamesResponse(url, origin, ctx);

    const r = route(url);
    if (!r) return new Response('bad request', { status: 400, headers: cors(origin) });

    // 同一個網址短暫快取，減少打到 Yahoo 的次數（快取鍵不含 crumb）
    const cache = caches.default;
    const cacheKey = new Request(r.upstream.toString());
    let resp = await cache.match(cacheKey);
    if (!resp) {
      try {
        resp = r.summary ? await fetchSummary(r.upstream) : await fetch(r.upstream, { headers: { 'User-Agent': UA } });
      } catch (e) {
        resp = new Response(`upstream error: ${e.message}`, { status: 502 });
      }
      if (resp.ok) {
        resp = new Response(resp.body, resp);
        resp.headers.delete('Set-Cookie');
        resp.headers.set('Cache-Control', `public, max-age=${r.ttl}`);
        ctx.waitUntil(cache.put(cacheKey, resp.clone()));
      }
    }
    const out = new Response(resp.body, resp);
    for (const [k, v] of Object.entries(cors(origin))) out.headers.set(k, v);
    return out;
  },
};
