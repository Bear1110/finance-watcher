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
import { lookThroughData, REST, BOND } from './lookthrough.js';
import { allNames } from './names.js';
import { getProfile, missing, LABELS, CHOICES, BIG_EXPENSE_YEARS } from './profile.js';

// ---------------------------------------------------------------- data for the prompt

export async function generateAutoPrompt(sections) {
  if (!Array.isArray(sections) || sections.length === 0) {
    sections = ['assets', 'portfolio', 'realized', 'expenses'];
  }
  const set = new Set(sections);
  const year = new Date().getFullYear();
  const soft = (p) => p.catch(() => null); // a missing quote proxy only drops that part
  const overviewP = soft(buildOverview());
  const [built, perf, xirr, lookthrough] = await Promise.all([
    overviewP,
    set.has('portfolio') ? soft(performance()) : null,
    set.has('portfolio') ? soft(xirrHandler()) : null,
    // Reuses the overview's holdings instead of listing (and quoting) them again
    set.has('portfolio') ? overviewP.then((b) => b && soft(lookThroughData(b.stocks.holdings))) : null,
  ]);
  // The data check reads only the cached price history (no network); performance() above
  // refreshes it, so run the check after (without the portfolio section it uses what is cached).
  const checks = await soft(check());
  const { overview = null, stocks = null, portfolio = null } = built || {};
  return generateFinancialPrompt({
    sections: set,
    names: allNames(),
    profile: getProfile(),
    rate: storedUSDTWDRate(),
    overview,
    holdings: set.has('portfolio') ? stocks : null,
    portfolio: set.has('portfolio') ? portfolio : null,
    perf,
    xirr,
    lookthrough,
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

/** 「關於你」: what only the user knows. Not a selectable section: included whenever anything is filled in. */
function profileSection(data) {
  const p = data.profile;
  if (!p) return null;
  const miss = missing(p);
  if (miss.length === Object.keys(LABELS).length && !p.bonus && !p.note) return null;
  const year = data.year || new Date().getFullYear();
  const nw = data.overview && data.overview.net_worth;
  let sb = p.updated_at ? `使用者自己填的，最後更新 ${p.updated_at}。\n\n` : '';
  if (p.birth_year) sb += `- 年齡：約 ${year - p.birth_year} 歲\n`;
  const pay = [p.income && `稅後月收入 NT$ ${money(p.income)}`, p.bonus && `年終／獎金每年約 NT$ ${money(p.bonus)}`].filter(Boolean);
  if (pay.length) sb += `- 收入：${pay.join('；')}\n`;
  if (p.monthly_expense) {
    sb += `- 每月生活費：NT$ ${money(p.monthly_expense)}`;
    if (p.income) sb += `（收入扣掉生活費，每月約可存 NT$ ${money(p.income - p.monthly_expense + (p.bonus || 0) / 12)}${p.bonus ? '，含年終平均' : ''}）`;
    sb += '\n';
  }
  if (p.stability) sb += `- 收入穩定度：${CHOICES.stability[p.stability][1]}\n`;
  if (p.goal) sb += `- 投資目標：${CHOICES.goal[p.goal][1]}\n`;
  if (p.max_drawdown) sb += `- 可接受的最大跌幅：淨資產 -${p.max_drawdown}%${nw > 0 ? `（約 NT$ ${money(nw * p.max_drawdown / 100)}）` : ''}，仍能持續投入、不會賣出\n`;
  if (p.big_expenses) {
    sb += p.big_expenses.length
      ? `- 未來大筆支出：${p.big_expenses.map((e) => `${e.year} 年${e.what ? ` ${e.what}` : ''} NT$ ${money(e.amount)}（約 ${e.year - year} 年後）`).join('；')}\n`
      : `- 未來 ${BIG_EXPENSE_YEARS} 年沒有計畫中的大筆支出\n`;
  }
  if (p.note) sb += `- 補充：${p.note}\n`;
  if (miss.length) sb += `\n沒填：${miss.map((k) => LABELS[k]).join('、')}。需要這些才能判斷時，請先說明你的假設，或列出想問使用者的問題。\n`;
  return ['使用者財務狀況', sb + '\n'];
}

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
      sb += `| ${stock(data, x.symbol)} | ${x.market} | ${f(x.shares, 0)} | ${f(x.avg_cost, 2)} | ${f(x.current_price, 2)} | ${money(x.market_value_twd)} | ${smoney(x.unrealized_pl_twd)} | ${pct(x.pl_percent)} | ${f(w, 1)}% |\n`;
    }
    sb += '\n';
  }
  const pf = data.portfolio;
  if (pf) {
    const top = pf.rows[0];
    sb += '### 集中度與配置\n';
    sb += `- 最大持股 ${stock(data, top.symbol)} 佔 ${f(top.weight, 1)}%；前 3 大合計 ${f(pf.top3, 1)}%（App 以 25% 為偏高、40% 為高度集中）\n`;
    sb += `- 等效持股數 ${f(pf.effective, 1)} 檔（實際持有 ${pf.rows.length} 檔；1 ÷ Σ權重²，越小越集中）\n`;
    if (pf.usd.pct != null && pf.usd.stock + (pf.usd.cash || 0) > 0) sb += `- 美元資產佔淨資產 ${f(pf.usd.pct, 1)}%\n`;
    sb += `- 近 12 個月股利 NT$ ${money(pf.dividends.ttm)}${pf.dividends.yield_cost != null ? `，以持有成本計殖利率 ${f(pf.dividends.yield_cost, 2)}%` : ''}\n\n`;
  }
  const perf = data.perf;
  if (perf && perf.periods && perf.periods.length) {
    const segs = ['ALL', ...((perf.markets || []).length > 1 ? perf.markets : [])];
    const benches = perf.benchmarks || [];
    const want = perf.periods.filter((p) => ['YTD', '1Y', 'ALL'].includes(p.key));
    sb += '### 報酬率（時間加權 TWR：只看持股本身表現，不受加碼時機影響；含股利與匯率）\n';
    sb += '年化只算該市場實際有持股的天數（中間全部賣光、沒有持股的期間不算），所以起步較晚的市場年化期間比表頭的起始日短。\n\n';
    sb += `| 期間 | ${segs.map((s) => MARKET_NAME[s]).join(' | ')} | ${benches.map((b) => b.label).join(' | ')} |\n`;
    sb += `|------|${segs.map(() => '------').join('|')}|${benches.map(() => '------').join('|')}|\n`;
    for (const p of want) {
      const held = (r) => (r.active_days != null && r.active_days < p.days * 0.9 ? `，實際有持股約 ${f(r.active_days / 365, 1)} 年` : '');
      const cell = (r) => (r && r.twr != null ? `${pct(r.twr)}${p.key === 'ALL' && r.annualized != null ? `（年化 ${pct(r.annualized)}${held(r)}）` : ''}` : '--');
      const benchCell = (v) => (v == null ? '--' : `${pct(v)}${p.key === 'ALL' && annualizePct(v, p.days) != null ? `（年化 ${pct(annualizePct(v, p.days))}）` : ''}`);
      sb += `| ${p.label}（自 ${p.start}） | ${segs.map((s) => cell(p.markets[s])).join(' | ')} | ${benches.map((b) => benchCell(p.bench[b.symbol])).join(' | ')} |\n`;
    }
    const y1 = perf.periods.find((p) => p.key === '1Y');
    const r1 = y1 && y1.markets.ALL;
    if (r1 && r1.twr != null) {
      const sortino = r1.sortino == null ? '' : `、Sortino 比率 ${f(r1.sortino, 2)}（年化報酬 ÷ 下跌日的波動，無風險利率以 0 計）`;
      sb += `\n近 1 年最大回撤 ${pct(r1.max_drawdown)}、年化波動度 ${r1.volatility == null ? '--' : f(r1.volatility, 1) + '%'}${sortino}。\n`;
    }
    const roll = perf.rolling || {};
    if (roll.ALL) {
      const keys = [...segs, ...benches.map((b) => b.symbol)].filter((k) => roll[k]);
      const labels = { ...MARKET_NAME, ...Object.fromEntries(benches.map((b) => [b.symbol, b.label])) };
      const label = (k) => labels[k];
      const row = (name, cell) => `| ${name} | ${keys.map((k) => cell(roll[k])).join(' | ')} |\n`;
      sb += '\n### 滾動一年報酬（每一天往回看整整一年的 TWR，也就是「任何時候抱一年」的結果分布）\n\n';
      sb += `| | ${keys.map(label).join(' | ')} |\n|---|${keys.map(() => '---').join('|')}|\n`;
      sb += row('最好', (r) => `${pct(r.best)}（到 ${r.best_date}）`);
      sb += row('最差', (r) => `${pct(r.worst)}（到 ${r.worst_date}）`);
      sb += row('中位數', (r) => pct(r.median));
      sb += row('抱一年虧錢的比例', (r) => `${f(r.negative_pct, 0)}%`);
    }
    sb += '\n';
  }
  const x = data.xirr;
  if (x && x.ALL && x.ALL.xirr != null) {
    const marks = ['TW', 'US'].filter((m) => x[m] && x[m].flows > 1 && x[m].xirr != null).map((m) => `${MARKET_NAME[m]} ${pct(x[m].xirr)}`);
    sb += `累計年化報酬 XIRR（以實際投入金額與時點計算，自 ${(x.ALL.first_date || '').slice(0, 7)} 起）: ${pct(x.ALL.xirr)}${marks.length ? `（${marks.join('、')}）` : ''}\n`;
    sb += 'XIRR 的現金流：買進為投入、賣出與現金股利為取回，期末以目前市值當作取回，美股依各筆交易當時匯率換成台幣。和 TWR 差很多時，代表投入的時點和金額影響很大（例如大筆資金在高點投入），不一定是計算錯誤。\n\n';
  }
  const lt = lookThroughSection(data);
  if (lt) sb += lt;
  return ['股票投資組合', sb];
}

const LT_ROWS = 10;

/** "2330 台積電" (names.js; `fallback` when it has none, e.g. Yahoo's name of an ETF holding). */
const stock = (data, symbol, fallback = '') => [symbol, data.names?.[symbol] || fallback].filter(Boolean).join(' ');

/** ETF 穿透: each company's total weight, direct plus held through ETFs (top 10 holdings of each ETF). */
function lookThroughSection(data) {
  const lt = data.lookthrough;
  if (!(lt && lt.etf_total > 0)) return '';
  const nw = data.overview && data.overview.net_worth;
  const nwPct = (v) => (nw > 0 ? `${f(v / nw * 100, 1)}%` : '--');
  let sb = '### ETF 穿透後的公司曝險\n';
  sb += 'ETF 依各自的前十大成分股拆開，和直接持有的同一家公司合併（ADR 併入台股，例如 TSM 算台積電）；前十大以外的部分合成「其他成分股」。\n\n';
  sb += `- 穿透前最大持股 ${stock(data, lt.before.top.symbol)} 佔股票 ${f(lt.before.top.weight, 1)}%，等效持股 ${f(lt.before.effective, 1)} 檔\n`;
  if (lt.after) sb += `- 穿透後最大單一公司 ${stock(data, lt.after.top.symbol)} 佔股票 ${f(lt.after.top.weight, 1)}%，等效持股 ${f(lt.after.effective, 1)} 檔\n`;
  sb += '\n| 公司 | 合計(TWD) | 佔股票% | 佔淨資產% | 直接持有 | 經由 ETF |\n';
  sb += '|------|-----------|--------|----------|---------|---------|\n';
  const name = (r) => (r.key === REST ? '其他成分股（前十大以外）' : r.key === BOND ? '債券' : stock(data, r.key, r.name));
  const via = (r) => Object.entries(r.via).sort((a, b) => b[1] - a[1]).map(([etf, v]) => `${etf} ${money(v)}`).join('、') || '--';
  const named = lt.rows.filter((r) => !r.lumped).slice(0, LT_ROWS);
  for (const r of [...named, ...lt.rows.filter((r) => r.lumped)]) {
    sb += `| ${name(r)} | ${money(r.value)} | ${f(r.weight, 1)}% | ${nwPct(r.value)} | ${r.direct > 0 ? money(r.direct) : '--'} | ${via(r)} |\n`;
  }
  if (lt.unresolved.length) sb += `\n查不到成分股、當成單一持股計算：${lt.unresolved.join('、')}\n`;
  return sb + '\n';
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
    sb += `| ${stock(data, s.symbol)} | ${s.market} | ${s.total_trades} | ${cur} ${money(s.total_realized_pl)} | ${pct(s.avg_return_pct)} | ${pct(s.best_trade_pct)} | ${pct(s.worst_trade_pct)} |\n`;
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
`;
  const profile = profileSection(data);
  // Without 使用者財務狀況 the AI has to guess these; with it, its own 沒填 line says what is missing
  if (!profile) sb += '需要年齡、收入穩定度、理財目標等資訊才能判斷時，請先說明你的假設，或列出想問使用者的問題。\n';
  sb += '\n';
  const sections = [profile, ...[['assets', assetsSection], ['portfolio', portfolioSection], ['realized', realizedSection], ['expenses', expensesSection]]
    .filter(([key]) => inc(key)).map(([, build]) => build(data))].filter(Boolean);
  sections.forEach(([title, text], i) => { sb += `# ${CN_NUMS[i]}、${title}\n\n${text}`; });

  // ===== 資料提醒 =====
  if (data.warnings && data.warnings.length) {
    sb += '# 資料提醒\n以下資料問題可能讓部分數字失真，分析時請考慮：\n';
    sb += data.warnings.map((w) => `- ${w}`).join('\n') + '\n\n';
  }

  // ===== 分析原則 =====
  sb += `# 分析原則
- 先講核心結論，再給數據與推論；清楚區分「資料事實」「推論」「假設」。
- 只根據上面的資料。缺少會影響判斷的資訊時，列出你的假設或想問的問題，不要捏造。
- 區分「需要行動的問題」與「值得觀察的變化」；不要只因為短期漲跌就建議買賣。
- 判斷集中度時以 ETF 穿透後的公司曝險為準，不只看持有幾檔 ETF。
- 建議要考慮交易成本、稅與匯率，盡量給具體金額、比例與步驟；優先考慮用新投入的資金調整配置。
- 簡潔、務實，不必稱讚，有風險就直接指出。

`;

  // ===== 分析要求 =====
  sb += '# 請根據上述資料提供以下分析\n\n';
  let n = 1;
  if (inc('assets')) {
    sb += `## ${n++}. 資產配置評估\n`;
    if (profile) sb += '- 依使用者的財務狀況（年齡、收入、可接受的跌幅、未來大筆支出），目前的股票比例與現金是否合適？要用到的大筆支出是否該避開股票風險？\n';
    sb += '- 現金、台股、美股（與其他資產）的比例是否合理？現金是否足夠當緊急預備金？\n';
    sb += '- 美元資產比例帶來的匯率風險是否需要注意？\n';
    sb += '- 從每年淨資產變化來看，成長主要來自投資（股價、股利）還是存入？這個結構健康嗎？\n\n';
  }
  if (inc('portfolio')) {
    sb += `## ${n++}. 投資組合評估\n`;
    sb += '- 和大盤（0050、S&P 500）相比表現如何？報酬率與 XIRR 的差異說明了什麼（例如加碼時機）？\n';
    sb += '- 集中度（含 ETF 穿透後的單一公司曝險）、波動與回撤是否在可承受範圍？\n';
    sb += '- 股利現金流的穩定度如何？\n\n';
  }
  if (inc('realized')) {
    sb += `## ${n++}. 交易行為分析\n`;
    sb += '- 從勝率、獲利因子、賺賠比與每筆期望值看，交易品質如何？有沒有「賺小賠大」或過度交易的跡象？\n\n';
  }
  if (inc('expenses')) {
    sb += `## ${n++}. 收支與儲蓄\n`;
    sb += '- 儲蓄率是否足夠？支出結構有無優化空間？\n\n';
  }
  sb += `## ${n}. 行動總結（最重要，一定要有）
- **A. 立即處理**：已經存在、會影響財務安全或組合風險的問題（沒有就寫「無」）。
- **B. 短期（1～3 個月）**：每項寫清楚要做什麼、為什麼、怎麼做、要注意的風險。
- **C. 中期（6～12 個月）**：需要逐步調整的配置或策略。
- **D. 優先順序表**：| 優先順序 | 行動 | 建議時間 | 原因 |，最多 3～5 項，不要為了湊數提出不必要的交易。
- **E. 值得觀察、暫不需要行動**的事項，一句話說明為什麼先不動。
`;
  return sb;
}

// ---------------------------------------------------------------- routes

route('POST', '/api/llm/prompt', async (req) => {
  let r = {};
  try { r = body(req); } catch { /* a malformed body means no options */ }
  return { prompt: await generateAutoPrompt(r.sections) };
});

