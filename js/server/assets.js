// Net-worth snapshots.

import * as db from './db.js';
import { route } from './router.js';
import { badRequest, body, refreshAndPersistRate, cmp, storedUSDTWDRate } from './util.js';
import { portfolioValues } from './stocks.js';
import { performance } from './twr.js';
import { otherAssetsTotal, includeOtherAssets } from './other_assets.js';

const FIELDS = ['cash_twd', 'cash_usd', 'stock_tw_value', 'stock_us_value', 'stock_value_twd', 'usd_twd_rate', 'total_asset'];

const assetJSON = (s) => ({
  id: s.id, date: s.date, cash_twd: s.cash_twd, cash_usd: s.cash_usd,
  stock_tw_value: s.stock_tw_value, stock_us_value: s.stock_us_value, stock_value_twd: s.stock_value_twd,
  usd_twd_rate: s.usd_twd_rate, total_asset: s.total_asset, other_assets: s.other_assets || 0,
  // total_asset is cash + stocks; 其他資產 join net worth when the setting says so
  net_worth: s.total_asset + (includeOtherAssets() ? s.other_assets || 0 : 0), note: s.note, created_at: s.created_at,
});

function decode(req) {
  const b = body(req);
  const s = { date: b.date ? String(b.date) : '', note: b.note == null ? '' : String(b.note) };
  for (const f of FIELDS) s[f] = Number(b[f]) || 0;
  if (b.other_assets != null) s.other_assets = Number(b.other_assets) || 0; // else: today's total on create, kept on edit
  return s;
}

/**
 * Stock values (TWD) and USD/TWD rate on a past date from the performance series, which is rebuilt
 * daily from the trades and closing prices: [tw, us, rate]. No trades at all (or none yet on that
 * date): no stock. perf: performance() result.
 */
export function marketOn(date, perf) {
  const s = perf.series;
  if (!s || !s.dates.length) return [0, 0, storedUSDTWDRate()];
  const i = s.dates.findLastIndex((d) => d <= date);
  return i < 0 ? [0, 0, s.fx[0]] : [s.value.TW[i] || 0, s.value.US[i] || 0, s.fx[i]];
}

/**
 * Fill whatever was left at 0: rate, stock values, total. Today: live quotes and rate (refreshed and
 * persisted, so the snapshot freezes it). A past date: that day's values from the performance series
 * (built here unless passed in; null = already tried and unavailable), so a snapshot for last March
 * doesn't get today's stock value. Without the series that is an error (fill them in by hand), never
 * today's values.
 */
export async function autoFill(s, perf) {
  const needRate = s.usd_twd_rate === 0;
  const needStock = s.stock_value_twd === 0;
  if (needRate || needStock) {
    const isPast = s.date < db.today();
    if (isPast && perf === undefined) perf = await performance().catch(() => null); // null: tried, unavailable
    if (isPast && !perf) throw badRequest('算不出那一天的股票市值（還沒抓到歷史股價，或沒有行情代理）。請稍後再試，或切到「手動」自己填股票市值與匯率');
    const past = isPast ? marketOn(s.date, perf) : null;
    if (needRate) s.usd_twd_rate = past ? past[2] : await refreshAndPersistRate();
    if (needStock) {
      const [tw, us] = past || await portfolioValues();
      [s.stock_tw_value, s.stock_us_value, s.stock_value_twd] = [tw, us, tw + us];
    }
  }
  if (s.total_asset === 0) s.total_asset = netWorthOf({ cashTWD: s.cash_twd, cashUSD: s.cash_usd, rate: s.usd_twd_rate, stocks: s.stock_value_twd });
}

/** Save a new snapshot; 其他資產 default to today's total. */
export function insertSnapshot(s) {
  s.other_assets ??= otherAssetsTotal();
  return db.insert('asset_snapshots', s);
}

/** Snapshots, newest first. */
export function listSnapshots() {
  return db.all('asset_snapshots')
    .sort((a, b) => cmp(b.date, a.date) || cmp(b.created_at, a.created_at))
    .map(assetJSON);
}

/** Is a dated record newer than the snapshot? Same-day ties go by entry time. */
export const afterSnapshot = (r, snap) => r.date > snap.date
  || (r.date === snap.date && !!r.created_at && !!snap.created_at && r.created_at > snap.created_at);

/** Net worth in TWD: the one formula every page uses. */
export const netWorthOf = ({ cashTWD, cashUSD, rate, stocks, other = 0 }) => cashTWD + cashUSD * rate + stocks + other;

/**
 * Daily net worth aligned to the performance series' dates: rebuilt stock values, with cash and
 * 其他資產 (when counted) from the snapshot on or before each day (null before the first snapshot).
 * snaps: chronological.
 */
export function netWorthSeries({ dates, value, fx }, snaps, includeOther = true) {
  let j = -1;
  return dates.map((d, i) => {
    while (j + 1 < snaps.length && snaps[j + 1].date <= d) j++;
    if (j < 0) return null;
    const s = snaps[j];
    return Math.round(netWorthOf({ cashTWD: s.cash_twd || 0, cashUSD: s.cash_usd || 0, rate: fx[i],
      stocks: value.TW[i] + value.US[i], other: includeOther ? s.other_assets || 0 : 0 }));
  });
}

/** Cash a trade moves, in its own currency: a buy pays price + fee, a sell gets price − fee − tax. */
export const tradeCash = (t) => (t.action === 'BUY'
  ? -(t.shares * t.price + (t.fee || 0))
  : t.shares * t.price - (t.fee || 0) - (t.tax || 0));

/**
 * The latest snapshot's cash carried forward by what the app records since: own trades
 * (imported positions moved no cash; managed accounts have their own cash) and dividends
 * (net of withholding). So buying stock after a snapshot moves money instead of adding it.
 * Returns null without snapshots; amounts in native currency.
 */
export function carriedCash(snap = listSnapshots()[0]) {
  if (!snap) return null;
  const out = { date: snap.date, twd: snap.cash_twd || 0, usd: snap.cash_usd || 0, trades: 0, dividends: 0, moved_twd: 0, moved_usd: 0 };
  const add = (currency, n) => { out[currency === 'USD' ? 'moved_usd' : 'moved_twd'] += n; };
  for (const t of db.where('stock_transactions', (t) => t.account_id == null && !t.is_transfer && afterSnapshot(t, snap))) {
    add(t.currency, tradeCash(t));
    out.trades++;
  }
  for (const d of db.where('dividends', (d) => afterSnapshot(d, snap))) {
    add(d.currency, d.amount || 0);
    out.dividends++;
  }
  out.twd += out.moved_twd;
  out.usd += out.moved_usd;
  return out;
}

async function create(req) {
  const s = decode(req);
  if (!s.date) s.date = db.today();
  await autoFill(s);
  const row = insertSnapshot(s);
  return { ...assetJSON(s), id: row.id, created_at: '' };
}

async function update(req) {
  const s = decode(req);
  await autoFill(s);
  db.update('asset_snapshots', req.params.id, s);
  return { status: 'updated' };
}

route('GET', '/api/assets', listSnapshots);
route('POST', '/api/assets', create);
route('PUT', '/api/assets/{id}', update);
route('DELETE', '/api/assets/{id}', (req) => { db.remove('asset_snapshots', req.params.id); return { status: 'deleted' }; });
