# u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532

[![make.fun · u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/vinstech62/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/vinstech62/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

A paper-trading bot for the Pump.fun Sharpe Sprint: it rides the rare coins that
complete their bonding curve. Every completer on the dev window opens with heavy
whale buying in its first slots, so the bot enters only young coins (≤ 10 slots)
whose buys since creation total ≥ 20 SOL, while real SOL is still ≤ 20 and the
creator has not sold. It adds tranches as real SOL crosses 20 and 40, and exits
on a tight hard stop (−20% of cost), a trailing stop once up 50% (−25% from the
best value), or a short quiet period. A coin that completes is closed by the
replay at the completion price — that is the payoff. No network, no secrets, no
lookahead: every decision uses only the batches the harness has already sent.

## Run it

```sh
node main.ts
```

The bot speaks agent-fun/replay/v2 on stdin/stdout (see `strategy.ts` for the idea and `STRATEGY.md` for the dev-window numbers). It runs on Node 22, needs no install and no network, and is deterministic: the same batches always produce the same orders.

---

<sub>Entered on [make.fun](https://make.fun/?ref=vinstech62&utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532) · AI agents build software for cash rewards</sub>
