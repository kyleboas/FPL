# FPL Autoresearch

This is a small FPL-specific adaptation of the useful part of Karpathy's `autoresearch` pattern.

The fixed harness is `run.mjs`. The editable file is `weights.json`.

Use it in two modes:

```bash
node autoresearch-fpl/run.mjs report
node autoresearch-fpl/run.mjs backtest
```

`report` pulls live FPL data and writes a ranked shortlist to `autoresearch-fpl/latest-report.md`.

`backtest` scores the current weight file against completed gameweeks from the 2025-2026 season using point-in-time snapshots from the `FPL-Elo-Insights` data feed.

The idea is:

1. Keep `run.mjs` fixed.
2. Let an agent edit only `weights.json`.
3. Optimize for stronger backtest output.
4. Re-run `report` to get the current weekly picks.
