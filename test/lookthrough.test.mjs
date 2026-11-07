import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lookThrough, REST, BOND } from '../js/server/lookthrough.js';

const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} ≈ ${b}`);
const h = (symbol, value) => ({ symbol, market: /\.TW$/.test(symbol) ? 'TW' : 'US', market_value_twd: value });
const fund = (holdings, extra = {}) => ({ is_fund: true, name: '', holdings: holdings.map(([symbol, weight]) => ({ symbol, name: symbol + ' Inc', weight })), bond: 0, ...extra });

test('lookThrough: direct + ETF parts add up per stock and keep their sources', () => {
  const r = lookThrough({
    holdings: [h('0050.TW', 1000), h('006208.TW', 500), h('2330.TW', 500)],
    funds: {
      '0050.TW': fund([['2330.TW', 0.5], ['2454.TW', 0.1]]),
      '006208.TW': fund([['2330.TW', 0.6]]),
    },
  });
  const tsmc = r.rows[0];
  assert.equal(tsmc.key, '2330.TW');
  close(tsmc.direct, 500);
  close(tsmc.from_etf, 800);
  assert.deepEqual(tsmc.via, { '0050.TW': 500, '006208.TW': 300 });
  assert.deepEqual(tsmc.held_as, ['2330.TW']);
  close(tsmc.weight, 65);
  close(tsmc.etf_weight, 800 / 1500 * 100);
  assert.equal(tsmc.level, 'danger');

  const mtk = r.rows.find((x) => x.key === '2454.TW');
  close(mtk.direct, 0);
  close(mtk.from_etf, 100);
  assert.equal(mtk.name, '2454.TW Inc');

  // Unlisted part of each ETF goes to one "rest" row, always last
  const rest = r.rows.at(-1);
  assert.equal(rest.key, REST);
  assert.deepEqual(rest.via, { '0050.TW': 400, '006208.TW': 200 });

  close(r.total, 2000);
  close(r.etf_total, 1500);
  close(r.direct_total, 500);
  // Values are conserved
  close(r.rows.reduce((s, x) => s + x.value, 0), 2000);
  close(r.rows.reduce((s, x) => s + x.etf_weight, 0), 100);

  assert.equal(r.before.top.symbol, '0050.TW');
  close(r.before.top.weight, 50);
  assert.equal(r.before.top.level, 'danger');
  close(r.before.effective, 1 / (0.25 + 0.0625 + 0.0625));
  assert.equal(r.after.top.symbol, '2330.TW');
  close(r.after.top.weight, 65);
  assert.equal(r.after.top.level, 'danger');
  assert.equal(rest.lumped, true);
  assert.equal(tsmc.lumped, false);
  close(r.after.effective, 1 / (0.65 ** 2 + 0.05 ** 2)); // rest row left out
});

test('lookThrough: ADR merges into the Taiwan listing; bond ETFs and failed lookups', () => {
  const r = lookThrough({
    holdings: [h('TSM', 300), h('VOO', 1000), h('BND', 200), h('MYSTERY', 100)],
    funds: {
      TSM: { is_fund: false, holdings: [] },
      VOO: fund([['NVDA', 0.08], ['TSM', 0.01]]),
      BND: fund([], { bond: 0.99 }),
      MYSTERY: null,
    },
  });
  const tsmc = r.rows.find((x) => x.key === '2330.TW');
  close(tsmc.direct, 300);
  close(tsmc.from_etf, 10);
  assert.deepEqual(tsmc.held_as, ['TSM']);
  assert.equal(tsmc.market, 'TW');

  const bond = r.rows.find((x) => x.key === BOND);
  assert.deepEqual(bond.via, { BND: 200 });
  assert.equal(bond.level, '');

  assert.deepEqual(r.unresolved, ['MYSTERY']);
  const m = r.rows.find((x) => x.key === 'MYSTERY');
  assert.equal(m.kind, 'unresolved');
  close(m.direct, 100);

  assert.deepEqual(r.etfs.map((e) => e.symbol), ['VOO', 'BND']);
  close(r.etfs[0].listed, 0.09);
});

test('lookThrough: no ETFs → same as holdings; nothing priced → null', () => {
  const r = lookThrough({ holdings: [h('AAPL', 300), h('MSFT', 100)], funds: {} });
  assert.equal(r.etf_total, 0);
  assert.equal(r.etfs.length, 0);
  close(r.before.effective, r.after.effective);
  assert.equal(lookThrough({ holdings: [h('AAPL', 0)], funds: {} }), null);
});
