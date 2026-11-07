import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as db from '../js/server/db.js';
import { getProfile, updateProfile, missing } from '../js/server/profile.js';
import { generateFinancialPrompt } from '../js/server/llm.js';

const year = new Date().getFullYear();

test('profile: saved as one setting, 生活費 shared with the dashboard setting, validation', () => {
  db._reset({});
  assert.equal(missing(getProfile()).length, 7);
  const p = updateProfile({ birth_year: String(year - 30), income: '100000', monthly_expense: '30000', max_drawdown: '-30', big_expenses: [] });
  assert.equal(p.birth_year, year - 30);
  assert.equal(p.max_drawdown, 30); // sign doesn't matter
  assert.equal(db.getSetting('monthly_expense'), '30000');
  assert.deepEqual(p.big_expenses, []); // answered "none", unlike null
  assert.deepEqual(missing(p), ['stability', 'goal']);
  assert.equal(updateProfile({ income: '' }).income, null); // clearing a field
  assert.throws(() => updateProfile({ stability: 'rich' }), /選項不正確/);
  assert.throws(() => updateProfile({ big_expenses: [{ year: year + 2, amount: 0 }] }), /金額/);
  assert.throws(() => updateProfile({ birth_year: '1800' }), /出生年份/);
});

test('prompt: 使用者財務狀況 first, missing fields listed, no generic assumption line', () => {
  const profile = { birth_year: year - 30, income: 100_000, bonus: 120_000, monthly_expense: 30_000, stability: 'stable', goal: null,
    max_drawdown: 30, big_expenses: [{ year: year + 3, amount: 3_000_000, what: '買房' }], note: '', updated_at: `${year}-11-07` };
  const overview = { today: `${year}-11-07`, net_worth: 10_000_000, cash: { date: `${year}-11-01` },
    parts: { cash_twd: 1_000_000, cash_usd: 0, tw: 9_000_000, us: 0, other: 0 }, years: [], spending: {} };
  const p = generateFinancialPrompt({ sections: new Set(['assets']), rate: 32, profile, overview, year, warnings: [], expenses: [] });
  assert.match(p, /# 一、使用者財務狀況[\s\S]*# 二、資產總覽/);
  assert.match(p, /年齡：約 30 歲/);
  assert.match(p, /每月約可存 NT\$ 80,000，含年終平均/); // 100k − 30k + 120k / 12
  assert.match(p, /淨資產 -30%（約 NT\$ 3,000,000）/);
  assert.ok(p.includes(`${year + 3} 年 買房 NT$ 3,000,000（約 3 年後）`));
  assert.match(p, /沒填：投資目標。/);
  assert.doesNotMatch(p, /需要年齡、收入穩定度/);
  assert.match(p, /依使用者的財務狀況/);

  const empty = generateFinancialPrompt({ sections: new Set(['assets']), rate: 32, profile: (db._reset({}), getProfile()), overview, warnings: [], expenses: [] });
  assert.doesNotMatch(empty, /使用者財務狀況/);
  assert.match(empty, /需要年齡、收入穩定度/);
});

test('stressTest: hit to net worth per drop, over the user limit, cash vs expenses within 5 years', async () => {
  const { stressTest } = await import('../js/server/profile.js');
  const st = stressTest({ stock: 13_676_000, netWorth: 14_206_000, cash: 530_000, year: 2026,
    profile: { max_drawdown: 30, big_expenses: [{ year: 2029, amount: 3_000_000, what: '買房' }, { year: 2040, amount: 5_000_000, what: '退休' }] } });
  assert.deepEqual(st.drops.map((d) => d.drop), [20, 30, 40]);
  assert.ok(Math.abs(st.drops[1].nw_pct - 28.88) < 0.01);
  assert.deepEqual(st.drops.map((d) => d.over), [false, false, true]);
  assert.deepEqual(st.big.map((e) => e.what), ['買房']); // 2040 is beyond 5 years
  assert.equal(st.shortfall, 2_470_000);
  assert.ok(Math.abs(st.sale_at_drop - 2_470_000 / 0.7) < 1); // stock to sell after a 30% drop
  assert.deepEqual(stressTest({ stock: 100, netWorth: 200, cash: null, year: 2026, profile: {} }).drops.map((d) => d.over), [false, false, false]); // no limit set
  assert.equal(stressTest({ stock: 0, netWorth: 200, cash: 0, year: 2026, profile: {} }), null);
});
