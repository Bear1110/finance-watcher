// AI analysis: builds a prompt from the user's data; the user takes it to their own AI
// (ChatGPT / Claude links or copy) — nothing is sent anywhere from here.

import * as db from './db.js';
import { route } from './router.js';
import { body, cmp, round2, storedUSDTWDRate, sellCostBasis, sellReturnPct, toTWD } from './util.js';
import { listHoldings } from './stocks.js';
import { expenseTWD } from './expenses.js';

// ---------------------------------------------------------------- data for the prompt



function buildRealizedSummary() {
  const rate = storedUSDTWDRate();
  const sells = db.where('stock_transactions', (t) => t.action === 'SELL' && t.account_id == null)
    .sort((a, b) => cmp(a.symbol, b.symbol) || cmp(a.date, b.date) || a.id - b.id);
  const bySymbol = new Map();
  for (const t of sells) {
    if (!bySymbol.has(t.symbol)) bySymbol.set(t.symbol, []);
    bySymbol.get(t.symbol).push(t);
  }

  const byStock = [];
  let overallPLTWD = 0;
  let totalTrades = 0;
  let wins = 0;
  let losses = 0;
  for (const [sym, trades] of bySymbol) {
    let totalShares = 0, totalRev = 0, totalPL = 0, totalCost = 0;
    const pcts = [];
    for (const t of trades) {
      const rev = t.shares * t.price;
      totalShares += t.shares;
      totalRev += rev;
      totalPL += t.realized_pl;
      totalCost += sellCostBasis(t);
      const pct = sellReturnPct(t); // null: no real cost (配股)
      if (pct != null) pcts.push(pct);
      if (t.realized_pl >= 0) wins++; else losses++;
    }
    totalTrades += trades.length;
    const avgRet = totalCost > 0 ? totalPL / totalCost * 100 : 0;
    const cur = trades[0].currency;
    overallPLTWD += toTWD(totalPL, cur, rate);
    byStock.push({
      symbol: sym, market: trades[0].market, total_trades: trades.length,
      total_shares_sold: totalShares, total_revenue: totalRev,
      total_cost: totalCost, total_realized_pl: totalPL,
      avg_return_pct: round2(avgRet), best_trade_pct: pcts.length ? round2(Math.max(...pcts)) : null, worst_trade_pct: pcts.length ? round2(Math.min(...pcts)) : null,
      currency: cur,
    });
  }
  return {
    by_stock: byStock,
    overall: {
      total_realized_pl_twd: overallPLTWD,
      usd_twd_rate: rate,
      total_trades: totalTrades,
      winning_trades: wins,
      losing_trades: losses,
      win_rate: totalTrades > 0 ? wins / totalTrades * 100 : 0,
    },
  };
}

export async function generateAutoPrompt(sections) {
  if (!Array.isArray(sections) || sections.length === 0) {
    sections = ['assets', 'portfolio', 'realized', 'expenses'];
  }
  const set = new Set(sections);
  const data = { usdTwdRate: storedUSDTWDRate(), sections: set, snapshots: [], expenses: [], portfolio: null, realized: null };
  const year = new Date().getFullYear();

  if (set.has('assets')) {
    data.snapshots = db.all('asset_snapshots')
      .sort((a, b) => cmp(b.date, a.date) || cmp(b.created_at, a.created_at) || b.id - a.id)
      .slice(0, 12);
  }
  if (set.has('portfolio')) data.portfolio = await listHoldings().catch(() => null);
  if (set.has('realized')) data.realized = buildRealizedSummary();
  if (set.has('expenses')) {
    data.expenses = db.where('expenses', (e) => e.date.startsWith(`${year}-`))
      .sort((a, b) => cmp(b.date, a.date) || a.id - b.id);
  }
  return generateFinancialPrompt(data);
}

// ---------------------------------------------------------------- prompt text

const f = (v, d) => Number(v).toFixed(d);
const sf = (v, d) => (v >= 0 ? '+' : '') + f(v, d);
const pctOrDash = (v) => (v == null ? '--' : sf(v, 2) + '%'); // null: no real cost (配股)
const CN_NUMS = ['一', '二', '三', '四', '五', '六', '七', '八'];

/** Build the analysis prompt. data.sections is a Set (null = all). */
export function generateFinancialPrompt(data) {
  let sb = `你是一位專業的個人財務顧問，服務對象是一位台灣的軟體工程師。
請根據以下完整的財務數據，提供深入且具體的分析和建議。
回答請使用繁體中文，數字請用千分位格式。

`;
  const inc = (k) => !data.sections || data.sections.has(k);
  let sn = 0;
  const secTitle = (title) => `# ${CN_NUMS[sn++]}、${title}\n\n`;

  // ===== 1. 資產總覽 =====
  if (inc('assets')) {
    sb += secTitle('資產總覽');
    const snaps = data.snapshots || [];
    if (snaps.length > 0) {
      const latest = snaps[0];
      sb += `最新快照日期: ${latest.date}\n`;
      sb += `- 台幣現金: NT$ ${f(latest.cash_twd, 0)}\n`;
      if (latest.cash_usd > 0) sb += `- 美金現金: US$ ${f(latest.cash_usd, 0)} (匯率 ${f(latest.usd_twd_rate, 2)})\n`;
      sb += `- 台股市值: NT$ ${f(latest.stock_tw_value, 0)}\n`;
      sb += `- 美股市值: NT$ ${f(latest.stock_us_value, 0)}\n`;
      sb += `- **總資產: NT$ ${f(latest.total_asset, 0)}**\n`;
      if (latest.other_assets > 0) sb += `- 其他資產（不動產、車等，自填）: NT$ ${f(latest.other_assets, 0)}\n`;
      sb += '\n';

      const total = latest.total_asset;
      if (total > 0) {
        const cashTotal = latest.cash_twd + latest.cash_usd * latest.usd_twd_rate;
        sb += '### 資產配置比例\n';
        sb += `- 現金: ${f(cashTotal / total * 100, 1)}%\n`;
        sb += `- 台股: ${f(latest.stock_tw_value / total * 100, 1)}%\n`;
        sb += `- 美股: ${f(latest.stock_us_value / total * 100, 1)}%\n\n`;
      }

      if (snaps.length >= 2) {
        sb += '### 資產成長趨勢（近期快照）\n\n';
        sb += '| 日期 | 總資產 | 較前期成長 |\n';
        sb += '|------|--------|----------|\n';
        const limit = Math.min(snaps.length, 12);
        for (let i = limit - 1; i >= 0; i--) {
          const s = snaps[i];
          let growth = '';
          if (i < snaps.length - 1) {
            const prev = snaps[i + 1];
            if (prev.total_asset > 0) growth = `${sf((s.total_asset - prev.total_asset) / prev.total_asset * 100, 1)}%`;
          }
          sb += `| ${s.date} | ${f(s.total_asset, 0)} | ${growth} |\n`;
        }
        sb += '\n';
        if (snaps.length > 12) {
          const yearAgo = snaps[12];
          if (yearAgo.total_asset > 0) {
            sb += `年化成長率 (YoY 約估): **${f((snaps[0].total_asset - yearAgo.total_asset) / yearAgo.total_asset * 100, 1)}%**\n\n`;
          }
        }
      }
    }
  }

  // ===== 2. 投資組合分析 =====
  if (inc('portfolio')) {
    sb += secTitle('投資組合分析');
    const p = data.portfolio || { holdings: [], total_cost_twd: 0, total_value_twd: 0, total_pl_twd: 0, total_pl_percent: 0, realized_pl_twd: 0 };
    sb += `- 總投入成本 (TWD): ${f(p.total_cost_twd, 0)}\n`;
    sb += `- 目前市值 (TWD): ${f(p.total_value_twd, 0)}\n`;
    sb += `- 未實現損益: ${f(p.total_pl_twd, 0)} (${f(p.total_pl_percent, 2)}%)\n`;
    sb += `- 已實現損益 (TWD): ${f(p.realized_pl_twd, 0)}\n\n`;
    if (p.holdings.length > 0) {
      sb += '### 持股明細（即時報價）\n\n';
      sb += '| 股票 | 市場 | 股數 | 均價 | 現價 | 市值(TWD) | 未實現損益(TWD) | 損益% | 佔比% |\n';
      sb += '|------|------|------|------|------|-----------|----------------|-------|-------|\n';
      for (const h of p.holdings) {
        const pct = p.total_value_twd > 0 ? h.market_value_twd / p.total_value_twd * 100 : 0;
        sb += `| ${h.symbol} | ${h.market} | ${f(h.shares, 0)} | ${f(h.avg_cost, 2)} | ${f(h.current_price, 2)} | ${f(h.market_value_twd, 0)} | ${sf(h.unrealized_pl_twd, 0)} | ${sf(h.pl_percent, 2)}% | ${f(pct, 1)}% |\n`;
      }
      sb += '\n';
      for (const h of p.holdings) {
        if (p.total_value_twd > 0) {
          const pct = h.market_value_twd / p.total_value_twd * 100;
          if (pct > 30) sb += `⚠️ **集中度警示**: ${h.symbol} 佔投資組合 ${f(pct, 1)}%，超過 30% 門檻\n`;
        }
      }
      sb += '\n';
    }
  }

  // ===== 3. 交易績效 =====
  if (inc('realized') && data.realized && data.realized.by_stock.length > 0) {
    sb += secTitle('交易績效（已實現損益）');
    const o = data.realized.overall;
    sb += `- 總交易次數: ${o.total_trades} 筆\n`;
    sb += `- 勝率: ${f(o.win_rate, 1)}% (${o.winning_trades} 勝 / ${o.losing_trades} 負)\n`;
    sb += `- 總已實現損益 (TWD): ${f(o.total_realized_pl_twd, 0)}\n\n`;
    sb += '### 各股交易績效\n\n';
    sb += '| 股票 | 市場 | 交易次數 | 已實現損益 | 平均報酬率 | 最佳% | 最差% |\n';
    sb += '|------|------|---------|-----------|----------|-------|-------|\n';
    for (const s of data.realized.by_stock) {
      const cur = s.currency === 'TWD' ? 'NT$' : 'US$';
      sb += `| ${s.symbol} | ${s.market} | ${s.total_trades} | ${cur} ${f(s.total_realized_pl, 0)} | ${sf(s.avg_return_pct, 2)}% | ${pctOrDash(s.best_trade_pct)} | ${pctOrDash(s.worst_trade_pct)} |\n`;
    }
    sb += '\n';
  }

  // ===== 4. 收支狀況 =====
  if (inc('expenses') && data.expenses && data.expenses.length > 0) {
    sb += secTitle('收支狀況');
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
    sb += `（資料期間內）總收入: NT$ ${f(totalIncome, 0)} / 總支出: NT$ ${f(totalExpense, 0)} / 淨儲蓄: NT$ ${f(totalIncome - totalExpense, 0)}\n\n`;
    if (totalIncome > 0) sb += `儲蓄率: ${f((totalIncome - totalExpense) / totalIncome * 100, 1)}%\n\n`;
    if (incomeCats.size > 0) {
      sb += '### 收入分類\n';
      for (const [cat, total] of incomeCats) sb += `- ${cat}: NT$ ${f(total, 0)}\n`;
      sb += '\n';
    }
    if (expenseCats.size > 0) {
      sb += '### 支出分類\n';
      for (const [cat, total] of expenseCats) sb += `- ${cat}: NT$ ${f(total, 0)}\n`;
      sb += '\n';
    }
  }

  // ===== 分析要求 =====
  sb += '# 請根據上述提供的資料，提供以下分析\n\n';
  let n = 1;
  if (inc('assets')) {
    sb += `## ${n++}. 資產配置評估\n`;
    sb += '- 現金 vs 股票的比例是否合理？以這位用戶的年齡層（約30歲上班族）來看是否適當？\n';
    sb += '- 台股 vs 美股的配置是否需要調整？\n';
    sb += '- 是否過度集中於某些個股？\n';
    sb += '- 從歷史快照來看，資產成長速度是否健康？成長主要來自存入的錢（薪水、別人給的）還是投資增值？\n\n';
  }
  if (inc('portfolio')) {
    sb += `## ${n++}. 投資績效評估\n`;
    sb += '- 持股的未實現損益狀況如何？\n';
    sb += '- 有哪些持股可能需要停損或加碼？\n';
    sb += '- 個股集中度是否有風險？\n\n';
  }
  if (inc('realized')) {
    sb += `## ${n++}. 交易績效分析\n`;
    sb += '- 已實現交易的勝率和平均報酬是否健康？\n';
    sb += '- 交易策略有什麼可以改進的地方？\n\n';
  }
  if (inc('expenses')) {
    sb += `## ${n++}. 收支與儲蓄建議\n`;
    sb += '- 儲蓄率是否足夠？\n';
    sb += '- 支出結構有無優化空間？\n\n';
  }
  sb += `## ${n}. 具體行動建議\n`;
  sb += '請根據上述分析，提供 3-5 個具體、可立即執行的理財建議，包括：\n';
  sb += '- 短期（1-3個月）該做什麼\n';
  sb += '- 中期（半年-1年）的調整方向\n';
  sb += '- 需要注意的風險和防範措施\n';
  return sb;
}

// ---------------------------------------------------------------- routes

route('POST', '/api/llm/prompt', async (req) => {
  let r = {};
  try { r = body(req); } catch { /* a malformed body means no options */ }
  return { prompt: await generateAutoPrompt(r.sections) };
});

