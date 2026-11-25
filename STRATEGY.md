# STRATEGY.md — Whale Rider

## Idea

Directional scalping loses on this replay: the average coin falls after any
entry signal, and ~2.9% round-trip fees eat the rest (every momentum / reversion
/ sniper baseline and every scalping variant tried here ends between −0.3 and
−9.4 SOL on the dev window). The one big, real asymmetry is **completion**.
A coin's price is roughly a convex function of its real SOL reserve: from
real SOL 1 to the 85 SOL completion line the price runs about 11x (median
+1029% for completers on the dev window), and 7 of the 35 completers climb
there gradually over minutes, not in one slot. The other 28 complete inside a
single slot and are unreachable at the 2-slot latency, so the bot never
chases them.

The tell for a gradual completer is written in its first trades: **every one
of the 35 completers, and all 7 gradual ones, opens with heavy buying in its
first slots** (cumulative buys ≥ 2 SOL, a single buy ≥ 1.5 SOL), while no coin
at all completes without it. So the bot enters only young coins that just
showed that whale accumulation — never a coin that merely drifted up to some
reserve level.

Most whale coins still crash, so the ride is managed tightly:

- **Enter tiny (0.01 SOL)** on a coin ≤ 10 slots old whose buys since
  creation total ≥ 20 SOL, while its real SOL is still ≤ 20 and its creator
  has not sold. A coin that already completed in the same batch is skipped:
  the replay closes it first.
- **Add tranches** as real SOL crosses 20 (0.09 SOL) and 40 (0.18 SOL):
  capital only follows coins that keep proving they can attract money. Rungs
  already passed at entry are skipped, so adds only fire on fresh growth.
  Most SOL at cost in one coin: 0.35 SOL.
- **Exit the whole position** on a hard value stop (−20% of cost), on a
  trailing stop once the position is up 50% (sell on a 25% fall from its best
  value), when the coin goes quiet for 150 slots, or after a 6000-slot hold.
  Completers dip up to 99% in real SOL and 65% in price before they finish,
  so no reserve-based exit can keep them — the wide-arm / tight-trail pair is
  what lets a winner run to the completion price while cutting a pump-and-dump
  early. Sells go out in chunks (a sell whose proceeds would exceed the
  curve's real SOL is refused).
- **Guardrail pacing:** the run must end with round trips of ≥ 0.01 SOL on
  ≥ 20 coins. Entries are sized at exactly 0.01 SOL, so every entry counts;
  when the bot's own fills or coins lag a pace prorated over the window it
  opens tiny 0.01 SOL probe round trips on liquid curves until it is back on
  pace.

Pure function of the batches the harness sends: no clock, no randomness, no
I/O, no network, no secrets, no lookahead — so the two graded executions
produce byte-identical action logs.

## Parameters (DEFAULT_PARAMS in strategy.ts)

| Parameter | Value |
|---|---|
| whaleBuyVol (cumulative buys since creation) | 20 SOL |
| whaleMaxBuy (biggest single buy) | 1.5 SOL |
| entryAgeMax | 10 slots |
| entryRqMax (real SOL at entry) | 20 SOL |
| entryStake | 0.01 SOL |
| minBuy | 0.01 SOL |
| addRungs | 20 SOL → 0.09 SOL, 40 SOL → 0.18 SOL |
| maxInvested | 0.35 SOL |
| buySlippageBps | 3000 (sells 10000) |
| hardStop | 0.20 |
| trailArm / trail | 0.50 / 0.25 |
| staleSlots | 150 |
| maxHold | 6000 slots |
| skipDevSold | true |
| maxEntriesPerBatch | 2 |
| targetFills / targetCoins / paceSecs | 150 / 25 / 86400 |
| probeSol / maxProbes | 0.01 SOL / 2 |

## Dev-window results (24h calibration, 2026-11-02/03)

Grade-local, `--driver process --worktree` (final config, reproduced twice
byte-identical):

| Metric | Value |
|---|---|
| Net PnL | **+0.5998 SOL** |
| Hourly Sharpe | **+0.150** |
| Max drawdown | 6.9% (limit 50%) |
| Counted round trips (≥ 0.01 SOL) | 68 on 61 distinct mints (need ≥ 20) |
| Whale entries sent | 39 |
| Total fills / coins traded | 153 / 61 |
| Fees (protocol + tx) | 0.0766 + 0.0167 SOL |
| Determinism | two runs byte-identical action logs |
| Baselines | hold-cash 0 SOL, equal-weight −0.0193 SOL — beaten |

Winners are concentrated, as the idea predicts: the three biggest coins are
gradual completers / near-completers (+0.73, +0.26, +0.10 SOL). The sweep that
got here (see `dev/sweep.csv`): rq-rider v2 −0.22 → whale entry v3 −7.34
(adds too big) → small adds + tight trail −1.51 → whale bar 20 + big adds
+0.37 → trail 0.25 / hard stop 0.20 + fewer probes **+0.60**. Two things the
sweep proved not to do: widen the entry band or the exits (both lose), and
arm the trailing stop early (trailArm 0.30 instead of 0.50 turns +0.51 into
−0.15).

## Caveat

The edge is lumpy: on the dev window it rests on a handful of gradual
completers (2–3 coins supply most of the profit). A 6-hour final window with
no gradual completer would score near zero minus probe costs. The entry bar
(20 SOL of early buys) is set high deliberately so the bot only spends its
5 slots on the strongest accumulation; lowering it buys more entries but each
one is a worse bet (bar 15: −0.50, bar 8: −0.58 on the same exits).
