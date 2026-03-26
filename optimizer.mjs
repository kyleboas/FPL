#!/usr/bin/env node

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { generateChart } from "./chart.mjs";
import {
  appendResult,
  ensureResultsFile,
  getBestKeptResult,
  persistAcceptedStrategy,
  readResults,
  RUN_LOG_PATH,
  syncPersistedStrategy,
  RESULTS_PATH,
} from "./results.mjs";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const STRATEGY_PATH = join(ROOT, "autoresearch-fpl", "strategy.mjs");
const PROGRAM_PATH = join(ROOT, "autoresearch-fpl", "program.md");
const WEIGHTS_PATH = join(ROOT, "autoresearch-fpl", "weights.json");
const RUN_SCRIPT = join(ROOT, "autoresearch-fpl", "run.mjs");
const CONFIG_PATH = join(ROOT, "autoresearch-fpl", "config.json");
const DATA_DIR = process.env.DATA_DIR || null;
export const DIFFS_DIR = DATA_DIR ? join(DATA_DIR, "diffs") : join(ROOT, "diffs");

const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_PROVIDER = "openrouter";
const DEFAULT_MODEL = "qwen/qwen3-4b:free";
const FALLBACK_MODELS_OPENROUTER = [
  "google/gemma-3-27b-it:free",
  "qwen/qwen3-coder:free",
  "meta-llama/llama-3.3-8b-instruct:free",
  "google/gemini-2.0-flash-001",
];
const FALLBACK_MODELS_CLOUDFLARE = [
  "openai/gpt-4.1-mini",
  "workers-ai/@cf/meta/llama-3.1-8b-instruct-fp8-fast",
  "workers-ai/@cf/qwen/qwen3-30b-a3b-fp8",
];
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 8000;
const GENERATION_TEMPERATURE = Number(process.env.LLM_TEMPERATURE ?? "0.8");
const GENERATION_MAX_TOKENS = Number(process.env.LLM_MAX_TOKENS ?? "12000");
const REPORT_ENABLED = process.env.DATA_DIR ? process.env.GENERATE_REPORT_AFTER_EXPERIMENTS !== "0" : false;

let cachedConfig = null;

/**
 * Compute a unified diff between old and new code.
 * Returns a diff string with +/- line prefixes.
 */
function computeDiff(oldCode, newCode, contextLines = 3) {
  const oldLines = oldCode.split("\n");
  const newLines = newCode.split("\n");
  const diff = [];
  
  // Find all changes using LCS approach
  const changes = [];
  let i = 0, j = 0;
  
  while (i < oldLines.length || j < newLines.length) {
    if (i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j]) {
      i++; j++;
    } else {
      // Find extent of change
      const oldStart = i;
      const newStart = j;
      
      // Look ahead for next match
      let foundMatch = false;
      for (let k = i; k < Math.min(oldLines.length, i + 30) && !foundMatch; k++) {
        for (let l = j; l < Math.min(newLines.length, j + 30) && !foundMatch; l++) {
          if (oldLines[k] === newLines[l]) {
            changes.push({ oldStart, oldEnd: k, newStart, newEnd: l });
            i = k;
            j = l;
            foundMatch = true;
          }
        }
      }
      
      if (!foundMatch) {
        // Change extends to end
        changes.push({ oldStart, oldEnd: oldLines.length, newStart, newEnd: newLines.length });
        i = oldLines.length;
        j = newLines.length;
      }
    }
  }
  
  // Generate diff output
  for (const change of changes) {
    const oldStart = Math.max(0, change.oldStart - contextLines);
    const oldEnd = Math.min(oldLines.length, change.oldEnd + contextLines);
    
    diff.push(`@@ -${change.oldStart + 1},${change.oldEnd - change.oldStart} +${change.newStart + 1},${change.newEnd - change.newStart} @@`);
    
    // Show context before
    for (let k = oldStart; k < change.oldStart; k++) {
      diff.push(`  ${oldLines[k]}`);
    }
    
    // Show removed lines
    for (let k = change.oldStart; k < change.oldEnd; k++) {
      diff.push(`- ${oldLines[k]}`);
    }
    
    // Show added lines
    for (let k = change.newStart; k < change.newEnd; k++) {
      diff.push(`+ ${newLines[k]}`);
    }
    
    // Show context after
    for (let k = change.oldEnd; k < oldEnd; k++) {
      diff.push(`  ${oldLines[k]}`);
    }
  }
  
  return diff.join("\n");
}

/**
 * Save diff to file and return the path.
 */
async function saveDiff(revision, diff) {
  if (!existsSync(DIFFS_DIR)) {
    await mkdir(DIFFS_DIR, { recursive: true });
  }
  const diffPath = join(DIFFS_DIR, `${revision}.diff`);
  await writeFile(diffPath, diff, "utf8");
  return diffPath;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      if (error) {
        const err = new Error(stderr || stdout || error.message);
        err.stdout = stdout;
        err.stderr = stderr;
        err.code = error.code;
        reject(err);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function loadConfig() {
  if (cachedConfig) return cachedConfig;
  try {
    cachedConfig = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
  } catch {
    cachedConfig = {};
  }
  return cachedConfig;
}

async function getProvider() {
  if (process.env.LLM_PROVIDER) return process.env.LLM_PROVIDER;
  const config = await loadConfig();
  return config.llm?.provider || DEFAULT_PROVIDER;
}

async function getModel(provider) {
  if (provider === "cloudflare" && process.env.CF_MODEL) return process.env.CF_MODEL;
  if (provider !== "cloudflare" && process.env.OPENROUTER_MODEL) return process.env.OPENROUTER_MODEL;
  if (process.env.CF_MODEL || process.env.OPENROUTER_MODEL) {
    return process.env.CF_MODEL || process.env.OPENROUTER_MODEL;
  }
  const config = await loadConfig();
  return config.llm?.model || DEFAULT_MODEL;
}

async function getFallbackModels(provider) {
  const config = await loadConfig();
  if (config.llm?.fallbackModels?.length) {
    if (provider === "cloudflare") return config.llm.fallbackModels;
    const filtered = config.llm.fallbackModels.filter((model) => !model.startsWith("workers-ai/"));
    if (filtered.length) return filtered;
  }
  return provider === "cloudflare" ? FALLBACK_MODELS_CLOUDFLARE : FALLBACK_MODELS_OPENROUTER;
}

function getOpenRouterApiKey() {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error("OPENROUTER_API_KEY environment variable is required");
  return key;
}

function getCloudflareConfig() {
  const gatewayUrl = process.env.CF_GATEWAY_URL;
  const token = process.env.CF_AIG_TOKEN;
  if (!gatewayUrl || !token) {
    throw new Error("CF_GATEWAY_URL and CF_AIG_TOKEN are required for Cloudflare provider");
  }

  const baseUrl = gatewayUrl.replace(/\/$/, "");
  const url = baseUrl.endsWith("/compat/chat/completions")
    ? baseUrl
    : baseUrl.endsWith("/compat")
      ? `${baseUrl}/chat/completions`
      : `${baseUrl}/compat/chat/completions`;

  return { url, token };
}

async function callOpenRouterWithModel(messages, model) {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
    const response = await fetch(OPENROUTER_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${getOpenRouterApiKey()}`,
        "HTTP-Referer": "https://github.com/kyleboas/FPL",
        "X-Title": "FPL Autoresearch",
      },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: GENERATION_MAX_TOKENS,
        temperature: GENERATION_TEMPERATURE,
      }),
    });

    if (response.ok) {
      const data = await response.json();
      return data.choices?.[0]?.message?.content ?? "";
    }

    const errorText = await response.text();
    if (response.status === 429) {
      const upstreamRateLimit = errorText.includes("rate-limited upstream") || errorText.includes("Provider returned error");
      if (upstreamRateLimit) return null;
      if (attempt < MAX_RETRIES - 1) {
        await delay(BASE_DELAY_MS * (2 ** attempt));
        continue;
      }
    }

    throw new Error(`OpenRouter API error (${response.status}): ${errorText}`);
  }

  return null;
}

async function callCloudflareWithModel(messages, model) {
  const { url, token } = getCloudflareConfig();

  for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "cf-aig-authorization": `Bearer ${token}`,
      },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: GENERATION_MAX_TOKENS,
        temperature: GENERATION_TEMPERATURE,
      }),
    });

    if (response.ok) {
      const data = await response.json();
      return data.choices?.[0]?.message?.content ?? "";
    }

    const errorText = await response.text();
    if (response.status === 429) return null;
    if (response.status >= 500 && attempt < MAX_RETRIES - 1) {
      await delay(BASE_DELAY_MS * (2 ** attempt));
      continue;
    }

    throw new Error(`Cloudflare API error (${response.status}): ${errorText}`);
  }

  return null;
}

async function callLLM(messages) {
  const provider = await getProvider();
  const requestedModel = await getModel(provider);
  const fallbackModels = await getFallbackModels(provider);
  const modelsToTry = [requestedModel, ...fallbackModels.filter((model) => model !== requestedModel)];

  console.log(`[optimizer] using ${provider} provider`);

  for (let index = 0; index < modelsToTry.length; index += 1) {
    const model = modelsToTry[index];
    console.log(`[optimizer] trying model: ${model}`);
    const content = provider === "cloudflare"
      ? await callCloudflareWithModel(messages, model)
      : await callOpenRouterWithModel(messages, model);

    if (content) return { content, model };
    if (index < modelsToTry.length - 1) {
      await delay(2000);
    }
  }

  throw new Error("All models failed");
}

function parseBacktestOutput(output) {
  const avgMatch = output.match(/avg_points_per_gw:\s*([\d.]+)/);
  const hitMatch = output.match(/total_hit_cost:\s*([\d.]+)/);
  return {
    avgPointsPerGw: avgMatch ? Number.parseFloat(avgMatch[1]) : null,
    totalHitCost: hitMatch ? Number.parseFloat(hitMatch[1]) : 0,
  };
}

function extractCode(response) {
  const fenced = response.match(/```(?:javascript|js|mjs)?\s*\n([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();

  const trimmed = response.trim();
  if (/^(?:\/\*[\s\S]*?\*\/\s*)?(?:import|export|function|const|let|var)/.test(trimmed)) {
    return trimmed;
  }

  return null;
}

function extractRequiredExports(strategyCode) {
  return [...strategyCode.matchAll(/export function\s+([A-Za-z0-9_]+)/g)].map((match) => match[1]);
}

function findMissingExports(code, requiredExports) {
  return requiredExports.filter((name) => {
    const pattern = new RegExp(`export\\s+(?:async\\s+)?function\\s+${name}\\b|export\\s+(?:const|let|var)\\s+${name}\\b`);
    return !pattern.test(code);
  });
}

function summarizeIdea(response) {
  return response.split("```")[0].replace(/\s+/g, " ").trim().slice(0, 500) || "LLM-proposed strategy change";
}

function strategyRevision(code) {
  return createHash("sha1").update(code).digest("hex").slice(0, 7);
}

async function getExperimentSummary(limit = 10) {
  const results = await readResults();
  if (!results.length) {
    return "No experiments run yet. The first run should establish the baseline.";
  }

  const best = await getBestKeptResult();
  const recent = results.slice(-limit);
  const lines = [
    `Total experiments: ${results.length}`,
    `Best score: ${best ? best.avg_points_per_gw.toFixed(2) : "N/A"} (${best?.description ?? "N/A"})`,
    "",
    "Recent experiments:",
  ];

  for (const result of recent) {
    lines.push(`  ${result.commit}: ${result.status.toUpperCase()} score=${result.avg_points_per_gw.toFixed(2)} — ${result.description}`);
  }

  return lines.join("\n");
}

async function runBacktestToLog() {
  try {
    const { stdout, stderr } = await runCommand(
      process.execPath,
      [RUN_SCRIPT, "backtest"],
      { cwd: ROOT, timeout: 120_000 },
    );
    const combined = `${stdout}${stderr}`;
    await writeFile(RUN_LOG_PATH, combined, "utf8");
    return combined;
  } catch (error) {
    const combined = `${error.stdout ?? ""}${error.stderr ?? ""}`.trim() || error.message;
    await writeFile(RUN_LOG_PATH, combined, "utf8");
    throw error;
  }
}

async function runReport() {
  if (!REPORT_ENABLED) return;
  await runCommand(
    process.execPath,
    [RUN_SCRIPT, "report"],
    {
      cwd: ROOT,
      timeout: 60_000,
      env: { ...process.env, DATA_DIR: process.env.DATA_DIR },
    },
  );
}

async function ensureBaseline() {
  const results = await readResults();
  if (results.length) return;

  console.log("[optimizer] no baseline found, running initial backtest...");
  const strategyCode = await readFile(STRATEGY_PATH, "utf8");
  const output = await runBacktestToLog();
  const baseline = parseBacktestOutput(output);
  if (baseline.avgPointsPerGw == null) {
    throw new Error("baseline run did not produce avg_points_per_gw");
  }

  await appendResult({
    commit: strategyRevision(strategyCode),
    avgPointsPerGw: baseline.avgPointsPerGw,
    totalHitCost: baseline.totalHitCost,
    status: "keep",
    description: "baseline",
  });
  await persistAcceptedStrategy(STRATEGY_PATH);
  await runReport();
  await generateChart();
  console.log(`[optimizer] baseline: avg=${baseline.avgPointsPerGw.toFixed(2)}`);
}

export async function runOptimizationCycle() {
  await ensureResultsFile();
  await syncPersistedStrategy(STRATEGY_PATH);
  await ensureBaseline();

  const parentResult = await getBestKeptResult();
  const [strategyCode, programMd, weightsJson] = await Promise.all([
    readFile(STRATEGY_PATH, "utf8"),
    readFile(PROGRAM_PATH, "utf8"),
    readFile(WEIGHTS_PATH, "utf8"),
  ]);
  const parentRevision = strategyRevision(strategyCode);
  const parentScore = parentResult?.avg_points_per_gw ?? 0;
  const experimentSummary = await getExperimentSummary();
  const requiredExports = extractRequiredExports(strategyCode);
  const provider = await getProvider();
  const requestedModel = await getModel(provider);

  console.log(`[optimizer] strategy=${parentRevision} best=${parentScore.toFixed(2)} model=${requestedModel}`);

  const systemPrompt = `You are an autonomous FPL (Fantasy Premier League) research agent. Your job is to improve strategy.mjs.

Rules:
- Output the COMPLETE modified strategy.mjs inside one javascript code fence
- Make exactly ONE focused change per experiment
- Keep all imports and exports intact
- Preserve every existing export exactly once: ${requiredExports.join(", ")}
- Do not add dependencies
- Do not edit any file except strategy.mjs
- **CRITICAL: Try DIFFERENT areas each time. If captain selection was already tried, try transfer logic, scoring formulas, player filtering, chip strategy, or feature engineering instead.**

The fixed harness is run.mjs. The metric is avg_points_per_gw from node autoresearch-fpl/run.mjs backtest. Higher is better.`;

  const userPrompt = `## Program
${programMd}

## Current weights.json
${weightsJson}

## Experiment history
${experimentSummary}

## Current strategy.mjs
\`\`\`javascript
${strategyCode}
\`\`\`

## Task
Propose one focused change to improve avg_points_per_gw over ${parentScore.toFixed(2)}.

**IMPORTANT: Look at the experiment history above. If similar ideas were already tried and discarded, try a completely different area of the code:**
- Transfer planning logic (how transfers are prioritized and executed)
- Player scoring formula (how features are combined and weighted)
- Player filtering/eligibility (who gets considered)
- Chip strategy (wildcard, free-hit, bench-boost timing)
- Feature engineering (new features, normalization)

Briefly explain the idea in 2-3 sentences, then output the COMPLETE strategy.mjs file in a javascript code fence.`;

  let llmOutput;
  try {
    llmOutput = await callLLM([
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ]);
  } catch (error) {
    console.error(`[optimizer] LLM call failed: ${error.message}`);
    await appendResult({
      commit: parentRevision,
      avgPointsPerGw: 0,
      totalHitCost: 0,
      status: "crash",
      description: `llm error: ${error.message.slice(0, 120)}`,
    });
    await generateChart();
    return;
  }

  const newCode = extractCode(llmOutput.content);
  const description = summarizeIdea(llmOutput.content);
  if (!newCode || newCode === strategyCode) {
    console.log("[optimizer] no valid code change proposed");
    await appendResult({
      commit: parentRevision,
      avgPointsPerGw: parentScore,
      totalHitCost: parentResult?.total_hit_cost ?? 0,
      status: "discard",
      description: `no-op: ${description}`,
    });
    await generateChart();
    return;
  }

  await writeFile(STRATEGY_PATH, newCode, "utf8");
  const trialRevision = strategyRevision(newCode);
  
  // Compute and save diff
  const codeDiff = computeDiff(strategyCode, newCode);
  await saveDiff(trialRevision, codeDiff);
  
  // Verbose log: PROPOSED CHANGE
  console.log("\n" + "═".repeat(60));
  console.log("[optimizer] PROPOSED CHANGE");
  console.log(`[optimizer]   revision: ${parentRevision} → ${trialRevision}`);
  console.log(`[optimizer]   idea: ${description.slice(0, 80)}`);
  console.log("[optimizer]   diff:");
  for (const line of codeDiff.split("\n").slice(0, 30)) {
    console.log(`[optimizer]     ${line}`);
  }
  if (codeDiff.split("\n").length > 30) {
    console.log(`[optimizer]     ... (${codeDiff.split("\n").length - 30} more lines)`);
  }
  console.log("═".repeat(60) + "\n");

  const missingExports = findMissingExports(newCode, requiredExports);
  if (missingExports.length) {
    console.error(`[optimizer] missing required exports: ${missingExports.join(", ")}`);
    console.log("\n" + "═".repeat(60));
    console.log("[optimizer] ✗ CRASH - MISSING EXPORTS");
    console.log(`[optimizer]   missing: ${missingExports.join(", ")}`);
    console.log("═".repeat(60) + "\n");
    await appendResult({
      commit: trialRevision,
      avgPointsPerGw: 0,
      totalHitCost: 0,
      status: "crash",
      description: `missing exports: ${missingExports.join(", ")}`,
    });
    await writeFile(STRATEGY_PATH, strategyCode, "utf8");
    await generateChart();
    return;
  }

  let trialOutput;
  let trialResult;
  try {
    trialOutput = await runBacktestToLog();
    trialResult = parseBacktestOutput(trialOutput);
    if (trialResult.avgPointsPerGw == null) {
      throw new Error("backtest output missing avg_points_per_gw");
    }
  } catch (error) {
    console.error(`[optimizer] backtest crashed: ${error.message}`);
    console.log("\n" + "═".repeat(60));
    console.log("[optimizer] ✗ CRASH - BACKTEST FAILED");
    console.log(`[optimizer]   error: ${error.message.slice(0, 100)}`);
    console.log("═".repeat(60) + "\n");
    await appendResult({
      commit: trialRevision,
      avgPointsPerGw: 0,
      totalHitCost: 0,
      status: "crash",
      description: `backtest crash: ${description}`,
    });
    await writeFile(STRATEGY_PATH, strategyCode, "utf8");
    await generateChart();
    return;
  }

  if (trialResult.avgPointsPerGw > parentScore) {
    const delta = trialResult.avgPointsPerGw - parentScore;
    console.log("\n" + "═".repeat(60));
    console.log("[optimizer] ✓ KEEP - IMPROVED");
    console.log(`[optimizer]   score: ${parentScore.toFixed(2)} → ${trialResult.avgPointsPerGw.toFixed(2)}`);
    console.log(`[optimizer]   delta: +${delta.toFixed(3)}`);
    console.log(`[optimizer]   revision: ${trialRevision}`);
    console.log("═".repeat(60) + "\n");
    await appendResult({
      commit: trialRevision,
      avgPointsPerGw: trialResult.avgPointsPerGw,
      totalHitCost: trialResult.totalHitCost,
      status: "keep",
      description,
    });
    await persistAcceptedStrategy(STRATEGY_PATH);
    await runReport();
  } else {
    console.log("\n" + "═".repeat(60));
    console.log("[optimizer] ✗ DISCARD - NO IMPROVEMENT");
    console.log(`[optimizer]   score: ${parentScore.toFixed(2)} → ${trialResult.avgPointsPerGw.toFixed(2)}`);
    console.log(`[optimizer]   revision: ${trialRevision}`);
    console.log("═".repeat(60) + "\n");
    await appendResult({
      commit: trialRevision,
      avgPointsPerGw: trialResult.avgPointsPerGw,
      totalHitCost: trialResult.totalHitCost,
      status: "discard",
      description,
    });
    await writeFile(STRATEGY_PATH, strategyCode, "utf8");
  }

  await generateChart();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runOptimizationCycle().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
