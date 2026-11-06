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
