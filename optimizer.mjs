#!/usr/bin/env node

/**
 * Hill-climbing weight optimizer for FPL autoresearch.
 *
 * Each cycle:
 *  1. Load current weights.json
 *  2. Perturb a random weight
 *  3. Run backtest, capture overall_avg_points
 *  4. If better → keep new weights, else → revert
 *  5. Log result to Postgres / local JSON
 *  6. Run report with best weights
 */

import { readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { migrate, insertExperiment, getBestExperiment, loadActiveWeights } from "./db.mjs";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const WEIGHTS_PATH = join(ROOT, "autoresearch-fpl", "weights.json");
const RUN_SCRIPT = join(ROOT, "autoresearch-fpl", "run.mjs");

async function loadWeights() {
  // Prefer DB so ephemeral Railway deployments use the optimized weights
  const dbWeights = await loadActiveWeights();
  if (dbWeights) return dbWeights;
  const raw = await readFile(WEIGHTS_PATH, "utf8");
  return JSON.parse(raw);
}

async function saveWeights(weights) {
  await writeFile(WEIGHTS_PATH, JSON.stringify(weights, null, 2) + "\n", "utf8");
}

function runBacktest() {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [RUN_SCRIPT, "backtest"],
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
  // Season simulator output format
  const totalMatch = output.match(/total_points:\s*([\d.-]+)/);
  const avgMatch = output.match(/avg_points_per_gw:\s*([\d.]+)/);
  const hitMatch = output.match(/total_hit_cost:\s*([\d.]+)/);
  return {
    overallAvgPoints: avgMatch ? parseFloat(avgMatch[1]) : 0,
    totalPoints: totalMatch ? parseFloat(totalMatch[1]) : 0,
    hitRate: hitMatch ? parseFloat(hitMatch[1]) : 0,
  };
}

/**
 * Collect all numeric weight keys as [section, key] pairs.
 */
function getWeightKeys(weights) {
  const keys = [];
  
  // Add top-level numeric params that should be optimized
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

/**
 * Perturb a single random weight by a small amount.
 * Returns a description of what changed.
 */
function perturbWeights(weights) {
  const keys = getWeightKeys(weights);
  const pick = keys[Math.floor(Math.random() * keys.length)];
  const oldValue = getWeight(weights, pick.section, pick.key);

  // Different perturbation strategies for different params
  let newValue;
  let delta;
  
  if (pick.key === "historyWindow") {
    // History window: integer 1-8, step by 1
    delta = Math.random() < 0.5 ? -1 : 1;
    newValue = Math.max(1, Math.min(8, oldValue + delta));
  } else if (pick.key === "minimumRecentMinutes") {
    // Min recent minutes: integer, step by 30
    delta = (Math.random() < 0.5 ? -1 : 1) * 30;
    newValue = Math.max(0, Math.min(360, oldValue + delta));
  } else if (pick.key === "minimumChanceOfPlaying") {
    // Min chance of playing: integer 0-100, step by 10
    delta = (Math.random() < 0.5 ? -1 : 1) * 10;
    newValue = Math.max(0, Math.min(100, oldValue + delta));
  } else {
    // Regular weights: float, scale perturbation
    const scale = Math.max(Math.abs(oldValue) * 0.2, 0.05);
    delta = (Math.random() * 2 - 1) * scale;
    newValue = Math.round((oldValue + delta) * 1000) / 1000;
  }

  setWeight(weights, pick.section, pick.key, newValue);

  const label = pick.section === "common" ? pick.key : 
                pick.section === "top" ? pick.key :
                `${pick.section}.${pick.key}`;
  return `${label} ${oldValue.toFixed(pick.key.includes("minimum") || pick.key.includes("Window") ? 0 : 3)} → ${newValue.toFixed(pick.key.includes("minimum") || pick.key.includes("Window") ? 0 : 3)}`;
}

export async function runOptimizationCycle() {
  await migrate();

  // 1. Load current weights and establish baseline if needed
  const originalWeights = await loadWeights();
  const best = await getBestExperiment();

  let baselineScore;
  if (!best) {
    // First run ever — establish baseline
    console.log("[optimizer] no baseline found, running initial backtest...");
    const output = await runBacktest();
    const result = parseBacktestOutput(output);
    baselineScore = result.overallAvgPoints;
    await insertExperiment({
      overallAvgPoints: result.overallAvgPoints,
      hitRate: result.hitRate,
      weights: originalWeights,
      description: "baseline",
      status: "keep",
    });
    console.log(`[optimizer] baseline: avg_points=${baselineScore.toFixed(2)}`);
  } else {
    baselineScore = best.overall_avg_points;
    console.log(`[optimizer] current best: avg_points=${baselineScore.toFixed(2)}`);
  }

  // 2. Perturb a random weight
  const trialWeights = JSON.parse(JSON.stringify(originalWeights));
  const description = perturbWeights(trialWeights);
  console.log(`[optimizer] trying: ${description}`);

  // 3. Save trial weights and backtest
  await saveWeights(trialWeights);
  let trialResult;
  try {
    const output = await runBacktest();
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
    });
    return;
  }

  // 4. Keep or revert
  const improved = trialResult.overallAvgPoints > baselineScore;
  if (improved) {
    console.log(
      `[optimizer] KEEP: ${trialResult.overallAvgPoints.toFixed(2)} > ${baselineScore.toFixed(2)} (+${(trialResult.overallAvgPoints - baselineScore).toFixed(3)})`,
    );
    await insertExperiment({
      overallAvgPoints: trialResult.overallAvgPoints,
      hitRate: trialResult.hitRate,
      weights: trialWeights,
      description,
      status: "keep",
    });
    // weights.json already has the improved weights
  } else {
    console.log(
      `[optimizer] DISCARD: ${trialResult.overallAvgPoints.toFixed(2)} <= ${baselineScore.toFixed(2)}`,
    );
    await saveWeights(originalWeights);
    await insertExperiment({
      overallAvgPoints: trialResult.overallAvgPoints,
      hitRate: trialResult.hitRate,
      weights: trialWeights,
      description,
      status: "discard",
    });
  }

  // 5. Re-run report with best weights
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
