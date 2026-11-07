// AI analysis: builds a prompt from the user's data; the user takes it to their own AI
// (ChatGPT / Claude links or copy) — nothing is sent anywhere from here.

import * as db from './db.js';
import { route } from './router.js';
import { body, storedUSDTWDRate } from './util.js';
import { buildOverview } from './overview.js';
import { summarizeRealized } from './stocks.js';
import { performance } from './twr.js';
import { annualizePct } from './twr_calc.js';
import { xirrHandler } from './performance.js';
import { check } from './datacheck.js';
import { expenseTWD } from './expenses.js';

// ---------------------------------------------------------------- data for the prompt

export async function generateAutoPrompt(sections) {
  if (!Array.isArray(sections) || sections.length === 0) {
    sections = ['assets', 'portfolio', 'realized', 'expenses'];
  }
  const set = new Set(sections);
  const year = new Date().getFullYear();
  const soft = (p) => p.catch(() => null); // a missing quote proxy only drops that part
  const [built, perf, xirr] = await Promise.all([
    soft(buildOverview()),
    set.has('portfolio') ? soft(performance()) : null,
    set.has('portfolio') ? soft(xirrHandler()) : null,
  ]);
  // The data check reads only the cached price history (no network); performance() above
  // refreshes it, so run the check after (without the portfolio section it uses what is cached).
  const checks = await soft(check());
  const { overview = null, stocks = null, portfolio = null } = built || {};
  return generateFinancialPrompt({
    sections: set,
    rate: storedUSDTWDRate(),
    overview,
    holdings: set.has('portfolio') ? stocks : null,
    portfolio: set.has('portfolio') ? portfolio : null,
    perf,
    xirr,
    realized: set.has('realized') ? summarizeRealized() : null,
    expenses: set.has('expenses') ? db.where('expenses', (e) => e.date.startsWith(`${year}-`)) : [],
    warnings: ((checks && checks.checks) || []).filter((c) => c.level === 'warn').map((c) => c.title),
  });
}

// ---------------------------------------------------------------- prompt text

const f = (v, d) => Number(v).toFixed(d);
const sf = (v, d) => (v >= 0 ? '+' : '') + f(v, d);
const money = (v) => Math.round(v).toLocaleString('en-US');
const pct = (v) => (v == null ? '--' : sf(v, 2) + '%');
const smoney = (v) => (v > 0 ? '+' : '') + money(v);
const CN_NUMS = ['一', '二', '三', '四', '五', '六', '七', '八'];
const MARKET_NAME = { ALL: '全部', TW: '台股', US: '美股' };

function assetsSection(data) {
  const ov = data.overview;
  if (!(ov && ov.net_worth != null)) return null;
  let sb = '';
  const p = ov.parts;
  const parts = [['台幣現金', p.cash_twd], ['美金現金', p.cash_usd], ['台股', p.tw], ['美股', p.us], ['其他資產（自填：不動產、車等）', p.other]]
    .filter(([, v]) => v > 0);
  const total = parts.reduce((s, [, v]) => s + v, 0);
  sb += `資料日期 ${ov.today}。現金以 ${ov.cash.date} 的帳戶快照為準，加計之後記錄的股票買賣與股利；股票為即時市值。\n\n`;
  sb += `- **淨資產: NT$ ${money(ov.net_worth)}**\n`;
  for (const [label, v] of parts) sb += `- ${label}: NT$ ${money(v)}（${f(v / total * 100, 1)}%）\n`;
  sb += '\n';
  if (ov.years.length) {
    sb += '### 每年淨資產變化（拆成來源）\n';
    sb += '「存入與其他」是淨資產變化中不是投資賺來的部分（存下的薪水、別人給的錢、美金現金匯差等，替別人付出去的錢會讓它變少），由淨資產變化反推。\n\n';
    const hasOther = ov.years.some((y) => y.other);
    sb += `| 年度 | 年初淨資產 | 淨資產變化 | 股價漲跌 | 股利 |${hasOther ? ' 其他資產 |' : ''} 存入與其他 |\n`;
    sb += `|------|-----------|-----------|---------|------|${hasOther ? '---------|' : ''}-----------|\n`;
    for (const y of [...ov.years].reverse()) {
      const label = `${y.year}${y.current ? '（至今）' : ''}${y.partial ? '（年中開始記錄）' : ''}`;
      sb += `| ${label} | ${money(y.start)} | ${smoney(y.change)} | ${smoney(y.price)} | ${smoney(y.dividends)} |${hasOther ? ` ${smoney(y.other)} |` : ''} ${smoney(y.savings)} |\n`;
    }
    sb += '\n';
  }
  return ['資產總覽', sb];
}

function portfolioSection(data) {
  const h = data.holdings;
  if (!h) return null;
  let sb = '';
  sb += `- 持股市值: NT$ ${money(h.total_value_twd)}；持有成本: NT$ ${money(h.total_cost_twd)}\n`;
  sb += `- 未實現損益: ${smoney(h.total_pl_twd)}（${pct(h.total_pl_percent)}）；累計已實現損益: ${smoney(h.realized_pl_twd)}\n\n`;
  if (h.holdings.length) {
    sb += '### 持股明細（即時報價）\n\n';
    sb += '| 股票 | 市場 | 股數 | 均價 | 現價 | 市值(TWD) | 未實現損益(TWD) | 損益% | 佔股票% |\n';
    sb += '|------|------|------|------|------|-----------|----------------|-------|--------|\n';
    for (const x of [...h.holdings].sort((a, b) => b.market_value_twd - a.market_value_twd)) {
      const w = h.total_value_twd > 0 ? x.market_value_twd / h.total_value_twd * 100 : 0;
      sb += `| ${x.symbol} | ${x.market} | ${f(x.shares, 0)} | ${f(x.avg_cost, 2)} | ${f(x.current_price, 2)} | ${money(x.market_value_twd)} | ${smoney(x.unrealized_pl_twd)} | ${pct(x.pl_percent)} | ${f(w, 1)}% |\n`;
    }
    sb += '\n';
  }
  const pf = data.portfolio;
  if (pf) {
    const top = pf.rows[0];
    sb += '### 集中度與配置\n';
    sb += `- 最大持股 ${top.symbol} 佔 ${f(top.weight, 1)}%；前 3 大合計 ${f(pf.top3, 1)}%（App 以 25% 為偏高、40% 為高度集中）\n`;
    sb += `- 等效持股數 ${f(pf.effective, 1)} 檔（實際持有 ${pf.rows.length} 檔；1 ÷ Σ權重²，越小越集中）\n`;
    if (pf.usd.pct != null && pf.usd.stock + (pf.usd.cash || 0) > 0) sb += `- 美元資產佔淨資產 ${f(pf.usd.pct, 1)}%\n`;
    sb += `- 近 12 個月股利 NT$ ${money(pf.dividends.ttm)}${pf.dividends.yield_cost != null ? `，以持有成本計殖利率 ${f(pf.dividends.yield_cost, 2)}%` : ''}\n\n`;
  }
  const perf = data.perf;
  if (perf && perf.periods && perf.periods.length) {
    const segs = ['ALL', ...((perf.markets || []).length > 1 ? perf.markets : [])];
    const benches = perf.benchmarks || [];
    const want = perf.periods.filter((p) => ['YTD', '1Y', 'ALL'].includes(p.key));
    sb += '### 報酬率（時間加權 TWR：只看持股本身表現，不受加碼時機影響；含股利與匯率）\n\n';
    sb += `| 期間 | ${segs.map((s) => MARKET_NAME[s]).join(' | ')} | ${benches.map((b) => b.label).join(' | ')} |\n`;
    sb += `|------|${segs.map(() => '------').join('|')}|${benches.map(() => '------').join('|')}|\n`;
    for (const p of want) {
      const cell = (r) => (r && r.twr != null ? `${pct(r.twr)}${p.key === 'ALL' && r.annualized != null ? `（年化 ${pct(r.annualized)}）` : ''}` : '--');
      const benchCell = (v) => (v == null ? '--' : `${pct(v)}${p.key === 'ALL' && annualizePct(v, p.days) != null ? `（年化 ${pct(annualizePct(v, p.days))}）` : ''}`);
      sb += `| ${p.label}（自 ${p.start}） | ${segs.map((s) => cell(p.markets[s])).join(' | ')} | ${benches.map((b) => benchCell(p.bench[b.symbol])).join(' | ')} |\n`;
    }
    const y1 = perf.periods.find((p) => p.key === '1Y');
    const r1 = y1 && y1.markets.ALL;
    if (r1 && r1.twr != null) sb += `\n近 1 年最大回撤 ${pct(r1.max_drawdown)}、年化波動度 ${r1.volatility == null ? '--' : f(r1.volatility, 1) + '%'}。\n`;
    sb += '\n';
  }
  const x = data.xirr;
  if (x && x.ALL && x.ALL.xirr != null) {
    const marks = ['TW', 'US'].filter((m) => x[m] && x[m].flows > 1 && x[m].xirr != null).map((m) => `${MARKET_NAME[m]} ${pct(x[m].xirr)}`);
    sb += `累計年化報酬 XIRR（以實際投入金額與時點計算，自 ${(x.ALL.first_date || '').slice(0, 7)} 起）: ${pct(x.ALL.xirr)}${marks.length ? `（${marks.join('、')}）` : ''}\n\n`;
  }
  return ['股票投資組合', sb];
}

function realizedSection(data) {
  if (!(data.realized && data.realized.by_stock.length > 0)) return null;
  let sb = '';
  const o = data.realized.overall;
  const ts = data.realized.trade_stats.ALL;
  sb += `- 總交易次數: ${ts.trades} 筆\n`;
  sb += `- 勝率: ${f(ts.win_rate, 1)}% (${ts.wins} 勝 / ${ts.losses} 負${ts.flat ? ` / ${ts.flat} 平` : ''})\n`;
  sb += `- 獲利因子 (Profit Factor = 總獲利 ÷ 總虧損): ${ts.profit_factor == null ? '無虧損交易' : f(ts.profit_factor, 2)}（總獲利 NT$ ${money(ts.gross_profit)} / 總虧損 NT$ ${money(ts.gross_loss)}）\n`;
  sb += `- 平均獲利 / 平均虧損: NT$ ${money(ts.avg_win)} / NT$ ${money(ts.avg_loss)}${ts.payoff == null ? '' : `（賺賠比 ${f(ts.payoff, 2)}）`}\n`;
  sb += `- 每筆期望值 (Expectancy): NT$ ${smoney(ts.expectancy)}\n`;
  sb += `- 總已實現損益 (TWD): ${money(o.total_realized_pl_twd)}\n\n`;
  sb += '### 各股交易績效\n\n';
  sb += '| 股票 | 市場 | 交易次數 | 已實現損益 | 平均報酬率 | 最佳% | 最差% |\n';
  sb += '|------|------|---------|-----------|----------|-------|-------|\n';
  for (const s of data.realized.by_stock) {
    const cur = s.currency === 'TWD' ? 'NT$' : 'US$';
    sb += `| ${s.symbol} | ${s.market} | ${s.total_trades} | ${cur} ${money(s.total_realized_pl)} | ${pct(s.avg_return_pct)} | ${pct(s.best_trade_pct)} | ${pct(s.worst_trade_pct)} |\n`;
  }
  sb += '\n';
  return ['交易績效（已實現損益）', sb];
}

function expensesSection(data) {
  const ov = data.overview;
  if (!(data.expenses && data.expenses.length > 0)) return null;
  let sb = '';
  let totalIncome = 0, totalExpense = 0;
  const incomeCats = new Map();
  const expenseCats = new Map();
  for (const e of data.expenses) {
    const cat = e.category || '未分類';
    const m = e.type === 'income' ? incomeCats : expenseCats;
    const v = expenseTWD(e);
    if (e.type === 'income') totalIncome += v; else totalExpense += v;
    m.set(cat, (m.get(cat) || 0) + v);
  }
  sb += `總收入: NT$ ${money(totalIncome)} / 總支出: NT$ ${money(totalExpense)} / 結餘: NT$ ${money(totalIncome - totalExpense)}`;
  if (totalIncome > 0) sb += `（儲蓄率 ${f((totalIncome - totalExpense) / totalIncome * 100, 1)}%）`;
  sb += '\n';
  const sp = ov && ov.spending;
  if (sp && sp.monthly_expense) {
    sb += `每月生活費約 NT$ ${money(sp.monthly_expense)}（${sp.source === 'setting' ? '使用者自填' : '依近 12 個月紀錄估算'}）`;
    if (sp.cash_months != null) sb += `，現金可撐 ${f(sp.cash_months, 1)} 個月`;
    sb += '\n';
  }
  sb += '\n';
  const list = (m) => [...m].sort((a, b) => b[1] - a[1]).map(([cat, total]) => `- ${cat}: NT$ ${money(total)}`).join('\n');
  if (incomeCats.size > 0) sb += `### 收入分類\n${list(incomeCats)}\n\n`;
  if (expenseCats.size > 0) sb += `### 支出分類\n${list(expenseCats)}\n\n`;
  return ['收支狀況（今年，依使用者的記帳紀錄，可能不完整）', sb];
}

/** Build the analysis prompt from the same numbers the app shows. data.sections is a Set (null = all). */
export function generateFinancialPrompt(data) {
  const inc = (k) => !data.sections || data.sections.has(k);
  let sb = `你是一位專業的個人財務顧問。以下是使用者在一個個人資產與股票記錄 App 裡的資料（使用者在台灣）。
金額單位為新台幣，美元依目前匯率 ${f(data.rate, 2)} 換算；不含使用者替別人代管的資金與持股。
請根據資料提供深入、具體的分析，回答使用繁體中文、數字用千分位。
需要年齡、收入穩定度、理財目標等資訊才能判斷時，請先說明你的假設，或列出想問使用者的問題。

`;
  const sections = [['assets', assetsSection], ['portfolio', portfolioSection], ['realized', realizedSection], ['expenses', expensesSection]]
    .filter(([key]) => inc(key)).map(([, build]) => build(data)).filter(Boolean);
  sections.forEach(([title, text], i) => { sb += `# ${CN_NUMS[i]}、${title}\n\n${text}`; });

  // ===== 資料提醒 =====
  if (data.warnings && data.warnings.length) {
    sb += '# 資料提醒\n以下資料問題可能讓部分數字失真，分析時請考慮：\n';
    sb += data.warnings.map((w) => `- ${w}`).join('\n') + '\n\n';
  }

  // ===== 分析要求 =====
  sb += '# 請根據上述資料提供以下分析\n\n';
  let n = 1;
  if (inc('assets')) {
    sb += `## ${n++}. 資產配置評估\n`;
    sb += '- 現金、台股、美股（與其他資產）的比例是否合理？現金是否足夠當緊急預備金？\n';
    sb += '- 美元資產比例帶來的匯率風險是否需要注意？\n';
    sb += '- 從每年淨資產變化來看，成長主要來自投資（股價、股利）還是存入？這個結構健康嗎？\n\n';
  }
  if (inc('portfolio')) {
    sb += `## ${n++}. 投資組合評估\n`;
    sb += '- 和大盤（0050、S&P 500）相比表現如何？報酬率與 XIRR 的差異說明了什麼（例如加碼時機）？\n';
    sb += '- 集中度、波動與回撤是否在可承受範圍？\n';
    sb += '- 股利現金流的穩定度如何？\n\n';
  }
  if (inc('realized')) {
    sb += `## ${n++}. 交易行為分析\n`;
    sb += '- 已實現交易的勝率和平均報酬是否健康？有沒有「賺小賠大」或過度交易的跡象？\n\n';
  }
  if (inc('expenses')) {
    sb += `## ${n++}. 收支與儲蓄\n`;
    sb += '- 儲蓄率是否足夠？支出結構有無優化空間？\n\n';
  }
  sb += `## ${n}. 具體行動建議\n`;
  sb += '請根據上述分析，提供 3-5 個具體、可執行的建議，分成短期（1-3 個月）與中期（半年-1 年），並說明需要注意的風險。\n';
  return sb;
}

// ---------------------------------------------------------------- routes

route('POST', '/api/llm/prompt', async (req) => {
  let r = {};
  try { r = body(req); } catch { /* a malformed body means no options */ }
  return { prompt: await generateAutoPrompt(r.sections) };
});

