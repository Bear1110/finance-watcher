// Pure time-weighted-return math. No DB, no
// network, so it can be tested with hand-made prices. twr.js loads the inputs
// and serves the result.
//
// Days are 'YYYY-MM-DD' strings; day arithmetic is done in UTC so results do
// not shift with the browser's timezone.

import { USDTWD_SYMBOL } from './market.js';
import { goRound, round2, round4, toTWD } from './util.js';
import { lotFromBuy, takeLots, lotsTotal, estSellCost } from './lots.js';


// perfTxn: { symbol, market, action, currency, date, shares, price, fee, tax, transfer, realized_pl? }
// transfer: a 匯入持倉 BUY whose price is the average cost and whose date may be
// a placeholder; it enters at that day's market value instead, so there is no
// fake gain or loss on the import day.
//
// perfDiv: { market, currency, date, amount }  (date: ex-date when known, else pay date)
//
// perfInput: { txns (sorted by date), divs, closes: {symbol: [{date, close, adj_close}]}
//              (plus USDTWD_SYMBOL), live: {symbol: price}, liveRate, today }

export const perfSegments = ['ALL', 'TW', 'US'];

/** Add n days to a 'YYYY-MM-DD' date (UTC arithmetic). */
export const addDays = (date, n) => addDate(date, 0, 0, n);

/** Add years/months/days to a date string; overflow normalizes like Date (UTC). */
export function addDate(date, years, months, days) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y + years, m - 1 + months, d + days)).toISOString().slice(0, 10);
}

export const isDateOnly = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s)
  && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;

const weekday = (date) => new Date(date + 'T00:00:00Z').getUTCDay();

// priceCursor forward-fills a close series as days advance.
class PriceCursor {
  constructor(series) {
    this.series = series || [];
    this.i = 0;
    this.px = 0;
  }

  // advance moves to day d and reports whether any close on or before d exists.
  advance(d) {
    while (this.i < this.series.length && this.series[this.i].date <= d) {
      this.px = this.series[this.i].close;
      this.i++;
    }
    return this.i > 0;
  }
}

/**
 * Replays trades day by day from the first trade to today. A day with trades is
 * split at the trades into two sub-periods:
 *
 *   r1 = V_trade / V_prev_close   (traded symbols at their trade price)
 *   r2 = (V_close + sells + dividends) / (V_trade + buys)
 *
 * and the day's growth is (1+r1)(1+r2). Chaining days removes the effect of
 * when money went in, so realized, unrealized, dividends, fees and FX all land
 * in one number. P&L = V_end − V_start − buys + sells + dividends.
 *
 * Alongside, the ledger's FIFO lots (lots.js) give per day the cost of what is
 * held, so unrealized = value − cost, and the cumulative realized P&L: each
 * SELL's stored realized_pl when given (the ledger's number, so the 已實現損益
 * page and this agree), else proceeds − lot cost. USD cost is converted at that
 * day's rate (like the holdings page), so unrealized excludes FX moves;
 * realized is converted at the sale day's rate. `unrealized` = value − cost − what selling everything
 * held would cost that day (台股 fee + tax at input.twFeeDiscount), like the holdings page.
 */
export function computePerformance(input) {
  const txns = input.txns || [];
  const divs = input.divs || [];
  const closes = input.closes || {};
  const live = input.live || {};
  const liveRate = input.liveRate || 0;
  const today = input.today;
  const discount = input.twFeeDiscount;

  const res = new PerfResult();
  for (const s of perfSegments) {
    res.series[s] = { value: [0], growth: [1], pnl: [0], active: [0], cost: [0], unrealized: [0], realized: [0] };
  }
  if (txns.length === 0) return res;
  const first = txns[0].date;
  if (!isDateOnly(first)) return res;
  res.days = [addDays(first, -1)];
  res.fx = [liveRate];

  const symMarket = {};
  const symCur = {};
  const txByDate = {};
  for (const t of txns) {
    symMarket[t.symbol] = t.market;
    symCur[t.symbol] = t.currency;
    (txByDate[t.date] ||= []).push(t);
  }
  const divByDate = {};
  for (const d of divs) (divByDate[d.date] ||= []).push(d);
  const cursors = {};
  for (const sym of Object.keys(symMarket)) {
    cursors[sym] = new PriceCursor(closes[sym]);
    if (!closes[sym] || closes[sym].length === 0) res.missing.push(sym);
  }
  const fxCur = new PriceCursor(closes[USDTWD_SYMBOL]);

  const shares = {};
  const lots = {}; // symbol -> FIFO lots (lots.js), native currency
  const realized = { ALL: 0, TW: 0, US: 0 }; // cumulative, TWD
  const px = {}; // last known price per symbol, native currency
  for (let d = first; d <= today; d = addDays(d, 1)) {
    let fx = liveRate;
    if (fxCur.advance(d)) fx = fxCur.px;
    for (const [sym, c] of Object.entries(cursors)) {
      if (c.advance(d)) px[sym] = c.px;
    }
    if (d === today) {
      fx = liveRate;
      for (const [sym, p] of Object.entries(live)) {
        if (p > 0) px[sym] = p;
      }
    }
    const valueAt = (price) => {
      const v = { ALL: 0, TW: 0, US: 0 };
      for (const [sym, s] of Object.entries(shares)) {
        if (s > 1e-9) {
          const x = toTWD(s * price(sym), symCur[sym], fx);
          v.ALL += x;
          v[symMarket[sym]] = (v[symMarket[sym]] || 0) + x;
        }
      }
      return v;
    };

    // Value just before today's trades: holdings so far, each traded symbol at
    // its volume-weighted trade price, the rest at today's close.
    const trades = txByDate[d] || [];
    const tradePx = new Array(trades.length);
    const tradeAmt = {};
    const tradeQty = {};
    trades.forEach((t, i) => {
      if (cursors[t.symbol].i === 0 && !px[t.symbol]) {
        px[t.symbol] = t.price; // no daily close yet: use the trade price
      }
      tradePx[i] = t.price;
      if (t.transfer) tradePx[i] = px[t.symbol] || 0;
      tradeAmt[t.symbol] = (tradeAmt[t.symbol] || 0) + t.shares * tradePx[i];
      tradeQty[t.symbol] = (tradeQty[t.symbol] || 0) + t.shares;
    });
    const atTrade = valueAt((sym) => {
      const q = tradeQty[sym];
      if (q > 0) return tradeAmt[sym] / q;
      return px[sym] || 0;
    });

    const inflow = { ALL: 0, TW: 0, US: 0 };
    const outflow = { ALL: 0, TW: 0, US: 0 };
    const addFlow = (m, market, v) => {
      m.ALL += v;
      m[market] = (m[market] || 0) + v;
    };
    trades.forEach((t, i) => {
      const fifo = (lots[t.symbol] ||= []);
      if (t.action === 'BUY') {
        shares[t.symbol] = (shares[t.symbol] || 0) + t.shares;
        addFlow(inflow, t.market, toTWD(t.shares * tradePx[i] + t.fee, t.currency, fx));
        // A 匯入持倉's price is its average cost (the TWR uses the market price instead)
        if (t.shares > 0) fifo.push(lotFromBuy(t));
      } else {
        shares[t.symbol] = (shares[t.symbol] || 0) - t.shares;
        const proceeds = t.shares * t.price - t.fee - t.tax;
        addFlow(outflow, t.market, toTWD(proceeds, t.currency, fx));
        const { cost } = takeLots(fifo, t.shares);
        const pl = typeof t.realized_pl === 'number' ? t.realized_pl : proceeds - cost;
        addFlow(realized, t.market, toTWD(pl, t.currency, fx));
      }
    });
    for (const dv of divByDate[d] || []) {
      addFlow(outflow, dv.market, toTWD(dv.amount, dv.currency, fx));
    }
    const value = valueAt((sym) => px[sym] || 0);
    const held = { ALL: 0, TW: 0, US: 0 };
    const sell = { ALL: 0, TW: 0, US: 0 };
    for (const [sym, fifo] of Object.entries(lots)) {
      addFlow(held, symMarket[sym], toTWD(lotsTotal(fifo).cost, symCur[sym], fx));
      addFlow(sell, symMarket[sym], estSellCost(symMarket[sym], sym, shares[sym], px[sym], discount)); // TWD: 台股 only
    }

    res.days.push(d);
    res.fx.push(fx);
    for (const seg of perfSegments) {
      const ps = res.series[seg];
      const n = ps.value.length - 1;
      const prev = ps.value[n];
      let g = ps.growth[n];
      let act = ps.active[n];
      // Two sub-periods: previous close → trades, then trades → close.
      let mid = atTrade[seg] || 0;
      if (prev > 0 && mid > 0) {
        g *= mid / prev;
      } else {
        mid = prev;
      }
      const den = mid + (inflow[seg] || 0);
      if (den > 0) {
        g *= ((value[seg] || 0) + (outflow[seg] || 0)) / den;
        act++;
      }
      ps.value.push(value[seg] || 0);
      ps.growth.push(g);
      ps.pnl.push(ps.pnl[n] + (value[seg] || 0) + (outflow[seg] || 0) - prev - (inflow[seg] || 0));
      ps.active.push(act);
      ps.cost.push(held[seg] || 0);
      ps.unrealized.push((value[seg] || 0) - (held[seg] || 0) - (sell[seg] || 0));
      ps.realized.push(realized[seg] || 0);
    }
  }
  return res;
}

export class PerfResult {
  constructor() {
    this.days = []; // days[0] is the base day before the first trade (value 0, growth 1)
    this.series = {}; // seg -> { value, growth, pnl, active, cost, unrealized, realized }
    this.fx = []; // USD/TWD used each day
    this.missing = []; // traded symbols without any daily close
  }

  /** Index of the last day on or before start (0 = base day). */
  baseIndex(start) {
    let b = 0;
    while (b + 1 < this.days.length && this.days[b + 1] <= start) b++;
    return b;
  }

  /** One segment's numbers from the close of day b to the last day. Percentages in %. */
  stats(seg, b) {
    const ps = this.series[seg];
    const last = this.days.length - 1;
    const s = {
      twr: null,
      pnl: goRound(ps.pnl[last] - ps.pnl[b]),
      start_value: goRound(ps.value[b]),
      end_value: goRound(ps.value[last]),
      max_drawdown: null,
      volatility: null,
    };
    if (ps.active[last] === ps.active[b]) return s;
    const ret = ps.growth[last] / ps.growth[b] - 1;
    s.twr = round2(ret * 100);
    // Annualize over days with capital at work, so a market that started later
    // isn't diluted by the years before its first trade.
    const span = ps.active[last] - ps.active[b];
    s.annualized = annualizePct(ret * 100, span);
    s.active_days = span;

    const [dd, peak, trough] = drawdown(ps.growth, b, last);
    s.max_drawdown = round2(dd * 100);
    if (trough > 0) {
      s.dd_peak = this.days[peak];
      s.dd_trough = this.days[trough];
      for (let i = trough + 1; i <= last; i++) {
        if (ps.growth[i] >= ps.growth[peak]) {
          s.dd_recovered = this.days[i];
          break;
        }
      }
    }
    const rs = dailyReturns(ps, this.days, b, last);
    const v = volatility(rs);
    if (v !== null) s.volatility = round2(v * 100);
    const so = sortino(rs);
    s.sortino = so == null ? null : round2(so);
    return s;
  }

  /**
   * Chains each calendar month (and year) from the close of day `from` onward;
   * the first and current months are partial. Returns [{ year, months[12], total }],
   * null = no capital at work.
   */
  monthlyReturns(seg, from) {
    const ps = this.series[seg];
    const last = this.days.length - 1;
    const years = [];
    let monthStart = from;
    let yearStart = from;
    for (let i = from + 1; i <= last; i++) {
      const d = this.days[i];
      if (i < last && this.days[i + 1].slice(0, 7) === d.slice(0, 7)) continue;
      const year = Number(d.slice(0, 4));
      const month = Number(d.slice(5, 7));
      if (years.length === 0 || years[years.length - 1].year !== year) {
        years.push({ year, months: new Array(12).fill(null), total: null });
      }
      const y = years[years.length - 1];
      if (ps.active[i] > ps.active[monthStart]) {
        y.months[month - 1] = round2((ps.growth[i] / ps.growth[monthStart] - 1) * 100);
      }
      monthStart = i;
      if (i === last || this.days[i + 1].slice(0, 4) !== d.slice(0, 4)) {
        if (ps.active[i] > ps.active[yearStart]) {
          y.total = round2((ps.growth[i] / ps.growth[yearStart] - 1) * 100);
        }
        yearStart = i;
      }
    }
    // Drop years with no capital at work at all.
    return years.filter((y) => y.total !== null);
  }
}

/**
 * Largest peak-to-trough fall of g within [b, last] as a negative fraction,
 * with the peak and trough indexes (trough 0 = no fall).
 */
export function drawdown(g, b, last) {
  let worst = 0;
  let peak = b;
  let wPeak = 0;
  let wTrough = 0;
  for (let i = b + 1; i <= last; i++) {
    if (g[i] > g[peak]) {
      peak = i;
      continue;
    }
    const d = g[i] / g[peak] - 1;
    if (d < worst) {
      worst = d;
      wPeak = peak;
      wTrough = i;
    }
  }
  return [worst, wPeak, wTrough];
}

/**
 * Daily returns over trading days with capital at work. Weekends and holidays
 * (exactly 0) are skipped so they don't dilute the statistics below.
 */
export function dailyReturns(ps, days, b, last) {
  const rs = [];
  for (let i = b + 1; i <= last; i++) {
    if (ps.active[i] === ps.active[i - 1]) continue;
    if (!isDateOnly(days[i])) continue;
    const wd = weekday(days[i]);
    if (wd === 0 || wd === 6) continue;
    const r = ps.growth[i] / ps.growth[i - 1] - 1;
    if (r !== 0) rs.push(r);
  }
  return rs;
}

const MIN_SAMPLES = 20;
const mean = (rs) => rs.reduce((a, r) => a + r, 0) / rs.length;

/** Annualized standard deviation of daily returns (dailyReturns). Needs 20 samples; null otherwise. */
export function volatility(rs) {
  if (rs.length < MIN_SAMPLES) return null;
  const m = mean(rs);
  const ss = rs.reduce((a, r) => a + (r - m) * (r - m), 0);
  return Math.sqrt(ss / (rs.length - 1)) * Math.sqrt(252);
}

/**
 * Sortino ratio: annualized mean daily return ÷ annualized downside deviation (only the
 * falling days count as risk; risk-free rate taken as 0). null with under 20 samples or no
 * falling day.
 */
export function sortino(rs) {
  if (rs.length < MIN_SAMPLES) return null;
  const down = Math.sqrt(rs.reduce((a, r) => a + (r < 0 ? r * r : 0), 0) / rs.length);
  return down > 0 ? (mean(rs) * 252) / (down * Math.sqrt(252)) : null;
}

/**
 * Rolling 1-year return (%) on each day: value ÷ value 365 calendar days earlier − 1.
 * values: growth or price index aligned to dates, null where there's nothing yet.
 * null for days without a full year behind them.
 */
export function rollingYear(dates, values) {
  const out = new Array(dates.length).fill(null);
  let j = 0;
  for (let i = 0; i < dates.length; i++) {
    const from = addDays(dates[i], -365);
    if (dates[0] > from) continue;
    while (j + 1 < i && dates[j + 1] <= from) j++;
    const a = values[j];
    const v = values[i];
    if (a > 0 && v > 0) out[i] = round2((v / a - 1) * 100);
  }
  return out;
}

/** Best, worst, median and the share of negative windows of a rolling series; null when empty. */
export function rollingSummary(dates, rolling) {
  const pts = rolling.map((v, i) => [v, dates[i]]).filter(([v]) => v != null).sort((a, b) => a[0] - b[0]);
  if (!pts.length) return null;
  const [worst, best] = [pts[0], pts.at(-1)];
  const mid = pts.length >> 1;
  return {
    best: best[0], best_date: best[1],
    worst: worst[0], worst_date: worst[1],
    median: round2(pts.length % 2 ? pts[mid][0] : (pts[mid - 1][0] + pts[mid][0]) / 2),
    negative_pct: round2(pts.filter(([v]) => v < 0).length / pts.length * 100),
  };
}

/**
 * Forward-fills a benchmark's dividend-adjusted close onto days, in TWD when
 * usd. 0 before the benchmark's first bar.
 */
export function benchValues(closes, days, fx, usd) {
  const list = closes || [];
  const out = new Array(days.length).fill(0);
  let j = 0;
  let v = 0;
  days.forEach((d, i) => {
    while (j < list.length && list[j].date <= d) {
      v = list[j].adj_close;
      j++;
    }
    out[i] = usd ? v * fx[i] : v;
  });
  return out;
}

/** Benchmark return in % from day b (or its first bar after b) to the last day; null if none. */
export function benchReturn(v, b) {
  while (b < v.length && v[b] <= 0) b++;
  if (b >= v.length - 1) return null;
  return round2((v[v.length - 1] / v[b] - 1) * 100);
}

/**
 * Up to 4 decimals without trailing zeros, with thousands separators:
 * 115000 → "115,000", 20.05 → "20.05".
 */
export function fmtNum(v) {
  let s = String(round4(v));
  if (s.includes('e')) s = round4(v).toFixed(4).replace(/\.?0+$/, '');
  let [intPart, frac = ''] = s.split('.');
  if (frac) frac = '.' + frac;
  const neg = intPart.startsWith('-');
  if (neg) intPart = intPart.slice(1);
  let out = '';
  for (let i = 0; i < intPart.length; i++) {
    if (i > 0 && (intPart.length - i) % 3 === 0) out += ',';
    out += intPart[i];
  }
  return (neg ? '-' : '') + out + frac;
}

/** A cumulative % return over `days` as a yearly rate; null for a year or less (too noisy). */
export function annualizePct(pct, days) {
  return pct == null || !(days > 366) ? null : round2((Math.pow(1 + pct / 100, 365 / days) - 1) * 100);
}
