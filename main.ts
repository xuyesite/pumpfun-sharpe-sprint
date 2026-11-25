// Pump.fun Sharpe Sprint — Cleanest Paper Bot Wins.
//
// FINAL (variant A, revised): tight-slippage momentum scalper.
//
// What the data showed (dev window, full 24h, offline replay + real grade-local
// of the kit's own baselines):
//   - Every coin pumps in its first minute and then bleeds back toward its
//     creation price (the bonding curve can never trade below it). Buying
//     after the pump has already run is buying the top: the old momentum bot
//     (v8: TP +20% / SL -5% / hold 600s) won only 14% of round trips.
//   - The 2-slot fill latency is the killer for early entries: the median
//     fill lands 15.6% above the decision price in the launch burst, so a
//     sniper that buys the first tradeable moment fills at the top. Dip
//     buying is worse (dips keep falling: 60%+ hit -10% before +15%), and
//     breakout buying on big curves loses hardest of all.
//   - The one filter that measurably helps is BUY SLIPPAGE: a fill may only
//     proceed when the curve has barely moved in the 2-slot latency window.
//     Tightening buy slippage 500 -> 200 -> 100 -> 50 bps monotonically cut
//     the offline loss (fewer spike-chase fills; rejected orders cost
//     nothing) and lifted the win rate from 14% to 22%.
//   - Small, fast exits bank what little edge remains: TP +12% (not +20%,
//     which almost never hit), SL -4%, a trailing stop that arms at +3%
//     and banks on a 2% pullback, and a 300s maximum hold so dead coins are
//     not carried through the bleed.
//
// Revision vs variant A: sells now use fully open slippage (10000bps).
// A stop-loss exit must land on the first attempt: a sell rejected for
// slippage in a crash is only retried lower and lower, so the exit that
// finally fills is worse than the one that was refused. Buys stay tight
// (50bps) — the asymmetry is the point: be picky entering, be immediate
// leaving.
//
// Graded on dev (real grade-local): variant A PnL -0.0146 SOL, Sharpe
// -0.52, win 16.1%, 31 round trips / 31 distinct mints, max drawdown 0.16%.
// Still below hold cash (not prize-eligible): no variant tested so far
// reaches net PnL > 0 on this window — see the iteration log for the full
// list (sniper -2.51 SOL, partial-TP -0.0198, dip/breakout far worse
// offline). This is the closest-to-breakeven variant found.
//
// Wire: agent-fun/replay/v2 over stdin/stdout, via the kit's shim in
// vendor/makefun-bot.ts. The harness sends hello, then one batch per slot
// (events, marks, fills, account), then done. We answer each batch with at
// most one reply listing our orders. Everything is deterministic: no clock,
// no environment, no Math.random — only the replay's own slots and times.

import { runBot, LAMPORTS_PER_SOL } from "./vendor/makefun-bot.ts";
import type { Batch, BotState } from "./vendor/makefun-bot.ts";

// ------------------------------------------------------------------ tuning

const SOL = LAMPORTS_PER_SOL; // 1_000_000_000n
const TARGET_POSITION = 100_000_000n; // 0.10 SOL per mint, built up over batches
const INITIAL_BUY = 50_000_000n; // 0.05 SOL first buy; the 1% reserve cap usually binds first
const MIN_BUY = 10_000_000n; // 0.01 SOL: the round-trip minimum, and the smallest size worth the tx fee.
const CASH_BUFFER = 50_000_000n; // 0.05 SOL kept free so sells can always pay fees
const MAX_NEW_BUYS_PER_BATCH = 3; // spread entries over time, avoid one-slot pileups

const MIN_TRADES = 1; // enter as soon as the 1% size cap allows a real buy: the edge is in the first trades
const MIN_RISE = -0.01; // price must not already be dumping (>= -1% vs first sight)
const MAX_RISE = 0.08; // ... and must not already have run up: only slow, steady risers qualify
const RECENT_RISE = 0.0; // price now at least flat vs 2 trades ago (no fresh downtrend)
const MIN_BUY_SHARE = 3; // at least 3 of the last 5 trades are buys
const MAX_AGE_SEC = 1800; // only coins first seen within the last 30 minutes
const TOPUP_MAX_RISE = 0.05; // top up only while the price is still within 5% of first sight:
// adding to a position after it already ran up buys the top, and that bled v3 dry.

const TAKE_PROFIT = 1.12; // sell at +12% vs cost (v8's +20% almost never hit; bank sooner)
const STOP_LOSS = 0.96; // sell at -4% vs cost
const TRAILING_ARM = 1.03; // trailing stop arms once up 3%
const TRAILING_DROP = 0.02; // ... then sell on a 2% pullback from the peak
const FAST_DUMP = -0.1; // sell on a 10% drop over the last 5 trades (rug guard)
const MAX_HOLD_SEC = 300; // never hold longer than 5 minutes (the bleed after the pump is fast)
const COOLDOWN_SEC = 300; // after selling a mint, do not re-enter it for 5 minutes

// Slippage is asymmetric on purpose. Buys are tight: a fill that lands more
// than 0.5% worse than the decision-time curve means the coin spiked in the
// 2-slot latency window and we would be buying the top of the spike —
// reject it for free and retry on the next trade. Sells are fully open: a
// stop-loss exit must land on the first attempt, never be retried lower.
const BUY_SLIPPAGE_BPS = 50; // 0.5%
const SELL_SLIPPAGE_BPS = 10000; // 100%: exits always execute

// ------------------------------------------------------------------ per-mint tape

interface MintStat {
  firstPrice: number;
  firstTime: number;
  lastTime: number;
  trades: number;
  prices: number[]; // last up to 10 trade prices, oldest first
  buys: boolean[]; // last up to 10 trade sides, oldest first
}

interface PosMeta {
  entryTime: number;
  peakRatio: number; // best mark value / cost seen since entry
  firstPrice: number; // the mint's price when first seen: top-ups only while near it
}

const stats = new Map<string, MintStat>();
const meta = new Map<string, PosMeta>();
const cooldownUntil = new Map<string, number>();
const tradedMints = new Set<string>();
let nowSec = 0;
let buysSent = 0;
let sellsSent = 0;
let batchesSeen = 0;

function priceOf(state: BotState, mint: string): number {
  const curve = state.curves.get(mint);
  if (curve === undefined) return 0;
  const tokens = Number(curve.virtual_token_reserves);
  if (tokens <= 0) return 0;
  return Number(curve.virtual_quote_reserves) / tokens;
}

function ringPush<T>(arr: T[], value: T, max: number): void {
  arr.push(value);
  if (arr.length > max) arr.shift();
}

/** Fold this batch's events into the per-mint tape. */
function observe(batch: Batch): void {
  for (const event of batch.events) {
    const t = event.block_time ?? nowSec;
    if (t > nowSec) nowSec = t;
    if (event.event === "CreateEvent") {
      const price =
        Number(event.virtual_quote_reserves) / Number(event.virtual_token_reserves);
      let stat = stats.get(event.mint);
      if (stat === undefined) {
        stat = { firstPrice: price, firstTime: t, lastTime: t, trades: 0, prices: [], buys: [] };
        stats.set(event.mint, stat);
      }
      stat.lastTime = t;
    } else if (event.event === "TradeEvent") {
      const price =
        Number(event.virtual_sol_reserves) / Number(event.virtual_token_reserves);
      let stat = stats.get(event.mint);
      if (stat === undefined) {
        stat = { firstPrice: price, firstTime: t, lastTime: t, trades: 0, prices: [], buys: [] };
        stats.set(event.mint, stat);
      }
      stat.trades += 1;
      stat.lastTime = t;
      ringPush(stat.prices, price, 10);
      ringPush(stat.buys, event.is_buy, 10);
    }
  }
}

function buyShare(stat: MintStat): number {
  // Buys among the last 5 trades (or fewer, early on).
  const recent = stat.buys.slice(-5);
  let n = 0;
  for (const b of recent) if (b) n += 1;
  return n;
}

/** Is this mint a fresh, buy-led, not-yet-run-up buy right now? */
function entrySignal(stat: MintStat): boolean {
  if (stat.trades < MIN_TRADES) return false;
  if (nowSec - stat.firstTime > MAX_AGE_SEC) return false;
  const prices = stat.prices;
  if (prices.length < 3) return false;
  const now = prices[prices.length - 1];
  if (!(now > 0) || !(stat.firstPrice > 0)) return false;
  const rise = now / stat.firstPrice - 1;
  if (rise < MIN_RISE || rise > MAX_RISE) return false;
  const twoAgo = prices[prices.length - 3];
  if (now / twoAgo - 1 < RECENT_RISE) return false;
  if (buyShare(stat) < MIN_BUY_SHARE) return false;
  return true;
}

function hasPendingBuy(state: BotState, mint: string): boolean {
  for (const p of state.pending.values()) {
    if (p.order.side === "buy" && p.order.mint === mint) return true;
  }
  return false;
}

function hasPendingSell(state: BotState, mint: string): boolean {
  for (const p of state.pending.values()) {
    if (p.order.side === "sell" && p.order.mint === mint) return true;
  }
  return false;
}

// ------------------------------------------------------------------ the bot

await runBot({
  onBatch(state, batch) {
    batchesSeen += 1;
    observe(batch);

    // Drop bookkeeping for positions the harness already closed (complete/flatten).
    for (const mint of [...meta.keys()]) {
      if (!state.positions.has(mint)) meta.delete(mint);
    }
    for (const mint of [...cooldownUntil.keys()]) {
      if (nowSec >= (cooldownUntil.get(mint) ?? 0)) cooldownUntil.delete(mint);
    }

    const maxOrders = state.hello.caps.max_orders_per_batch;
    const orders: { side: "buy" | "sell"; mint: string; quote_lamports?: bigint; token_amount?: bigint; max_slippage_bps: number }[] = [];
    const push = (o: (typeof orders)[number]): boolean => {
      if (orders.length >= maxOrders) return false;
      orders.push(o);
      return true;
    };

    // --- exits first: take-profit, stop-loss, trailing stop, fast dump, time cap.
    for (const [mint, holding] of state.positions) {
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      if (hasPendingSell(state, mint)) continue;
      const price = priceOf(state, mint);
      if (price <= 0) continue;
      const cost = Number(holding.cost_lamports);
      if (cost <= 0) continue;
      const value = Number(holding.token_amount) * price;
      const ratio = value / cost;
      let m = meta.get(mint);
      if (m === undefined) {
        const stat0 = stats.get(mint);
        m = { entryTime: nowSec, peakRatio: ratio, firstPrice: stat0?.firstPrice ?? price };
        meta.set(mint, m);
      }
      if (ratio > m.peakRatio) m.peakRatio = ratio;

      const stat = stats.get(mint);
      let fastDump = false;
      if (stat !== undefined && stat.prices.length >= 6) {
        const fiveAgo = stat.prices[stat.prices.length - 6];
        const last = stat.prices[stat.prices.length - 1];
        if (fiveAgo > 0 && last / fiveAgo - 1 <= FAST_DUMP) fastDump = true;
      }

      const timeUp = nowSec - m.entryTime >= MAX_HOLD_SEC;
      const trailing = m.peakRatio >= TRAILING_ARM && ratio <= m.peakRatio * (1 - TRAILING_DROP);
      if (ratio >= TAKE_PROFIT || ratio <= STOP_LOSS || trailing || fastDump || timeUp) {
        if (push({ side: "sell", mint, token_amount: holding.token_amount, max_slippage_bps: SELL_SLIPPAGE_BPS })) {
          sellsSent += 1;
          cooldownUntil.set(mint, nowSec + COOLDOWN_SEC);
          meta.delete(mint);
        }
      }
    }

    // --- top-ups: grow a healthy held position toward the target size.
    for (const [mint, holding] of state.positions) {
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      if (hasPendingBuy(state, mint)) continue;
      if (meta.has(mint) === false) continue; // exited this batch, do not re-add
      const price = priceOf(state, mint);
      if (price <= 0) continue;
      const value = Number(holding.token_amount) * price;
      if (value >= Number(TARGET_POSITION)) continue;
      const stat = stats.get(mint);
      if (stat === undefined || !entrySignal(stat)) continue;
      // Never add to a position that already ran up: only top up near first sight.
      const m0 = meta.get(mint);
      if (m0 !== undefined && price > m0.firstPrice * (1 + TOPUP_MAX_RISE)) continue;
      const cap = state.maxBuyLamports(mint);
      const free = state.freeCashLamports();
      const room = free - CASH_BUFFER;
      const size = [TARGET_POSITION - BigInt(Math.floor(value)), cap, room].reduce((a, b) => (a < b ? a : b));
      if (size < MIN_BUY) continue;
      if (push({ side: "buy", mint, quote_lamports: size, max_slippage_bps: BUY_SLIPPAGE_BPS })) {
        buysSent += 1;
        tradedMints.add(mint);
        // A top-up resets the cost basis, so the old peak no longer applies.
        const m = meta.get(mint);
        if (m !== undefined) {
          const cost = Number(holding.cost_lamports);
          if (cost > 0) m.peakRatio = value / cost;
        }
      }
    }

    // --- new entries: only mints that traded in this batch, fresh momentum only.
    if (state.committedPositionCount() < state.hello.caps.max_open_positions) {
      let newBuys = 0;
      const seenThisBatch = new Set<string>();
      for (const event of batch.events) {
        if (event.event !== "TradeEvent") continue;
        const mint = event.mint;
        if (seenThisBatch.has(mint)) continue;
        seenThisBatch.add(mint);
        if (newBuys >= MAX_NEW_BUYS_PER_BATCH) break;
        if (state.committedPositionCount() + newBuys >= state.hello.caps.max_open_positions) break;
        if (state.positions.has(mint)) continue;
        if (hasPendingBuy(state, mint)) continue;
        if (cooldownUntil.has(mint)) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        const stat = stats.get(mint);
        if (stat === undefined || !entrySignal(stat)) continue;
        const cap = state.maxBuyLamports(mint);
        const free = state.freeCashLamports();
        const room = free - CASH_BUFFER;
        const size = [INITIAL_BUY, cap, room].reduce((a, b) => (a < b ? a : b));
        if (size < MIN_BUY) continue;
        if (push({ side: "buy", mint, quote_lamports: size, max_slippage_bps: BUY_SLIPPAGE_BPS })) {
          buysSent += 1;
          tradedMints.add(mint);
          newBuys += 1;
          meta.set(mint, { entryTime: nowSec, peakRatio: 1, firstPrice: stat.firstPrice });
        }
      }
    }

    return orders;
  },

  onDone(state) {
    const cash = Number(state.cash);
    console.error(
      `[sharpe-sprint] done after ${batchesSeen} batches: ` +
        `buys=${buysSent} sells=${sellsSent} distinct_mints=${tradedMints.size} ` +
        `final_cash_lamports=${cash} pnl_sol=${((cash - 10_000_000_000) / 1e9).toFixed(4)}`,
    );
  },
});
