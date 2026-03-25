# autoresearch-fpl

Autonomous FPL research loop, inspired by [karpathy/autoresearch](https://github.com/karpathy/autoresearch).

## Architecture

An LLM agent iteratively modifies `strategy.mjs` to improve the backtest metric. The evaluation harness (`run.mjs`) is fixed.

| File | Role | Editable? |
|------|------|-----------|
| `autoresearch-fpl/strategy.mjs` | Player scoring, feature engineering, transfer planning, squad selection | **Yes — the LLM modifies this** |
| `autoresearch-fpl/run.mjs` | Data loading, backtest loop, metric reporting | No |
| `autoresearch-fpl/weights.json` | Feature weights and configuration | No (consumed by strategy.mjs) |
| `optimizer.mjs` | LLM-driven experiment loop | No |

## Objective

Maximize `avg_points_per_gw` from `node autoresearch-fpl/run.mjs backtest`.

This is the average actual FPL points scored per gameweek by the selected squad across all simulated gameweeks. Higher is better.

## Commands

```bash
# Run backtest (the evaluation metric)
node autoresearch-fpl/run.mjs backtest

# Generate a human-readable report
node autoresearch-fpl/run.mjs report

# Run one optimization cycle (requires OPENROUTER_API_KEY)
node optimizer.mjs

# Run N optimization cycles (cron mode)
EXPERIMENTS_PER_CRON=10 node cron.mjs
```

## What the LLM can change in strategy.mjs

- **Feature engineering** — add new features, change normalization, combine features differently
- **Scoring formula** — non-linear combinations, position-specific adjustments, interaction terms
- **Transfer logic** — smarter gain calculations, different hit thresholds, look-ahead depth
- **Squad selection** — better budget allocation, starting 11 picks, captain selection
- **Player filtering** — adjust who is eligible (minutes thresholds, availability checks)
- **Chip strategy** — better wildcard/free-hit/bench-boost timing

## What the LLM must NOT change

- Function signatures and return types (the harness depends on them)
- Imports from `./run.mjs` (fixed utility functions)
- Module exports (the harness imports specific functions)

## How the loop works

1. LLM reads `strategy.mjs`, `weights.json`, `program.md`, and experiment history
2. LLM proposes ONE focused change (not multiple changes at once)
3. Optimizer writes the new `strategy.mjs`
4. Optimizer runs `node autoresearch-fpl/run.mjs backtest`
5. If `avg_points_per_gw` improved → keep the change
6. If worse → revert `strategy.mjs` to previous version
7. Record experiment result in database
8. Repeat

## Current setup

- Historical snapshots come from the `FPL-Elo-Insights` 2025-2026 dataset
- Live picks come from the official FPL API
- Recent-history features are computed over the last few completed gameweeks
- Double gameweeks are rewarded through fixture count and total fixture ease

## Environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `OPENROUTER_API_KEY` | Yes | — | API key from openrouter.ai |
| `OPENROUTER_MODEL` | No | `google/gemma-3-27b-it:free` | Model ID to use |
| `EXPERIMENTS_PER_CRON` | No | from config.json | Experiments per cron run |
| `DATABASE_URL` | No | local JSON | Postgres connection string |
| `DATA_DIR` | No | repo root | Directory for persistent data |
