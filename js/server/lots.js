// FIFO lots, shared by the ledger replay (realized P&L, holdings, avg cost) and the
// performance replay (cost of what is held each day), so both use one rule:
// a lot's cost per share includes its buy fee; a sale takes the oldest lots first.
// No imports: the performance math stays testable without the DB.

/** A lot from a BUY: { shares, cost } with cost per share including the fee. */
export const lotFromBuy = (t) => ({ shares: t.shares, cost: (t.shares * t.price + t.fee) / t.shares });

/**
 * Take `shares` from the oldest lots (mutates them). Returns the cost of what was taken
 * and how many shares no lot covered.
 */
export function takeLots(lots, shares) {
  let left = shares;
  let cost = 0;
  while (left > 1e-9 && lots.length) {
    const take = Math.min(lots[0].shares, left);
    cost += take * lots[0].cost;
    lots[0].shares -= take;
    left -= take;
    if (lots[0].shares <= 1e-9) lots.shift();
  }
  return { cost, left: left > 1e-9 ? left : 0 };
}

/** Shares and total cost still held. */
export function lotsTotal(lots) {
  let shares = 0;
  let cost = 0;
  for (const l of lots) {
    shares += l.shares;
    cost += l.shares * l.cost;
  }
  return { shares, cost };
}

/**
 * Taiwan trading costs: brokerage fee 0.1425% × discount (at least NT$20 for a board lot, else NT$1)
 * and, on a sale, securities transaction tax 0.3% (ETFs, codes starting with 00: 0.1%). Rounded down
 * like a broker statement. Returns { fee, tax }.
 */
export function twTradeCost(symbol, action, shares, price, discount = 1) {
  const amount = shares * price;
  const fee = Math.max(shares >= 1000 ? 20 : 1, Math.floor(amount * 0.001425 * discount));
  const tax = action === 'SELL' ? Math.floor(amount * (symbol.startsWith('00') ? 0.001 : 0.003)) : 0;
  return { fee, tax };
}

/**
 * What selling a position now would cost (fee + tax, native currency), as a broker app deducts from
 * 未實現損益. Taiwan only: US costs are a few cents, so 0.
 */
export function estSellCost(market, symbol, shares, price, discount = 1) {
  if (market !== 'TW' || !(shares > 0) || !(price > 0)) return 0;
  const { fee, tax } = twTradeCost(symbol, 'SELL', shares, price, discount);
  return fee + tax;
}
