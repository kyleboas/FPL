# FPL Repo Notes

- Static/browser-first Fantasy Premier League project with plain HTML/CSS/JS and no package manifest.
- Core UI logic lives under `js/` and `js/modules/`.
- `autoresearch-fpl/` is a self-contained player-picking harness inspired by Karpathy's `autoresearch`.

## autoresearch-fpl

- Run from the repo root with:
  - `node autoresearch-fpl/run.mjs report`
  - `node autoresearch-fpl/run.mjs backtest`
- The fixed harness is `autoresearch-fpl/run.mjs`.
- The intended edit surface for tuning is `autoresearch-fpl/weights.json`.
- Latest generated report is written to `autoresearch-fpl/latest-report.md`.
