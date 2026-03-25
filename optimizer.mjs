#!/usr/bin/env node

/**
 * Weight optimizer for FPL autoresearch.
 *
 * Improvements over basic hill-climbing:
 *  1. Multi-weight perturbation — sometimes perturb 2-3 weights together
 *  2. Simulated annealing — accept worse moves early, refine later
 *  3. Train/test split — detect overfitting via held-out GWs
 *  4. Periodic baseline re-evaluation — refresh stale baseline every N cycles
 *  5. Parent-relative acceptance — compare against parent, not just all-time best
 */

import { readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { migrate, insertExperiment, getBestExperiment, getExperimentCount, loadActiveWeights } from "./db.mjs";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const WEIGHTS_PATH = join(ROOT, "autoresearch-fpl", "weights.json");
const RUN_SCRIPT = join(ROOT, "autoresearch-fpl", "run.mjs");

// ── Annealing schedule ──────────────────────────────────────────────────────

const INITIAL_TEMPERATURE = 1.0;   // Starting temperature
const COOLING_RATE = 0.995;        // Multiplied each cycle: T *= COOLING_RATE
const MIN_TEMPERATURE = 0.01;      // Floor — effectively greedy below this

// ── Re-evaluation schedule ──────────────────────────────────────────────────

const REEVAL_EVERY_N_CYCLES = 20;  // Re-run baseline every N cycles

// ── Train/test split ────────────────────────────────────────────────────────

const TEST_FRACTION = 0.25;        // Hold out last 25% of GWs for validation
const TEST_DEGRADATION_LIMIT = 0.5; // Reject if test score drops more than this

// ── Helpers ─────────────────────────────────────────────────────────────────

async function loadWeights() {
  const dbWeights = await loadActiveWeights();
  if (dbWeights) return dbWeights;
  const raw = await readFile(WEIGHTS_PATH, "utf8");
  return JSON.parse(raw);
}

async function saveWeights(weights) {
  await writeFile(WEIGHTS_PATH, JSON.stringify(weights, null, 2) + "\n", "utf8");
}

function runBacktest(splitGw) {
  const args = [RUN_SCRIPT, "backtest"];
  if (splitGw) args.push(`--split-gw=${splitGw}`);
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      args,
      { cwd: ROOT, timeout: 120_000 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(`backtest failed: ${stderr || err.message}`));
        resolve(stdout);
      },
    );
  });
}

function runReport() {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [RUN_SCRIPT, "report"],
      { cwd: ROOT, timeout: 60_000 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(`report failed: ${stderr || err.message}`));
        resolve(stdout);
      },
    );
  });
}

function parseBacktestOutput(output) {
  const totalMatch = output.match(/total_points:\s*([\d.-]+)/);
  const avgMatch = output.match(/avg_points_per_gw:\s*([\d.]+)/);
  const hitMatch = output.match(/total_hit_cost:\s*([\d.]+)/);
  const trainMatch = output.match(/train_avg_points:\s*([\d.]+)/);
  const testMatch = output.match(/test_avg_points:\s*([\d.]+)/);
  const gwRangeMatch = output.match(/GW(\d+)\s*→\s*GW(\d+)/);
  return {
    overallAvgPoints: avgMatch ? parseFloat(avgMatch[1]) : 0,
    totalPoints: totalMatch ? parseFloat(totalMatch[1]) : 0,
    hitRate: hitMatch ? parseFloat(hitMatch[1]) : 0,
    trainAvgPoints: trainMatch ? parseFloat(trainMatch[1]) : null,
    testAvgPoints: testMatch ? parseFloat(testMatch[1]) : null,
    startGw: gwRangeMatch ? parseInt(gwRangeMatch[1]) : null,
    endGw: gwRangeMatch ? parseInt(gwRangeMatch[2]) : null,
  };
}

/**
 * Compute the split GW for train/test from backtest range.
 * Returns the last GW of the training set, or null if not enough GWs.
 */
function computeSplitGw(startGw, endGw) {
  const totalGws = endGw - startGw + 1;
  if (totalGws < 6) return null; // Need at least 6 GWs to split meaningfully
  const testSize = Math.max(2, Math.round(totalGws * TEST_FRACTION));
  return endGw - testSize;
}

// ── Weight perturbation ─────────────────────────────────────────────────────

function getWeightKeys(weights) {
  const keys = [];
  if (typeof weights.historyWindow === "number") {
    keys.push({ section: "top", key: "historyWindow", value: weights.historyWindow });
  }
  if (typeof weights.minimumRecentMinutes === "number") {
    keys.push({ section: "top", key: "minimumRecentMinutes", value: weights.minimumRecentMinutes });
  }
  if (typeof weights.minimumChanceOfPlaying === "number") {
    keys.push({ section: "top", key: "minimumChanceOfPlaying", value: weights.minimumChanceOfPlaying });
  }
  for (const [key, value] of Object.entries(weights.common ?? {})) {
    keys.push({ section: "common", key, value });
  }
  for (const [pos, posWeights] of Object.entries(weights.byPosition ?? {})) {
    for (const [key, value] of Object.entries(posWeights)) {
      keys.push({ section: `byPosition.${pos}`, key, value });
    }
  }
  return keys;
}

function setWeight(weights, section, key, newValue) {
  if (section === "top") {
    weights[key] = newValue;
  } else if (section === "common") {
    weights.common[key] = newValue;
  } else {
    const pos = section.replace("byPosition.", "");
    weights.byPosition[pos][key] = newValue;
  }
}

function getWeight(weights, section, key) {
  if (section === "top") return weights[key];
  if (section === "common") return weights.common[key];
  const pos = section.replace("byPosition.", "");
  return weights.byPosition[pos][key];
}

function perturbSingleWeight(weights, pick) {
  const oldValue = getWeight(weights, pick.section, pick.key);
  let newValue;
  let delta;

  if (pick.key === "historyWindow") {
    delta = Math.random() < 0.5 ? -1 : 1;
    newValue = Math.max(1, Math.min(38, oldValue + delta));
  } else if (pick.key === "minimumRecentMinutes") {
    delta = (Math.random() < 0.5 ? -1 : 1) * 30;
    newValue = Math.max(0, Math.min(360, oldValue + delta));
  } else if (pick.key === "minimumChanceOfPlaying") {
    delta = (Math.random() < 0.5 ? -1 : 1) * 10;
    newValue = Math.max(0, Math.min(100, oldValue + delta));
  } else {
    const scale = Math.max(Math.abs(oldValue) * 0.06, 0.02);
    delta = (Math.random() * 2 - 1) * scale;
    newValue = Math.round((oldValue + delta) * 1000) / 1000;
  }

  setWeight(weights, pick.section, pick.key, newValue);

  const label = pick.section === "common" ? pick.key :
                pick.section === "top" ? pick.key :
                `${pick.section}.${pick.key}`;
  const decimals = pick.key.includes("minimum") || pick.key.includes("Window") ? 0 : 3;
  return `${label} ${oldValue.toFixed(decimals)} → ${newValue.toFixed(decimals)}`;
}

/**
 * Perturb 1-3 weights at once (multi-weight perturbation).
 * 60% chance of 1 weight, 30% chance of 2, 10% chance of 3.
 */
function perturbWeights(weights) {
  const keys = getWeightKeys(weights);
  const roll = Math.random();
  const count = roll < 0.6 ? 1 : roll < 0.9 ? 2 : 3;
  const n = Math.min(count, keys.length);

  // Pick n distinct random weights
  const shuffled = keys.slice().sort(() => Math.random() - 0.5);
  const picks = shuffled.slice(0, n);

  const descriptions = [];
  for (const pick of picks) {
    descriptions.push(perturbSingleWeight(weights, pick));
  }

  return descriptions.join(", ");
}

// ── Simulated annealing acceptance ──────────────────────────────────────────

/**
 * Compute current temperature from cycle count.
 */
function getTemperature(cycleNumber) {
  return Math.max(MIN_TEMPERATURE, INITIAL_TEMPERATURE * Math.pow(COOLING_RATE, cycleNumber));
}

/**
 * Decide whether to accept a trial.
 * Always accepts improvements. Accepts worse results with probability
 * exp(-delta / temperature) where delta = parentScore - trialScore.
 */
function shouldAccept(trialScore, parentScore, temperature) {
  if (trialScore > parentScore) return true;
  if (temperature <= MIN_TEMPERATURE) return false;

  const delta = parentScore - trialScore;
  const probability = Math.exp(-delta / (temperature * 0.5));
  const accepted = Math.random() < probability;
  return accepted;
}

// ── Main optimization cycle ─────────────────────────────────────────────────

export async function runOptimizationCycle() {
  await migrate();

  const cycleNumber = await getExperimentCount();
  const temperature = getTemperature(cycleNumber);

  // 1. Load current weights
  const originalWeights = await loadWeights();
  const best = await getBestExperiment();

  // 2. Determine the train/test split GW (need a preliminary backtest to know GW range)
  let splitGw = null;

  // 3. Establish baseline if first run
  let parentScore; // Score of the weights we're perturbing FROM
  let bestScore;   // All-time best score (for reference)

  if (!best) {
    console.log("[optimizer] no baseline found, running initial backtest...");
    // Estimate split GW for train/test from weights
    const historyWindow = originalWeights.historyWindow ?? 4;
    const estimatedStart = Math.max(2, historyWindow + 2);
    splitGw = computeSplitGw(estimatedStart, 31);

    const baselineOutput = await runBacktest(splitGw);
    const baselineResult = parseBacktestOutput(baselineOutput);

    // Refine splitGw from actual GW range
    if (baselineResult.startGw && baselineResult.endGw) {
      splitGw = computeSplitGw(baselineResult.startGw, baselineResult.endGw);
    }

    parentScore = baselineResult.overallAvgPoints;
    bestScore = parentScore;
    await insertExperiment({
      overallAvgPoints: baselineResult.overallAvgPoints,
      hitRate: baselineResult.hitRate,
      weights: originalWeights,
      description: "baseline",
      status: "keep",
      trainAvgPoints: baselineResult.trainAvgPoints,
      testAvgPoints: baselineResult.testAvgPoints,
      parentScore: null,
      temperature,
    });
    console.log(`[optimizer] baseline: avg=${parentScore.toFixed(2)}, train=${baselineResult.trainAvgPoints?.toFixed(2) ?? "N/A"}, test=${baselineResult.testAvgPoints?.toFixed(2) ?? "N/A"}`);
  } else {
    bestScore = best.overall_avg_points;
    parentScore = bestScore; // Parent = current best weights
    console.log(`[optimizer] current best: avg=${bestScore.toFixed(2)}, temp=${temperature.toFixed(4)}, cycle=${cycleNumber}`);
  }

  // 4. Periodic baseline re-evaluation — run fresh backtest with current best weights
  if (cycleNumber > 0 && cycleNumber % REEVAL_EVERY_N_CYCLES === 0) {
    console.log(`[optimizer] re-evaluating baseline (every ${REEVAL_EVERY_N_CYCLES} cycles)...`);
    await saveWeights(originalWeights);

    const historyWindow = originalWeights.historyWindow ?? 4;
    const estimatedStart = Math.max(2, historyWindow + 2);
    splitGw = computeSplitGw(estimatedStart, 31);

    const reevalOutput = await runBacktest(splitGw);
    const reevalResult = parseBacktestOutput(reevalOutput);

    // Update splitGw from actual range if available
    if (reevalResult.startGw && reevalResult.endGw) {
      splitGw = computeSplitGw(reevalResult.startGw, reevalResult.endGw);
    }

    const freshScore = reevalResult.overallAvgPoints;
    if (Math.abs(freshScore - parentScore) > 0.01) {
      console.log(`[optimizer] baseline refreshed: ${parentScore.toFixed(2)} → ${freshScore.toFixed(2)}`);
      parentScore = freshScore;
    }
  }

  // Estimate split GW from weights if we haven't discovered it yet.
  // The backtest gracefully ignores splitGw if it's outside the actual range.
  if (splitGw === null) {
    const historyWindow = originalWeights.historyWindow ?? 4;
    const estimatedStart = Math.max(2, historyWindow + 2);
    // Use a generous estimate for endGw — if wrong, backtest just won't emit train/test lines
    splitGw = computeSplitGw(estimatedStart, 31);
  }

  // 5. Perturb weights (1-3 at once)
  const trialWeights = JSON.parse(JSON.stringify(originalWeights));
  const description = perturbWeights(trialWeights);
  console.log(`[optimizer] trying: ${description}`);

  // 6. Save trial weights and backtest
  await saveWeights(trialWeights);
  let trialResult;
  try {
    const output = await runBacktest(splitGw);
    trialResult = parseBacktestOutput(output);
  } catch (err) {
    console.error(`[optimizer] backtest crashed: ${err.message}`);
    await saveWeights(originalWeights);
    await insertExperiment({
      overallAvgPoints: 0,
      hitRate: 0,
      weights: trialWeights,
      description,
      status: "crash",
      parentScore,
      temperature,
    });
    return;
  }

  // 7. Acceptance decision (parent-relative + simulated annealing + overfitting check)
  const trialScore = trialResult.overallAvgPoints;
  let accepted = shouldAccept(trialScore, parentScore, temperature);
  let rejectReason = accepted ? null : "worse than parent";

  // Overfitting guard: if train improved but test degraded significantly, reject
  if (accepted && trialResult.trainAvgPoints !== null && trialResult.testAvgPoints !== null) {
    // Compare test score to see if it degraded
    // We need the parent's test score for comparison — use best experiment's test score as proxy
    if (best?.test_avg_points && trialResult.testAvgPoints < best.test_avg_points - TEST_DEGRADATION_LIMIT) {
      accepted = false;
      rejectReason = `test degraded: ${trialResult.testAvgPoints.toFixed(2)} < ${best.test_avg_points.toFixed(2)} - ${TEST_DEGRADATION_LIMIT}`;
    }
  }

  if (accepted) {
    const tag = trialScore > parentScore ? "IMPROVED" : "ANNEALING-ACCEPT";
    const delta = trialScore - parentScore;
    console.log(
      `[optimizer] ${tag}: ${trialScore.toFixed(2)} (parent=${parentScore.toFixed(2)}, Δ=${delta >= 0 ? "+" : ""}${delta.toFixed(3)}, temp=${temperature.toFixed(4)})`,
    );
    if (trialResult.trainAvgPoints !== null) {
      console.log(`[optimizer]   train=${trialResult.trainAvgPoints.toFixed(2)}, test=${trialResult.testAvgPoints?.toFixed(2) ?? "N/A"}`);
    }
    await insertExperiment({
      overallAvgPoints: trialResult.overallAvgPoints,
      hitRate: trialResult.hitRate,
      weights: trialWeights,
      description,
      status: "keep",
      trainAvgPoints: trialResult.trainAvgPoints,
      testAvgPoints: trialResult.testAvgPoints,
      parentScore,
      temperature,
    });
    // weights.json already has the improved weights
  } else {
    console.log(
      `[optimizer] DISCARD: ${trialScore.toFixed(2)} (parent=${parentScore.toFixed(2)}, temp=${temperature.toFixed(4)}, reason=${rejectReason})`,
    );
    await saveWeights(originalWeights);
    await insertExperiment({
      overallAvgPoints: trialResult.overallAvgPoints,
      hitRate: trialResult.hitRate,
      weights: trialWeights,
      description,
      status: "discard",
      trainAvgPoints: trialResult.trainAvgPoints,
      testAvgPoints: trialResult.testAvgPoints,
      parentScore,
      temperature,
    });
  }

  // 8. Re-run report with best weights
  console.log("[optimizer] generating report...");
  try {
    await runReport();
    console.log("[optimizer] report updated");
  } catch (err) {
    console.error(`[optimizer] report failed: ${err.message}`);
  }
}

// Allow running standalone: node optimizer.mjs
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runOptimizationCycle().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
