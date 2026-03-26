# autoresearch-fpl

This is an experiment to have the LLM do its own FPL research.

## Setup

To set up a new experiment, work with the user to:

1. **Agree on a run tag**: propose a tag based on today's date. The branch `autoresearch/<tag>` should be a fresh run.
2. **Create the branch**: branch from the current mainline commit.
3. **Read the in-scope files**:
   - `README.md` — repository context.
   - `autoresearch-fpl/run.mjs` — fixed evaluator, report generator, and legal FPL lineup scoring.
   - `autoresearch-fpl/strategy.mjs` — the only file you modify.
   - `autoresearch-fpl/weights.json` — fixed configuration consumed by the strategy.
4. **Initialize results.tsv**: create `results.tsv` with only the header row. The baseline will be recorded after the first run.
5. **Confirm and go**: once setup looks correct, begin the experimentation loop.

## Experimentation

Each experiment runs one backtest:

```bash
node autoresearch-fpl/run.mjs backtest
```

**What you CAN do:**
- Modify `autoresearch-fpl/strategy.mjs` only.
- Change player ranking, feature engineering, transfer planning, captaincy, chip timing, and valid lineup selection logic inside that file.

**What you CANNOT do:**
- Modify `autoresearch-fpl/run.mjs`. It is read-only and defines the ground-truth evaluator.
- Modify `autoresearch-fpl/weights.json`.
- Add dependencies or install packages.
- Change function signatures, imports, or exports expected by the harness.

**The goal is simple: get the highest avg_points_per_gw.** This is the average legal FPL score per simulated gameweek, including captaincy and valid starting-XI constraints. `total_hit_cost` is a soft constraint: some extra hits are fine if they clearly improve the score.

**Simplicity criterion**: all else equal, simpler is better. A tiny gain is not worth a pile of brittle heuristics. If a change meaningfully improves the score or keeps the score flat while simplifying the strategy, that is good.

**The first run**: your first run should always establish the baseline with the strategy exactly as it is.

## Output format

The backtest prints a summary like this:

```text
Season simulation backtest
Gameweeks simulated: GW8 → GW31 (24 GWs)
total_points: 910.0
total_hit_cost: 28
avg_points_per_gw: 37.92
```

Extract the key metrics from the log:

```bash
grep "^avg_points_per_gw:\|^total_hit_cost:" run.log
```

## Logging results

When an experiment is done, log it to `results.tsv` (tab-separated, not comma-separated).

The TSV has a header row and 5 columns:

```text
commit	avg_points_per_gw	total_hit_cost	status	description
```

1. git commit hash (short, 7 chars)
2. avg points per GW achieved — use `0.00` for crashes
3. total hit cost — use `0` for crashes
4. status: `keep`, `discard`, or `crash`
5. short text description of what the experiment tried

Example:

```text
commit	avg_points_per_gw	total_hit_cost	status	description
a1b2c3d	37.65	24	keep	baseline
b2c3d4e	37.92	28	keep	use fixture-weighted captain tie-break
c3d4e5f	37.61	24	discard	penalize all defenders in away matches
d4e5f6g	0.00	0	crash	remove required exports from strategy
```

## The experiment loop

The experiment runs on a dedicated branch.

LOOP FOREVER:

1. Look at the git state: the current branch and commit.
2. Tune `autoresearch-fpl/strategy.mjs` with one focused idea.
3. git commit.
4. Run the experiment: `node autoresearch-fpl/run.mjs backtest > run.log 2>&1`
5. Read the results: `grep "^avg_points_per_gw:\|^total_hit_cost:" run.log`
6. If the grep output is empty, the run crashed. Read `tail -n 50 run.log`, fix obvious mistakes if the idea is still sound, otherwise mark it as a crash and move on.
7. Record the results in `results.tsv` and do not commit that file.
8. If `avg_points_per_gw` improved, advance the branch and keep the commit.
9. If the score is equal or worse, git reset back to where you started.

The idea is simple: try one idea, keep it if it works, discard it if it does not.
