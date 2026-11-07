import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateFinancialPrompt } from '../js/server/llm.js';

const overview = {
  today: '2026-11-06', net_worth: 1_000_000, cash: { date: '2026-11-01' },
  parts: { cash_twd: 100_000, cash_usd: 0, tw: 900_000, us: 0, other: 0 },
  years: [{ year: 2026, current: true, start: 800_000, change: 200_000, price: 150_000, dividends: 20_000, other: 0, savings: 30_000 }],
  spending: { monthly_expense: 40_000, source: 'records', cash_months: 2.5 },
};

test('prompt: built from the app numbers, only markets held, data warnings, no personal assumptions', () => {
  const p = generateFinancialPrompt({
    sections: new Set(['assets', 'portfolio']), rate: 32, overview,
    holdings: { total_value_twd: 900_000, total_cost_twd: 700_000, total_pl_twd: 200_000, total_pl_percent: 28.57, realized_pl_twd: 0,
      holdings: [{ symbol: '0050.TW', market: 'TW', shares: 1000, avg_cost: 70, current_price: 90, market_value_twd: 900_000, unrealized_pl_twd: 200_000, pl_percent: 28.57 }] },
    portfolio: { rows: [{ symbol: '0050.TW', weight: 100 }], top3: 100, effective: 1, usd: { stock: 0, cash: 0, pct: 0 }, dividends: { ttm: 20_000, yield_cost: 2.86 } },
    perf: { markets: ['TW'], benchmarks: [{ symbol: '0050.TW', label: '台灣50 (0050)' }],
      periods: [{ key: 'ALL', label: '全部', start: '2020-01-01', days: 2500, markets: { ALL: { twr: 100, annualized: 10.6 } }, bench: { '0050.TW': 120 } }] },
    xirr: { ALL: { xirr: 12.3, first_date: '2020-01-01' }, TW: { flows: 5, xirr: 12.3 }, US: { flows: 1, xirr: null } },
    warnings: ['2 筆交易的成交價和當日收盤差很多'],
    expenses: [],
  });
  assert.match(p, /淨資產: NT\$ 1,000,000/);
  assert.match(p, /\| 2026（至今） \| 800,000 \| \+200,000 \| \+150,000 \| \+20,000 \| \+30,000 \|/);
  assert.match(p, /\| 期間 \| 全部 \| 台灣50 \(0050\) \|/); // one market: no 台股/美股 columns
  assert.match(p, /\+120\.00%（年化/); // the benchmark is annualized like the portfolio
  assert.match(p, /XIRR.*\+12\.30%（台股 \+12\.30%）/);
  assert.match(p, /# 資料提醒[\s\S]*成交價和當日收盤差很多/);
  assert.doesNotMatch(p, /軟體工程師|30歲/);
  assert.doesNotMatch(p, /收支與儲蓄/); // section not chosen
});

test('prompt: 已實現 section uses the same summary as the 已實現損益 page (flat trades counted apart)', async () => {
  const db = await import('../js/server/db.js');
  const { summarizeRealized } = await import('../js/server/stocks.js');
  db._reset({ stock_transactions: [
    { id: 1, symbol: 'AAA', market: 'TW', currency: 'TWD', action: 'SELL', shares: 1, price: 10, fee: 0, tax: 0, date: '2026-01-02', realized_pl: 5 },
    { id: 2, symbol: 'AAA', market: 'TW', currency: 'TWD', action: 'SELL', shares: 1, price: 10, fee: 0, tax: 0, date: '2026-01-03', realized_pl: 0 },
    { id: 3, symbol: 'AAA', market: 'TW', currency: 'TWD', action: 'SELL', shares: 1, price: 10, fee: 0, tax: 0, date: '2026-01-04', realized_pl: -2 },
  ] });
  const realized = summarizeRealized();
  assert.deepEqual([realized.trade_stats.ALL.wins, realized.trade_stats.ALL.losses, realized.trade_stats.ALL.flat], [1, 1, 1]);
  const p = generateFinancialPrompt({ sections: new Set(['realized']), rate: 30, realized, warnings: [], expenses: [] });
  assert.match(p, /勝率: 33\.3% \(1 勝 \/ 1 負 \/ 1 平\)/);
  assert.match(p, /\| AAA \| TW \| 3 \| NT\$ 3 \|/);
});

test('prompt: ETF look-through table, held-period note on a late market, fixed 行動總結', async () => {
  const { REST } = await import('../js/server/lookthrough.js');
  const p = generateFinancialPrompt({
    sections: new Set(['portfolio']), rate: 32, overview,
    holdings: { total_value_twd: 900_000, total_cost_twd: 700_000, total_pl_twd: 200_000, total_pl_percent: 28.57, realized_pl_twd: 0, holdings: [] },
    perf: { markets: ['TW', 'US'], benchmarks: [],
      rolling: { ALL: { best: 43.2, best_date: '2025-12-01', worst: -6.8, worst_date: '2025-05-02', median: 18.1, negative_pct: 12 } },
      periods: [{ key: 'ALL', label: '全部', start: '2020-01-01', days: 2500, bench: {},
        markets: { ALL: { twr: 100, annualized: 10.6, active_days: 2500 }, TW: { twr: 100, annualized: 10.6, active_days: 2500 }, US: { twr: 20, annualized: 18.8, active_days: 400 } } }] },
    lookthrough: {
      etf_total: 600_000, unresolved: [],
      before: { top: { symbol: '0050.TW', weight: 66.7 }, effective: 1.8 },
      after: { top: { symbol: '2330.TW', weight: 55.6 }, effective: 1.5 },
      rows: [
        { key: '2330.TW', name: '台積電', lumped: false, value: 500_000, weight: 55.6, direct: 300_000, via: { '0050.TW': 200_000 } },
        { key: REST, name: '其他成分股', lumped: true, value: 400_000, weight: 44.4, direct: 0, via: { '0050.TW': 400_000 } },
      ],
    },
    warnings: [], expenses: [],
  });
  assert.match(p, /\| 2330\.TW 台積電 \| 500,000 \| 55\.6% \| 50\.0% \| 300,000 \| 0050\.TW 200,000 \|/);
  assert.match(p, /其他成分股（前十大以外）/);
  assert.match(p, /穿透後最大單一公司 2330\.TW 佔股票 55\.6%/);
  assert.match(p, /\+20\.00%（年化 \+18\.80%，實際有持股約 1\.1 年）/);
  assert.doesNotMatch(p, /\+100\.00%（年化 \+10\.60%，實際/); // held the whole period: no note
  assert.match(p, /行動總結[\s\S]*A\. 立即處理[\s\S]*D\. 優先順序表/);
  assert.match(p, /\| 最差 \| -6\.80%（到 2025-05-02） \|/); // rolling 1-year: only the series that have it
  assert.match(p, /\| 抱一年虧錢的比例 \| 12% \|/);
});
