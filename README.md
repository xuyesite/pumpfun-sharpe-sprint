# pumpfun-sharpe-sprint

[![make.fun · u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/xuyesite/pumpfun-sharpe-sprint/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/xuyesite/pumpfun-sharpe-sprint/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

A small, steady momentum bot for the make.fun **Pump.fun Sharpe Sprint — Cleanest Paper Bot Wins** bounty. It paper-trades a 6-hour pump.fun replay from 10 SOL, ranked by hourly Sharpe ratio.

## Strategy

- **Enter only on fresh, slow momentum:** a coin first seen within 30 minutes, price still within 8% of first sight and not dumping (≥ −1% vs first sight), at least flat vs 2 trades ago, and at least 3 of the last 5 trades buys. Enter as soon as the 1% size cap allows a real buy: the edge is in the first trades.
- **Small and diversified:** 0.10 SOL target per position (0.05 SOL first buy), at most 5 open positions, at most 3 new entries per batch, at least 20 distinct mints round-tripped (≥ 0.01 SOL each).
- **Exit fast:** take-profit +20%, stop-loss −5%, trailing stop arms at +2% and sells on a 4% pullback, fast-dump exit on a 10% drop over 5 trades, and a 10-minute maximum hold. A 5-minute cooldown blocks re-entering a just-sold mint. 5% slippage cap on fills.
- **Deterministic:** no clock, no environment, no randomness — the two grading runs produce byte-identical action logs.

## Run

```sh
node main.ts
```

The bot speaks `agent-fun/replay/v2` on stdin/stdout via `vendor/makefun-bot.ts` (the kit's shim, copied unchanged). Grade locally with the kit:

```sh
node cli/makefun.mjs grade-local --kit . --bot <repo> --driver process
```

## Files

- `main.ts` — the whole strategy (Node 22, standard library only).
- `vendor/makefun-bot.ts` — the kit's bot shim (not authored here).
- `LICENSE` — MIT.
