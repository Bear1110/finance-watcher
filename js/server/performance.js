// Money-weighted return (XIRR),
// GET /api/stocks/xirr.

import * as db from './db.js';
import { route } from './router.js';
import { storedUSDTWDRate, toTWD, goRound } from './util.js';
import { portfolioValues } from './stocks.js';
import { queryDividends } from './dividends.js';
import { loadPerfTxns } from './twr.js';
import { isDateOnly } from './twr_calc.js';

const DAY_MS = 86400000;
const utcMs = (s) => Date.parse(s + 'T00:00:00Z');

/**
 * Solves sum(cf / (1+r)^(days/365)) = 0 by bisection. flows: [{ t (ms), amt }].
 * Returns null when the flows have no sign change or no root in (-99%, +10000%).
 */
export function xirr(flows, d0) {
  if (flows.length < 2) return null;
  const npv = (r) => {
    let s = 0;
    for (const f of flows) s += f.amt / Math.pow(1 + r, (f.t - d0) / DAY_MS / 365);
    return s;
  };
  let lo = -0.99;
  let hi = 100.0;
  let flo = npv(lo);
  const fhi = npv(hi);
  if (Number.isNaN(flo) || Number.isNaN(fhi) || flo * fhi > 0) return null;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    const fm = npv(mid);
    if (flo * fm <= 0) {
      hi = mid;
    } else {
      lo = mid;
      flo = fm;
    }
  }
  return (lo + hi) / 2;
}

/**
 * GET /api/stocks/xirr → {"ALL": {...}, "TW": {...}, "US": {...}}
 * BUYs are outflows, SELLs and dividends inflows, current market value is the
 * terminal inflow (imported-history SELLs included, see loadPerfTxns).
 * Foreign amounts use today's rate, so it is an approximation.
 */
async function xirrHandler() {
  const rate = storedUSDTWDRate();
  const sets = { ALL: { flows: [], first: 0 }, TW: { flows: [], first: 0 }, US: { flows: [], first: 0 } };
  const addTo = (s, t, amt) => {
    if (s.flows.length === 0 || t < s.first) s.first = t;
    s.flows.push({ t, amt });
  };
  const add = (market, t, amt) => {
    addTo(sets.ALL, t, amt);
    if (sets[market]) addTo(sets[market], t, amt);
  };

  for (const t of loadPerfTxns()) {
    if (!isDateOnly(t.date)) continue;
    const d = utcMs(t.date);
    if (t.action === 'BUY') add(t.market, d, -toTWD(t.shares * t.price + t.fee, t.currency, rate));
    else add(t.market, d, toTWD(t.shares * t.price - t.fee - t.tax, t.currency, rate));
  }
  for (const d of queryDividends()) {
    if (isDateOnly(d.date)) add(d.market, utcMs(d.date), toTWD(d.amount, d.currency, rate));
  }

  const [tw, us, total] = await portfolioValues();
  const today = utcMs(db.today());
  const resp = {};
  for (const [market, terminal] of [['ALL', total], ['TW', tw], ['US', us]]) {
    const s = sets[market];
    addTo(s, today, terminal);
    const out = {
      flows: s.flows.length,
      market_value: goRound(terminal),
      span_days: Math.trunc((today - s.first) / DAY_MS),
      first_date: new Date(s.first).toISOString().slice(0, 10),
      xirr: null,
    };
    const v = xirr(s.flows, s.first);
    if (v !== null) out.xirr = goRound(v * 10000) / 100; // percent, 2 decimals
    resp[market] = out;
  }
  return resp;
}

route('GET', '/api/stocks/xirr', xirrHandler);
