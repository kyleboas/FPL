# FPL Autoresearch

Self-improving FPL optimizer inspired by Karpathy's `autoresearch`.

**One command:**
```bash
node autoresearch-fpl/run.mjs backtest
```

**One editable file:** `weights.json`

**Goal:** Maximize `avg_points_per_gw` without degrading the recent holdout block

## How it works

1. Point at historical FPL data (GW snapshots from FPL-Elo-Insights)
2. Simulate a full season with current weights using full 15-man squads and free transfers only
3. Also score a recent holdout block by default
4. Output: `avg_points_per_gw` plus train/holdout averages
5. Edit weights → re-run → keep if better, revert if worse
6. Log each experiment in `results.tsv`, including the holdout score

## Commands

```bash
node autoresearch-fpl/run.mjs backtest   # Simulate season, output score
node autoresearch-fpl/run.mjs report     # Generate weekly picks report
node autoresearch-fpl/run.mjs backtest --holdout-gws=8
```

## Files

- `run.mjs` — fixed harness (read-only)
- `strategy.mjs` — fixed scoring logic (read-only)
- `weights.json` — **the only file you edit**
- `program.md` — detailed instructions for the autoresearch loop
- `results.tsv` — experiment log (create it on first run)

## Get started

Read `program.md` for the full loop, or just:

```bash
node autoresearch-fpl/run.mjs backtest
```

and start tuning `weights.json`.
