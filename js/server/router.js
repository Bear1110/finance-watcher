// In-browser API router: app.js calls api('/api/...'), and handle()
// dispatches to the registered handler instead of the network.

import { HttpError } from './util.js';
import { MarketUnavailableError } from './market.js';

const routes = [];

/**
 * Register a handler. pattern looks like '/api/assets/{id}'.
 * fn(req) gets { params, query: URLSearchParams, body, method } and returns
 * the JSON response (or throws HttpError).
 */
export function route(method, pattern, fn) {
  const names = [];
  const re = new RegExp('^' + pattern.replace(/\{(\w+)\}/g, (_, n) => { names.push(n); return '([^/]+)'; }) + '$');
  routes.push({ method, re, names, fn });
}

export async function handle(url, options = {}) {
  const method = (options.method || 'GET').toUpperCase();
  const u = new URL(url, 'http://local');
  for (const r of routes) {
    if (r.method !== method) continue;
    const m = u.pathname.match(r.re);
    if (!m) continue;
    const params = {};
    r.names.forEach((n, i) => { params[n] = decodeURIComponent(m[i + 1]); });
    try {
      return await r.fn({ method, params, query: u.searchParams, body: options.body });
    } catch (e) {
      if (e instanceof HttpError) throw e;
      // No market source configured: a setup problem, not a handler crash.
      if (e instanceof MarketUnavailableError) throw new HttpError(503, e.message);
      console.error('handler error', method, url, e);
      throw new HttpError(500, e.message || String(e));
    }
  }
  throw new HttpError(404, `404 page not found: ${method} ${u.pathname}`);
}
