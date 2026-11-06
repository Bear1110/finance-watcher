// Data health checks: GET /api/data-check.
// Flags records that make performance, XIRR or the dashboard less accurate, and
// suggests a performance start date after the last holding import.

import * as db from './db.js';
import { route } from './router.js';
import { isSelfHistorySell, cmp, daysBetween } from './util.js';
import { hasProxy } from './market.js';
import { loadPerfTxns, perfOrigin, loadPriceHistory } from './twr.js';
import { fmtNum, isDateOnly } from './twr_calc.js';
import { dividendSuggestions } from './dividends.js';

// checkResult: { level: warn|info|ok, title, detail?, items?, action? }.
// action names the UI jump the page offers (start_date, transactions, dividends, assets).

// Keeps a long list readable; the rest is summarized.
const MAX_CHECK_ITEMS = 8;

function capItems(items) {
  if (items.length <= MAX_CHECK_ITEMS) return items;
  return [...items.slice(0, MAX_CHECK_ITEMS), `…還有 ${items.length - MAX_CHECK_ITEMS} 筆`];
}

export async function check() {
  const txns = loadPerfTxns();
  const { setting: startSetting, origin } = perfOrigin(txns);
  const checks = [];

  // 1. Holding imports: placeholder dates and average-cost prices.
  const imports = [];
  let lastImport = '';
  for (const t of txns) {
    if (t.transfer) {
      imports.push(`${t.date} ${t.symbol} 買入 ${fmtNum(t.shares)} 股（均價 ${fmtNum(t.price)}）`);
      if (t.date > lastImport) lastImport = t.date;
    }
  }
  let suggested = '';
  for (const t of txns) {
    if (t.date > lastImport && !t.transfer && !t.synthetic) {
      suggested = t.date;
      break;
    }
  }
  if (imports.length === 0) {
    checks.push({ level: 'ok', title: '沒有「匯入持倉」的補登買入' });
  } else if (origin > lastImport) {
    checks.push({ level: 'ok', title: '績效起算日已避開匯入持倉',
      detail: `起算日 ${origin} 晚於最後一筆匯入持倉（${lastImport}）。` });
  } else {
    checks.push({ level: 'warn', title: `${imports.length} 筆「匯入持倉」的日期可能不是實際買進日`,
      detail: '績效會假設這些股票從那天起一直持有、中間沒有買賣，而且當時的股利也沒有記錄。'
        + '如果不確定當年的持股變化，建議把「績效起算日」設在紀錄完整之後。',
      items: capItems(imports), action: 'start_date' });
  }

  // 2. Sells with no buy records inside the performance window.
  const orphanIn = [];
  let orphanBefore = 0;
  const historySells = db.where('stock_transactions', isSelfHistorySell)
    .sort((a, b) => cmp(a.date, b.date));
  for (const t of historySells) {
    if (t.date >= origin) orphanIn.push(`${t.date} ${t.symbol} 賣出 ${fmtNum(t.shares)} 股`);
    else orphanBefore++;
  }
  if (orphanIn.length > 0) {
    checks.push({ level: 'info', title: `績效期間內有 ${orphanIn.length} 筆賣出沒有對應的買入紀錄`,
      detail: '這些是只記了已實現損益的歷史賣出。績效與 XIRR 把它們估算成「賣出前一天以反推成本買進」，損益有算進去，但持有期間被壓縮成一天，報酬率會稍微偏高。補登當初真實的買入，就能精確計入。',
      items: capItems(orphanIn), action: 'transactions' });
  } else {
    checks.push({ level: 'ok', title: '績效期間內的賣出都有買入紀錄' });
  }
  if (orphanBefore > 0) {
    checks.push({ level: 'info', title: `起算日前有 ${orphanBefore} 筆只有損益的歷史賣出`,
      detail: '在績效起算日之前，不影響所選期間的績效。' });
  }

  // 3. Trade prices far from that day's close: pre-split units or a typo.
  // Reads only the local cache of daily closes, no network.
  const symbols = [];
  const seen = new Set();
  for (const t of txns) {
    if (!seen.has(t.symbol)) {
      seen.add(t.symbol);
      symbols.push(t.symbol);
    }
  }
  const closes = loadPriceHistory(symbols);
  const offPrice = [];
  const noHistory = symbols.filter((sym) => !closes[sym] || closes[sym].length === 0);
  for (const t of txns) {
    if (t.transfer || t.synthetic || t.price <= 0) continue;
    const cs = closes[t.symbol] || [];
    let i = cs.findIndex((c) => c.date > t.date);
    i = (i < 0 ? cs.length : i) - 1;
    if (i < 0) continue;
    const ratio = t.price / cs[i].close;
    if (ratio > 1.6 || ratio < 0.6) {
      offPrice.push(`${t.date} ${t.symbol} 成交價 ${fmtNum(t.price)}，當日收盤 ${fmtNum(cs[i].close)}`);
    }
  }
  if (offPrice.length > 0) {
    checks.push({ level: 'warn', title: `${offPrice.length} 筆交易的成交價和當日收盤差很多`,
      detail: 'Yahoo 的價格已還原股票分割，所以股數要用分割後的單位。這幾筆可能是分割前的股數／價格，也可能是打錯。',
      items: capItems(offPrice), action: 'transactions' });
  } else if (Object.keys(closes).length > 0) {
    checks.push({ level: 'ok', title: '成交價都和當日收盤相符（沒有分割或輸入錯誤的跡象）' });
  }
  if (noHistory.length > 0 && noHistory.length < symbols.length) {
    noHistory.sort();
    checks.push({ level: 'info', title: '部分股票沒有 Yahoo 歷史價',
      detail: '績效改用成交價估算這些股票的市值。若剛新增交易，打開總覽後會自動抓取。', items: noHistory });
  }

  // 4. Dividends Yahoo knows about but not recorded, inside the window.
  if (!hasProxy()) {
    checks.push({ level: 'info', title: '沒有設定行情代理，略過股利檢查',
      detail: '查詢 Yahoo 除息資料需要行情代理（設定 → 行情來源）。' });
  } else {
    let result = null;
    try {
      result = await dividendSuggestions();
    } catch (e) {
      console.warn('data-check dividend suggestions failed', e);
    }
    if (result) {
      const { suggestions: sugg, errors: errs } = result;
      const missing = [];
      for (const s of sugg) {
        if (s.ex_date >= origin) {
          missing.push(`${s.ex_date} ${s.symbol} 每股 ${fmtNum(s.per_share)} × ${fmtNum(s.shares)} 股`);
        }
      }
      if (missing.length > 0) {
        checks.push({ level: 'warn', title: `績效期間內約有 ${missing.length} 筆股利沒有記錄`,
          detail: '依 Yahoo 除息資料 × 當時持股估算。少記股利會讓績效、XIRR 偏低。可到股利頁「從 Yahoo 查詢股利」匯入。',
          items: capItems(missing), action: 'dividends' });
      } else if (errs.length === 0) {
        checks.push({ level: 'ok', title: '績效期間內的股利都有記錄' });
      }
      if (errs.length > 0) {
        checks.push({ level: 'info', title: '部分股票查不到 Yahoo 除息資料', items: errs });
      }
    }
  }

  // 5. Stale asset snapshot: the dashboard's cash comes from it.
  let lastSnap = '';
  for (const s of db.all('asset_snapshots')) if (s.date > lastSnap) lastSnap = s.date;
  if (isDateOnly(lastSnap)) {
    const days = daysBetween(lastSnap, db.today());
    if (days > 35) {
      checks.push({ level: 'warn', title: `最新資產快照是 ${days} 天前（${lastSnap}）`,
        detail: '總覽的現金與淨資產用的是最新快照的現金數字，可能已經過時。', action: 'assets' });
    } else {
      checks.push({ level: 'ok', title: `資產快照在一個月內（${lastSnap}）` });
    }
  }

  return { checks, start_setting: startSetting, suggested_start: suggested };
}

route('GET', '/api/data-check', check);
