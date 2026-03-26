# FPL Repo Notes

Static/browser-first Fantasy Premier League project with plain HTML/CSS/JS and no package manifest. Core UI logic lives under `js/` and `js/modules/`.

## autoresearch-fpl

Self-improving FPL optimizer. **One editable file: `weights.json`**

```bash
node autoresearch-fpl/run.mjs backtest   # Output: avg_points_per_gw
node autoresearch-fpl/run.mjs report     # Weekly picks
```

Historical backtests assume a full 15-man squad and use free transfers only so the metric is stable for weight tuning.
Backtest output now includes an automatic recent holdout block; prefer weights that improve both the full-season average and the holdout average.

See `autoresearch-fpl/program.md` for the full autoresearch loop.
