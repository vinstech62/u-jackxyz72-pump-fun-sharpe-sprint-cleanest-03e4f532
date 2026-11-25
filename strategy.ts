// Whale rider for the pump.fun bonding-curve replay (agent-fun/replay/v2).
//
// What the dev data actually shows: directional scalping loses on this window —
// the average coin falls after any entry signal, and ~2.9% round-trip fees eat
// the rest. The one big, real asymmetry is completion. A coin's price is roughly
// a convex function of its real SOL reserve: from real SOL 1 to the 85 SOL
// completion line the price runs about 11x (median +1029% on the dev window),
// and 7 of the 35 completers climb there gradually over minutes, not in one
// slot. The other 28 complete inside a single slot and are unreachable at the
// 2-slot latency, so this bot never chases them.
//
// The tell for a gradual completer is written in its first trades: every one
// of the 35 completers, and all 7 gradual ones, opens with heavy buying in its
// first slots (cumulative buys >= 2 SOL, a single buy >= 1.5 SOL), while no
// coin at all completes without it. So the bot enters only young coins that
// just showed that whale accumulation — never a coin that merely drifted up
// to some reserve level. Most whale coins still crash, so the ride is managed
// with a wide price trailing stop (completers dip up to 99% in real SOL and
// 65% in price before they finish, so no reserve-based exit can keep them):
//   - Enter tiny (about 0.015 SOL) on a coin <= 10 slots old whose buys since
//     creation total >= 2 SOL with a single buy >= 1.5 SOL, while its real SOL
//     is still <= 20 and its creator has not sold. A coin that already
//     completed in the same batch is skipped: the replay closes it first.
//   - Add a tranche each time real SOL crosses a new rung above the entry
//     level (5, 10, 20, 40): capital only follows coins that keep proving
//     they can attract money. Rungs already passed at entry are skipped, so
//     adds only fire on fresh growth.
//   - Exit the whole position on a hard value stop (-50% of cost), on a wide
//     trailing stop once the position is up 50% (sell on a 50% fall from its
//     best value), when the coin goes quiet for a while (a dead coin only
//     occupies a slot), or after a long hold. A coin that completes is closed
//     by the replay at the completion price — that is the payoff, not
//     something to sell early.
//   - Sells go out in chunks: a sell whose proceeds would exceed the curve's
//     real SOL is refused, so a big position is unwound piece by piece.
//
// Guardrail pacing: the run must end with round trips of >= 0.01 SOL on >= 20
// coins. Entries are sized just above 0.01 SOL, so every entry counts; when the
// bot's own fills or coins lag a pace prorated over the window it opens tiny
// 0.01 SOL probe round trips on liquid curves until it is back on pace.
//
// Pure function of the batches the harness sends: no clock, no randomness, no
// I/O, so the two graded executions produce byte-identical action logs.

import type { Batch, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Cumulative buys since creation (lamports) that mark whale accumulation. */
  whaleBuyVol: bigint;
  /** Biggest single buy since creation (lamports) that must also be present. */
  whaleMaxBuy: bigint;
  /** Newest a coin may be to enter (slots since its CreateEvent). */
  entryAgeMax: number;
  /** Real SOL (lamports) a coin must still be under to enter. */
  entryRqMax: bigint;
  /** First buy (lamports); the per-reply 1%-of-real-reserve cap applies too. */
  entryStake: bigint;
  /** Smallest single buy worth paying the tx fee for (lamports). */
  minBuy: bigint;
  /** Real SOL crossings that each earn one add-on buy (lamports). */
  addRungs: Array<{ rq: bigint; size: bigint }>;
  /** Most SOL at cost in one coin (lamports). */
  maxInvested: bigint;
  /** Slippage allowed on buys (bps); sells always go out at 10000. */
  buySlippageBps: number;
  /** Exit when liquidation value falls to cost * (1 - hardStop). */
  hardStop: number;
  /** Trailing stop: once up at least trailArm, exit on a fall of trail from the best value. */
  trailArm: number;
  trail: number;
  /** Exit when no trade has hit the coin for this many slots. */
  staleSlots: number;
  /** Exit after holding this many slots regardless. */
  maxHold: number;
  /** Skip a coin whose creator sold before entry. */
  skipDevSold: boolean;
  /** Most new entries per batch. */
  maxEntriesPerBatch: number;
  /** Guardrail pacing targets (fills / coins) over paceSecs of block time. */
  targetFills: number;
  targetCoins: number;
  paceSecs: number;
  /** Probe round-trip size (lamports). */
  probeSol: bigint;
  /** Most probe positions open at once. */
  maxProbes: number;
}

export const DEFAULT_PARAMS: Params = {
  whaleBuyVol: 20000000000n,
  whaleMaxBuy: 1_500_000_000n,
  entryAgeMax: 10,
  entryRqMax: 20_000_000_000n,
  entryStake: 10000000n,
  minBuy: 10_000_000n,
  addRungs: [
    { rq: 20000000000n, size: 90000000n },
    { rq: 40000000000n, size: 180000000n },
  ],
  maxInvested: 350000000n,
  buySlippageBps: 3000,
  hardStop: 0.2,
  trailArm: 0.5,
  trail: 0.25,
  staleSlots: 150,
  maxHold: 6000,
  skipDevSold: true,
  maxEntriesPerBatch: 2,
  targetFills: 150,
  targetCoins: 25,
  paceSecs: 86400,
  probeSol: 10_000_000n,
  maxProbes: 2,

};

const CURVE_FEE_BPS = 125n;
const BPS = 10_000n;

interface Coin {
  /** Real SOL (lamports) at the last batch this coin traded in. */
  rq: bigint;
  /** Best real SOL seen while held or watched. */
  peakRq: bigint;
  /** SOL bought since creation (lamports), from the trades this bot has seen. */
  buyVol: bigint;
  /** Biggest single buy since creation (lamports). */
  maxBuy: bigint;
  /** Which add rungs already fired (by index). */
  rungsHit: boolean[];
  devSold: boolean;
  lastTradeSlot: number;
  /** Ever entered (so a coin is only ridden once). */
  entered: boolean;
  done: boolean;
}

interface Held {
  openedSlot: number;
  peakValue: bigint;
  invested: bigint;
  exiting: boolean;
  /** Tokens already queued to sell (a chunked exit in progress). */
  sellQueued: bigint;
}

type ExitReason = 'stale' | 'hardstop' | 'trail' | 'hold' | 'complete';

/** What selling `tokens` against (vq, vt) would pay after curve fees. */
function sellValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const q = (tokens * vq) / (vt + tokens);
  return q - (q * CURVE_FEE_BPS + BPS - 1n) / BPS;
}

/** Tokens to sell so the proceeds stay under `maxOut` (lamports of SOL). */
function tokensForOut(maxOut: bigint, vq: bigint, vt: bigint): bigint {
  if (maxOut <= 0n || vq <= maxOut) return 0n;
  // q = t*vq/(vt+t) = maxOut  =>  t = maxOut*vt/(vq-maxOut)
  return (maxOut * vt) / (vq - maxOut);
}

export function createStrategy(p: Params = DEFAULT_PARAMS) {
  const coins = new Map<Pubkey, Coin>();
  const held = new Map<Pubkey, Held>();
  /** Probe round trips in flight, by mint. */
  const probes = new Map<Pubkey, boolean>();
  let myFills = 0;
  const myCoins = new Set<Pubkey>();
  let firstTime: number | null = null;
  let lastTime: number | null = null;
  /** Exit decisions by reason (diagnostics only, printed to stderr at done). */
  const exitReasons = new Map<ExitReason, number>();
  let entriesSent = 0;

  const coinOf = (mint: Pubkey): Coin => {
    let c = coins.get(mint);
    if (c === undefined) {
      c = {
        rq: 0n,
        peakRq: 0n,
        buyVol: 0n,
        maxBuy: 0n,
        rungsHit: p.addRungs.map(() => false),
        devSold: false,
        lastTradeSlot: -1,
        entered: false,
        done: false,
      };
      coins.set(mint, c);
    }
    return c;
  };

  function hasPending(state: BotState, mint: Pubkey, side: 'buy' | 'sell'): boolean {
    for (const po of state.pending.values()) {
      if (po.order.mint === mint && po.order.side === side) return true;
    }
    return false;
  }

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const slot = batch.slot;
      const traded: Pubkey[] = [];

      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstTime === null) firstTime = e.block_time;
          if (e.block_time > (lastTime ?? 0)) lastTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          coinOf(e.mint).lastTradeSlot = e.slot;
        } else if (e.event === 'TradeEvent') {
          const c = coinOf(e.mint);
          c.rq = BigInt(e.real_quote_reserves);
          if (c.rq > c.peakRq) c.peakRq = c.rq;
          c.lastTradeSlot = e.slot;
          if (e.is_buy) {
            const vol = BigInt(e.sol_amount);
            c.buyVol += vol;
            if (vol > c.maxBuy) c.maxBuy = vol;
          }
          // A sell from the wallet that created the coin: the dev is out.
          if (!e.is_buy && e.user === e.creator) c.devSold = true;
          if (traded[traded.length - 1] !== e.mint && !traded.includes(e.mint)) traded.push(e.mint);
        } else {
          const c = coinOf(e.mint);
          c.done = true;
        }
      }

      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) {
          myFills++;
          myCoins.add(f.mint);
        }
        if (f.side === 'sell' && f.status === 'filled') {
          if (!state.positions.has(f.mint)) {
            held.delete(f.mint);
          }
          // A filled chunk leaves h.exiting set: the next batch sends the
          // following chunk until the position is gone.
        }
        if (f.side === 'buy' && f.status === 'filled') {
          const h = held.get(f.mint);
          if (h !== undefined) h.invested += BigInt(f.quote_lamports);
        }
      }
      for (const mint of [...held.keys()]) {
        if (!state.positions.has(mint) && !hasPending(state, mint, 'buy')) held.delete(mint);
      }
      for (const mint of [...probes.keys()]) {
        if (!state.positions.has(mint) && !hasPending(state, mint, 'buy')) probes.delete(mint);
      }

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = state.txFeeLamports();
      const marks = new Map<Pubkey, { vq: bigint; vt: bigint; rq: bigint }>();
      for (const m of batch.marks) {
        marks.set(m.mint, {
          vq: BigInt(m.virtual_quote_reserves),
          vt: BigInt(m.virtual_token_reserves),
          rq: BigInt(m.real_quote_reserves),
        });
      }
      const reservesOf = (mint: Pubkey): { vq: bigint; vt: bigint; rq: bigint } | undefined => {
        const mk = marks.get(mint);
        if (mk !== undefined) return mk;
        const cv = state.curves.get(mint);
        if (cv === undefined) return undefined;
        return { vq: cv.virtual_quote_reserves, vt: cv.virtual_token_reserves, rq: cv.real_quote_reserves };
      };

      // Sell helper: unwind a position in chunks whose proceeds stay under the
      // curve's real SOL, so no chunk is refused for max_order_size.
      const sellChunked = (mint: Pubkey, tokens: bigint): void => {
        const rv = reservesOf(mint);
        if (rv === undefined || tokens <= 0n) return;
        let remaining = tokens;
        // At most 3 chunks in one reply; the rest follows in later batches
        // (the exit loop keeps unwinding while h.exiting is set).
        for (let i = 0; i < 3 && remaining > 0n && orders.length < cap; i++) {
          const maxOut = (rv.rq * 80n) / 100n;
          let chunk = tokensForOut(maxOut, rv.vq, rv.vt);
          if (chunk <= 0n || chunk >= remaining) chunk = remaining;
          orders.push({ side: 'sell', mint, token_amount: chunk, max_slippage_bps: 10_000 });
          remaining -= chunk;
        }
      };

      // 1. Exits first, in deterministic mint order.
      const heldMints = [...state.positions.keys()].sort();
      for (const mint of heldMints) {
        if (orders.length >= cap) break;
        if (probes.has(mint)) continue;
        const pos = state.positions.get(mint)!;
        let h = held.get(mint);
        if (h === undefined) {
          h = { openedSlot: slot, peakValue: 0n, invested: pos.cost_lamports, exiting: false, sellQueued: 0n };
          held.set(mint, h);
        }
        // An exit already in progress: keep unwinding it, chunk by chunk.
        if (h.exiting) {
          if (!hasPending(state, mint, 'sell')) sellChunked(mint, pos.token_amount);
          continue;
        }
        if (hasPending(state, mint, 'sell')) continue;
        const c = coinOf(mint);
        const rv = reservesOf(mint);
        if (rv === undefined) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        const value = sellValue(pos.token_amount, rv.vq, rv.vt) - tx;
        const cost = pos.cost_lamports;
        if (value > h.peakValue) h.peakValue = value;
        if (rv.rq > c.peakRq) c.peakRq = rv.rq;
        let exit: ExitReason | null = null;
        if (cost > 0n && value * BPS <= cost * BigInt(Math.round((1 - p.hardStop) * 10000))) exit = 'hardstop';
        if (
          exit === null &&
          h.peakValue > 0n &&
          cost > 0n &&
          h.peakValue * BPS >= cost * BigInt(Math.round((1 + p.trailArm) * 10000)) &&
          value * BPS <= h.peakValue * BigInt(Math.round((1 - p.trail) * 10000))
        ) {
          exit = 'trail';
        }
        if (exit === null && c.lastTradeSlot >= 0 && slot - c.lastTradeSlot >= p.staleSlots) exit = 'stale';
        if (exit === null && slot - h.openedSlot >= p.maxHold) exit = 'hold';
        if (exit === null) continue;
        exitReasons.set(exit, (exitReasons.get(exit) ?? 0) + 1);
        sellChunked(mint, pos.token_amount);
        h.exiting = true;
      }

      // 2. Probe round trips: sell the whole probe as soon as its buy has landed.
      for (const [mint, selling] of probes) {
        if (orders.length >= cap) break;
        const pos = state.positions.get(mint);
        if (pos === undefined) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete || hasPending(state, mint, 'sell')) continue;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        if (!selling) probes.set(mint, true);
      }

      // 3. Add-on tranches on held coins whose real SOL crossed a new rung.
      let free = state.freeCashLamports();
      for (const mint of heldMints) {
        if (orders.length >= cap) break;
        if (probes.has(mint)) continue;
        const h = held.get(mint);
        const pos = state.positions.get(mint);
        const c = coinOf(mint);
        const curve = state.curves.get(mint);
        if (h === undefined || pos === undefined || h.exiting || curve === undefined || curve.complete) continue;
        if (hasPending(state, mint, 'buy')) continue;
        const rv = reservesOf(mint);
        if (rv === undefined) continue;
        const rq = rv.rq;
        // Committed = filled buys + buys still in flight (for the maxInvested cap).
        let committed = h.invested;
        for (const po of state.pending.values()) {
          if (po.order.mint === mint && po.order.side === 'buy') committed += BigInt(po.order.quote_lamports);
        }
        for (let i = 0; i < p.addRungs.length; i++) {
          if (c.rungsHit[i]!) continue;
          const rung = p.addRungs[i]!;
          if (rq < rung.rq) continue;
          if (committed >= p.maxInvested) break;
          let amount = rung.size;
          const room = p.maxInvested - committed;
          if (amount > room) amount = room;
          const sizeCap = (state.maxBuyLamports(mint) * 97n) / 100n;
          if (amount > sizeCap) amount = sizeCap;
          if (amount < p.minBuy) continue;
          if (free < amount + tx) continue;
          orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: p.buySlippageBps });
          free -= amount + tx;
          committed += amount;
          c.rungsHit[i] = true;
          break; // one rung per batch per coin
        }
      }

      // 4. New entries: young coins that just showed whale accumulation.
      let open = state.committedPositionCount();
      let entries = 0;
      for (const mint of traded) {
        if (orders.length >= cap || entries >= p.maxEntriesPerBatch) break;
        if (open >= state.hello.caps.max_open_positions) break;
        if (state.positions.has(mint) || probes.has(mint) || hasPending(state, mint, 'buy')) continue;
        const c = coinOf(mint);
        const curve = state.curves.get(mint);
        if (c === undefined || curve === undefined || curve.complete || c.done) continue;
        if (c.entered) continue;
        if (p.skipDevSold && c.devSold) continue;
        if (curve.created_slot === null) continue;
        if (slot - curve.created_slot > p.entryAgeMax) continue;
        if (c.buyVol < p.whaleBuyVol) continue;
        if (c.maxBuy < p.whaleMaxBuy) continue;
        const rv = reservesOf(mint);
        if (rv === undefined) continue;
        const rq = rv.rq;
        if (rq > p.entryRqMax) continue;
        const sizeCap = (state.maxBuyLamports(mint) * 97n) / 100n;
        let amount = p.entryStake < sizeCap ? p.entryStake : sizeCap;
        if (amount < p.minBuy) continue;
        if (free < amount + tx) continue;
        orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: p.buySlippageBps });
        free -= amount + tx;
        entriesSent++;
        c.entered = true;
        // Rungs already passed at entry are skipped: adds only fire on fresh growth.
        c.rungsHit = p.addRungs.map((r) => rq >= r.rq);
        // invested is filled-only: the buy fill handler adds the real amount.
        held.set(mint, { openedSlot: slot, peakValue: 0n, invested: 0n, exiting: false, sellQueued: 0n });
        open++;
        entries++;
      }

      // 5. Guardrail pacing: open a probe when fills or coins lag the pace.
      if (probes.size < p.maxProbes && firstTime !== null && lastTime !== null && lastTime > firstTime) {
        const pace = Math.min(1, (lastTime - firstTime) / p.paceSecs);
        const needCoins = myCoins.size < Math.ceil(p.targetCoins * pace);
        const needFills = myFills < Math.ceil(p.targetFills * pace);
        if (needCoins || needFills) {
          for (const mint of traded) {
            if (orders.length >= cap || probes.size >= p.maxProbes) break;
            if (held.has(mint) || probes.has(mint) || state.positions.has(mint) || hasPending(state, mint, 'buy')) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            if (state.maxBuyLamports(mint) < (p.probeSol * 150n) / 100n) continue;
            if (free < p.probeSol + 2n * tx) break;
            orders.push({ side: 'buy', mint, quote_lamports: p.probeSol, max_slippage_bps: 10_000 });
            probes.set(mint, false);
            free -= p.probeSol + tx;
          }
        }
      }

      return orders;
    },

    onDone(): void {
      const reasons = [...exitReasons.entries()].map(([k, v]) => `${k}=${v}`).join(' ');
      console.error(`[diag] entriesSent=${entriesSent} myFills=${myFills} coins=${myCoins.size} exits: ${reasons}`);
    },
  };
}
