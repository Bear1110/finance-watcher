import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rollingYear, rollingSummary, sortino, dailyReturns, addDays } from '../js/server/twr_calc.js';

const daysFrom = (start, n) => Array.from({ length: n }, (_, i) => addDays(start, i));

test('rollingYear: value vs 365 days earlier; null without a full year or before data', () => {
  const dates = daysFrom('2024-01-01', 800);
  const values = dates.map((_, i) => (i < 10 ? null : 100 + i)); // starts on day 10
  const r = rollingYear(dates, values);
  assert.equal(r[364], null); // not a full year yet
  assert.equal(r[365], null); // a year back is before the data starts
  assert.equal(r[375], Math.round(((100 + 375) / (100 + 10) - 1) * 1e4) / 100);
  const s = rollingSummary(dates, r);
  assert.equal(s.negative_pct, 0);
  assert.equal(s.best_date, dates[375]); // growth slows as the base rises, so the first window is best
  assert.equal(rollingSummary(dates, dates.map(() => null)), null);
});

test('sortino: mean over downside deviation, annualized; needs 20 trading days and a down day', () => {
  // Weekdays only, alternating +2% / −1%
  const days = daysFrom('2025-01-06', 60);
  const growth = [1];
  const active = [0];
  for (let i = 1; i < days.length; i++) {
    const wd = new Date(days[i] + 'T00:00:00Z').getUTCDay();
    const r = wd === 0 || wd === 6 ? 0 : (i % 2 ? 0.02 : -0.01);
    growth.push(growth[i - 1] * (1 + r));
    active.push(i);
  }
  const s = sortino(dailyReturns({ growth, active }, days, 0, days.length - 1));
  assert.ok(s > 5, `strongly positive: ${s}`);
  const flatUp = sortino(dailyReturns({ growth: days.map((_, i) => 1.01 ** i), active: days.map((_, i) => i) }, days, 0, days.length - 1));
  assert.equal(flatUp, null); // never fell
});
