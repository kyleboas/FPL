#!/usr/bin/env node

/**
 * LLM-driven optimizer for FPL autoresearch.
 *
 * Instead of random weight perturbation, this uses an LLM (via OpenRouter)
 * to propose code changes to strategy.mjs — the same approach as
 * Karpathy's autoresearch.
 *
 * Each cycle:
 *  1. Read strategy.mjs and program.md
 *  2. Gather recent experiment history
 *  3. Ask the LLM to propose a code change
 *  4. Apply the change to strategy.mjs
 *  5. Run backtest
 *  6. If improved → keep (commit); if worse → revert
 *  7. Record experiment in DB
 *
 * Environment variables:
 *  - OPENROUTER_API_KEY — required
 *  - OPENROUTER_MODEL — model to use (default: google/gemma-3-27b-it:free)
 */

import { readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { migrate, insertExperiment, getBestExperiment, getExperimentCount, getAllExperiments } from "./db.mjs";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const STRATEGY_PATH = join(ROOT, "autoresearch-fpl", "strategy.mjs");
const PROGRAM_PATH = join(ROOT, "autoresearch-fpl", "program.md");
const WEIGHTS_PATH = join(ROOT, "autoresearch-fpl", "weights.json");
const RUN_SCRIPT = join(ROOT, "autoresearch-fpl", "run.mjs");

const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_MODEL = "qwen/qwen3-4b:free";  // Free model for <$2/month budget

// Fallback models if primary is rate-limited or fails
// Priority: free > ultra-cheap for budget constraint
const FALLBACK_MODELS = [
  "google/gemma-3-27b-it:free",  // Free, good at code
  "qwen/qwen3-coder:free",  // Free, code-focused
  "meta-llama/llama-3.3-8b-instruct:free",  // Free, fast
  "google/gemini-2.0-flash-001",  // Cheap fallback ($0.10/$0.40 per M)
];

// Rate limit handling
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 8000;

// Train/test split configuration
const TEST_FRACTION = 0.2;  // 20% of gameweeks for testing
const TEST_DEGRADATION_LIMIT = 2.0;  // Max allowed test set degradation (points per GW)

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getModel() {
  return process.env.OPENROUTER_MODEL || DEFAULT_MODEL;
}

function getApiKey() {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error("OPENROUTER_API_KEY environment variable is required");
  return key;
}

async function callLLMWithModel(messages, model, maxRetries = 3) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const response = await fetch(OPENROUTER_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${getApiKey()}`,
        "HTTP-Referer": "https://github.com/kyleboas/fpl",
        "X-Title": "FPL Autoresearch",
      },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: 4096,
        temperature: 0.8,
      }),
    });

    if (response.ok) {
      const data = await response.json();
      return { content: data.choices?.[0]?.message?.content ?? "", model };
    }

    const errorText = await response.text();
    
    // Rate limit (429) - check if we should try fallback
    if (response.status === 429) {
      const isUpstreamRateLimit = errorText.includes("rate-limited upstream") || errorText.includes("Provider returned error");
      
      if (isUpstreamRateLimit) {
        console.log(`[optimizer] model ${model} rate-limited by provider, trying fallback...`);
        return null; // Signal to try next model
      }
      
      // Standard rate limit - wait and retry
      if (attempt < maxRetries - 1) {
        const waitMs = BASE_DELAY_MS * Math.pow(2, attempt);
        console.log(`[optimizer] rate limited, retrying in ${waitMs/1000}s...`);
        await delay(waitMs);
        continue;
      }
    }

    throw new Error(`OpenRouter API error (${response.status}): ${errorText}`);
  }
  return null;
}

async function callLLM(messages) {
  const requestedModel = getModel();
  const modelsToTry = [requestedModel, ...FALLBACK_MODELS.filter(m => m !== requestedModel)];
  
  for (const model of modelsToTry) {
    console.log(`[optimizer] trying model: ${model}`);
    const result = await callLLMWithModel(messages, model, MAX_RETRIES);
    if (result) {
      if (model !== requestedModel) {
        console.log(`[optimizer] using fallback model: ${model}`);
      }
      return result.content;
    }
  }
  
  throw new Error("All models failed - all rate limited or unavailable");
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

function computeSplitGw(startGw, endGw) {
  const totalGws = endGw - startGw + 1;
  if (totalGws < 6) return null;
  const testSize = Math.max(2, Math.round(totalGws * TEST_FRACTION));
  return endGw - testSize;
}

/**
 * Extract the new strategy.mjs code from the LLM response.
 * Expects a fenced code block with the full file contents.
 */
function extractCode(llmResponse) {
  // Try to find a fenced code block
  const fenceMatch = llmResponse.match(/```(?:javascript|js|mjs)?\s*\n([\s\S]*?)```/);
  if (fenceMatch) return fenceMatch[1].trim();

  // If no fence, check if the response looks like valid JS (starts with import/export/function/const/etc)
  const trimmed = llmResponse.trim();
  if (/^(?:\/\*[\s\S]*?\*\/\s*)?(?:import|export|function|const|let|var|\/\/)/.test(trimmed)) {
    return trimmed;
  }

  return null;
}

/**
 * Summarize recent experiment history for the LLM prompt.
 */
async function getExperimentSummary(maxRecent = 10) {
  const all = await getAllExperiments();
  const recent = all.slice(-maxRecent);
  if (!recent.length) return "No experiments run yet. This is the first attempt.";

  const best = all.filter(e => e.status === "keep").reduce(
    (best, e) => (!best || e.overall_avg_points > best.overall_avg_points ? e : best),
    null,
  );

  const lines = [];
  lines.push(`Total experiments: ${all.length}`);
  lines.push(`Best score: ${best ? best.overall_avg_points.toFixed(2) : "N/A"} (${best?.description ?? "N/A"})`);
  lines.push("");
  lines.push("Recent experiments:");
  for (const e of recent) {
    const status = e.status === "keep" ? "KEPT" : "DISCARDED";
    lines.push(`  #${e.id}: ${status} score=${e.overall_avg_points.toFixed(2)} — ${e.description}`);
  }
  return lines.join("\n");
}

// ── Main optimization cycle ─────────────────────────────────────────────────

export async function runOptimizationCycle() {
  await migrate();

  const cycleNumber = await getExperimentCount();
  const model = getModel();

  // 1. Read current state
  const [strategyCode, programMd, weightsJson] = await Promise.all([
    readFile(STRATEGY_PATH, "utf8"),
    readFile(PROGRAM_PATH, "utf8"),
    readFile(WEIGHTS_PATH, "utf8"),
  ]);

  const best = await getBestExperiment();
  const experimentSummary = await getExperimentSummary();

  // 2. Establish baseline if first run
  let parentScore;
  if (!best) {
    console.log("[optimizer] no baseline found, running initial backtest...");
    const baselineOutput = await runBacktest();
    const baselineResult = parseBacktestOutput(baselineOutput);
    parentScore = baselineResult.overallAvgPoints;

    await insertExperiment({
      overallAvgPoints: baselineResult.overallAvgPoints,
      hitRate: baselineResult.hitRate,
      weights: JSON.parse(weightsJson),
      description: "baseline",
      status: "keep",
      trainAvgPoints: baselineResult.trainAvgPoints,
      testAvgPoints: baselineResult.testAvgPoints,
      parentScore: null,
      temperature: null,
    });
    console.log(`[optimizer] baseline: avg=${parentScore.toFixed(2)}`);
  } else {
    parentScore = best.overall_avg_points;
    console.log(`[optimizer] current best: avg=${parentScore.toFixed(2)}, cycle=${cycleNumber}, model=${model}`);
  }

  // 3. Ask the LLM to propose a change
  console.log(`[optimizer] asking ${model} for a code change...`);

  const systemPrompt = `You are an autonomous FPL (Fantasy Premier League) research agent. Your job is to improve the player scoring and selection strategy by modifying strategy.mjs.

## Rules
- You MUST output the COMPLETE modified strategy.mjs file inside a single \`\`\`javascript code fence
- Make exactly ONE focused change per experiment (one new feature, one formula tweak, one logic change)
- Keep all existing imports and exports — do not break the module interface
- The file must be valid ES module JavaScript (import/export, no require)
- Do not add external dependencies — only use built-in Node.js modules and imports from ./run.mjs
- Available imports from ./run.mjs: toNumber, clamp, mean, sum, getPlayerId, getTeamId, getPosition, groupRowsByPlayer, POSITION_NAMES, AVAILABILITY_BY_STATUS

## What you can change
- Feature engineering: add new features, modify normalization divisors, change how features are computed
- Scoring formula: change how features are weighted/combined (beyond just the weights.json numbers)
- Transfer logic: improve how transfers are planned (thresholds, gain calculations, number of transfers)
- Squad selection: improve budget squad building, starting 11 selection, captain picks
- Player filtering: adjust eligibility criteria
- Chip strategy: improve wildcard/free-hit/bench-boost timing

## What NOT to change
- Do not modify the function signatures or return types (other code depends on them)
- Do not add console.log or debug output
- Do not import external packages`;

  const userPrompt = `## Program objectives
${programMd}

## Current weights.json
${weightsJson}

## Experiment history
${experimentSummary}

## Current strategy.mjs
\`\`\`javascript
${strategyCode}
\`\`\`

## Your task
Propose ONE improvement to strategy.mjs to increase the backtest avg_points_per_gw metric (currently ${parentScore.toFixed(2)}).

Look at the experiment history to avoid repeating failed ideas. Think about what could meaningfully improve player selection — new features, better normalization, smarter transfer logic, etc.

First, briefly explain your idea (2-3 sentences), then output the COMPLETE modified strategy.mjs inside a \`\`\`javascript code fence.`;

  let llmResponse;
  try {
    llmResponse = await callLLM([
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ]);
  } catch (err) {
    console.error(`[optimizer] LLM call failed: ${err.message}`);
    await insertExperiment({
      overallAvgPoints: 0,
      hitRate: 0,
      weights: JSON.parse(weightsJson),
      description: `LLM error: ${err.message.slice(0, 100)}`,
      status: "crash",
      parentScore,
      temperature: null,
    });
    return;
  }

  // 4. Extract the code from the response
  const newCode = extractCode(llmResponse);
  if (!newCode) {
    console.error("[optimizer] LLM response did not contain a valid code block");
    await insertExperiment({
      overallAvgPoints: 0,
      hitRate: 0,
      weights: JSON.parse(weightsJson),
      description: "LLM response had no code block",
      status: "crash",
      parentScore,
      temperature: null,
    });
    return;
  }

  // Extract description from the LLM's explanation (before the code fence)
  const descriptionMatch = llmResponse.split("```")[0].trim();
  const description = descriptionMatch.slice(0, 200) || "LLM-proposed change";

  console.log(`[optimizer] idea: ${description.slice(0, 100)}...`);

  // 5. Save trial code and verify syntax
  const originalCode = strategyCode;
  await writeFile(STRATEGY_PATH, newCode, "utf8");

  // Quick syntax check
  try {
    const { execFileSync } = await import("node:child_process");
    execFileSync(process.execPath, ["--check", STRATEGY_PATH], { cwd: ROOT, timeout: 10_000 });
  } catch (syntaxErr) {
    console.error("[optimizer] syntax error in LLM output, reverting");
    await writeFile(STRATEGY_PATH, originalCode, "utf8");
    await insertExperiment({
      overallAvgPoints: 0,
      hitRate: 0,
      weights: JSON.parse(weightsJson),
      description: `syntax error: ${description.slice(0, 150)}`,
      status: "crash",
      parentScore,
      temperature: null,
    });
    return;
  }

  // 6. Run backtest with trial code
  let trialResult;
  const splitGw = computeSplitGw(6, 31);
  try {
    const output = await runBacktest(splitGw);
    trialResult = parseBacktestOutput(output);
  } catch (err) {
    console.error(`[optimizer] backtest crashed: ${err.message}`);
    await writeFile(STRATEGY_PATH, originalCode, "utf8");
    await insertExperiment({
      overallAvgPoints: 0,
      hitRate: 0,
      weights: JSON.parse(weightsJson),
      description: `backtest crash: ${description.slice(0, 150)}`,
      status: "crash",
      parentScore,
      temperature: null,
    });
    return;
  }

  // 7. Acceptance decision — pure greedy (like Karpathy)
  const trialScore = trialResult.overallAvgPoints;
  let accepted = trialScore > parentScore;
  let rejectReason = accepted ? null : `worse: ${trialScore.toFixed(2)} <= ${parentScore.toFixed(2)}`;

  // Overfitting guard
  if (accepted && trialResult.testAvgPoints !== null && best?.test_avg_points) {
    if (trialResult.testAvgPoints < best.test_avg_points - TEST_DEGRADATION_LIMIT) {
      accepted = false;
      rejectReason = `test degraded: ${trialResult.testAvgPoints.toFixed(2)} < ${best.test_avg_points.toFixed(2)} - ${TEST_DEGRADATION_LIMIT}`;
    }
  }

  if (accepted) {
    const delta = trialScore - parentScore;
    console.log(
      `[optimizer] IMPROVED: ${trialScore.toFixed(2)} (Δ=+${delta.toFixed(3)})`,
    );
    await insertExperiment({
      overallAvgPoints: trialResult.overallAvgPoints,
      hitRate: trialResult.hitRate,
      weights: JSON.parse(weightsJson),
      description,
      status: "keep",
      trainAvgPoints: trialResult.trainAvgPoints,
      testAvgPoints: trialResult.testAvgPoints,
      parentScore,
      temperature: null,
    });
    // strategy.mjs already has the improved code
  } else {
    console.log(
      `[optimizer] DISCARD: ${trialScore.toFixed(2)} (reason=${rejectReason})`,
    );
    await writeFile(STRATEGY_PATH, originalCode, "utf8");
    await insertExperiment({
      overallAvgPoints: trialResult.overallAvgPoints,
      hitRate: trialResult.hitRate,
      weights: JSON.parse(weightsJson),
      description,
      status: "discard",
      trainAvgPoints: trialResult.trainAvgPoints,
      testAvgPoints: trialResult.testAvgPoints,
      parentScore,
      temperature: null,
    });
  }

  // 8. Re-run report with current best code
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
