# autoresearch-fpl

Self-improving FPL optimizer. Point it at historical data → it finds better weights.

## The one rule

**You CAN edit:** `weights.json`
**You CANNOT edit:** `run.mjs`, `strategy.mjs`, any other file

## Quick start

```bash
node autoresearch-fpl/run.mjs backtest
```

Output:
```
Season simulation backtest
Gameweeks simulated: GW6 → GW31 (26 GWs)
total_points: 1349.0
total_hit_cost: 0
avg_points_per_gw: 51.88
train_gws: GW6 → GW25 (20 GWs)
train_avg_points: 50.55
holdout_gws: GW26 → GW31 (6 GWs)
holdout_avg_points: 56.33
holdout_gap: 5.78
```

**Goal: maximize `avg_points_per_gw` without wrecking `holdout_avg_points`.** The backtest now uses full 15-man squads, free transfers only, and automatically reports a recent holdout block.

## The loop

1. Run backtest: `node autoresearch-fpl/run.mjs backtest`
2. Read the output, extract `avg_points_per_gw` and `holdout_avg_points`
3. Edit `weights.json` with one focused hypothesis
4. Re-run backtest
5. Record result in `results.tsv`
6. Keep if improved, revert if worse
7. Repeat

Prefer changes that improve both the full-season average and the holdout average. If the full-season average rises a little but the holdout drops sharply, discard it.

## Recording results

Log each experiment to `results.tsv`:

```text
timestamp	avg_points_per_gw	holdout_avg_points	holdout_gap	total_hit_cost	status	description
2026-03-26T13:53:49Z	35.35	0.00	0.00	148	discard	pre-fix baseline with collapsed squad
2026-03-26T14:15:35Z	51.88	56.33	5.78	0	keep	harness-fixed baseline
2026-03-26T14:20:00Z	52.14	56.90	4.76	0	keep	raise recentPointsPer90 weight
```

Columns:
1. ISO timestamp
2. avg points per GW (`0.00` for crashes)
3. holdout avg points (`0.00` for crashes)
4. holdout gap: `holdout_avg_points - train_avg_points`
5. total hit cost (`0` for crashes)
6. status: `keep`, `discard`, or `crash`
7. short description of what you tried

## Backtest assumptions

- The historical simulation starts from a full 15-man budget squad.
- It banks and uses free transfers, but does not take paid hits.
- By default, the last 6-8 completed gameweeks are treated as a holdout block and reported separately.
- `report` mode still uses the live planning logic for your current team.

## Optional backtest flags

- `--holdout-gws=N`: use the last `N` completed gameweeks as the holdout block
- `--split-gw=N`: explicitly set the final training GW; later GWs become holdout

## What's in weights.json

- `teamId`: your FPL team ID (for live reports)
- `freeTransfers`: how many free transfers you have
- `hitCost`: points cost per transfer hit
- `chips`: which chips are available (`wildcard`, `freeHit`, `benchBoost`)
- `historyWindow`: how many recent GWs to consider
- `minimumRecentMinutes`: filter out players with less recent minutes
- `minimumChanceOfPlaying`: filter out injured/doubtful players
- `common`: weights applied to all players
- `byPosition`: position-specific weights (GK, DEF, MID, FWD)

## Simplicity criterion

All else equal, simpler is better. A tiny gain (0.01 avg points) is not worth a pile of brittle heuristics. If a change keeps the score flat but simplifies the weights, that's good.

## First run

Always establish a baseline with `weights.json` exactly as it is. Record it in `results.tsv` before making any changes.
