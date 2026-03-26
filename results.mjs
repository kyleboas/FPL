#!/usr/bin/env node

import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const DATA_DIR = process.env.DATA_DIR || null;

export const RESULTS_PATH = DATA_DIR ? join(DATA_DIR, "results.tsv") : join(ROOT, "results.tsv");
export const RUN_LOG_PATH = DATA_DIR ? join(DATA_DIR, "run.log") : join(ROOT, "run.log");
export const PROGRESS_SVG_PATH = DATA_DIR ? join(DATA_DIR, "progress.svg") : join(ROOT, "progress.svg");
export const REPORT_PATH = DATA_DIR ? join(DATA_DIR, "latest-report.md") : join(ROOT, "autoresearch-fpl", "latest-report.md");
export const PERSISTED_WEIGHTS_PATH = DATA_DIR ? join(DATA_DIR, "weights.json") : null;

const RESULTS_HEADER = "timestamp\tcommit\tavg_points_per_gw\tholdout_avg_points\tholdout_gap\ttotal_hit_cost\tstatus\tdescription\n";

function parseNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function parseNullableNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function normalizeDescription(value) {
  return String(value ?? "")
    .replace(/\t+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function ensureDataDir() {
  if (DATA_DIR) {
    await mkdir(DATA_DIR, { recursive: true });
  }
}

export async function ensureResultsFile() {
  await ensureDataDir();
  if (!existsSync(RESULTS_PATH)) {
    await writeFile(RESULTS_PATH, RESULTS_HEADER, "utf8");
  }
}

export async function readResults() {
  await ensureResultsFile();
  const raw = await readFile(RESULTS_PATH, "utf8");
  const lines = raw.trim().split("\n").slice(1).filter(Boolean);
  return lines.map((line, index) => {
    const parts = line.split("\t");

    if (parts.length >= 8) {
      const [
        timestamp = "",
        commit = "",
        avg = "",
        holdoutAvg = "",
        holdoutGap = "",
        hitCost = "",
        status = "",
        ...descriptionParts
      ] = parts;
      return {
        id: index + 1,
        timestamp,
        commit,
        avg_points_per_gw: parseNumber(avg),
        holdout_avg_points: parseNullableNumber(holdoutAvg),
        holdout_gap: parseNullableNumber(holdoutGap),
        total_hit_cost: parseNumber(hitCost),
        status,
        description: descriptionParts.join("\t"),
      };
    }

    const [commit = "", avg = "", hitCost = "", status = "", ...descriptionParts] = parts;
    return {
      id: index + 1,
      timestamp: "",
      commit,
      avg_points_per_gw: parseNumber(avg),
      holdout_avg_points: null,
      holdout_gap: null,
      total_hit_cost: parseNumber(hitCost),
      status,
      description: descriptionParts.join("\t"),
    };
  });
}

export async function appendResult({
  timestamp = new Date().toISOString(),
  commit,
  avgPointsPerGw,
  holdoutAvgPoints = null,
  holdoutGap = null,
  totalHitCost,
  status,
  description,
}) {
  await ensureResultsFile();
  const row = [
    timestamp,
    commit,
    parseNumber(avgPointsPerGw).toFixed(2),
    holdoutAvgPoints === null ? "" : parseNumber(holdoutAvgPoints).toFixed(2),
    holdoutGap === null ? "" : parseNumber(holdoutGap).toFixed(2),
    Math.round(parseNumber(totalHitCost)).toString(),
    status,
    normalizeDescription(description),
  ].join("\t");
  await writeFile(RESULTS_PATH, `${await readFile(RESULTS_PATH, "utf8")}${row}\n`, "utf8");
}

export async function getBestKeptResult() {
  const results = await readResults();
  const kept = results.filter((result) => result.status === "keep");
  if (!kept.length) return null;
  return kept.reduce((best, result) => {
    if (result.avg_points_per_gw !== best.avg_points_per_gw) {
      return result.avg_points_per_gw > best.avg_points_per_gw ? result : best;
    }
    const bestHoldout = best.holdout_avg_points ?? Number.NEGATIVE_INFINITY;
    const resultHoldout = result.holdout_avg_points ?? Number.NEGATIVE_INFINITY;
    return resultHoldout > bestHoldout ? result : best;
  });
}

export async function persistAcceptedWeights(weightsPath) {
  if (!PERSISTED_WEIGHTS_PATH) return;
  await ensureDataDir();
  await copyFile(weightsPath, PERSISTED_WEIGHTS_PATH);
}

export async function syncPersistedWeights(weightsPath) {
  if (!PERSISTED_WEIGHTS_PATH || !existsSync(PERSISTED_WEIGHTS_PATH)) return false;
  await copyFile(PERSISTED_WEIGHTS_PATH, weightsPath);
  return true;
}

export async function resetAutoresearchState(_repoStrategyPath, repoWeightsPath = null) {
  await ensureDataDir();

  if (repoWeightsPath && PERSISTED_WEIGHTS_PATH) {
    await copyFile(repoWeightsPath, PERSISTED_WEIGHTS_PATH);
  }

  for (const path of [RESULTS_PATH, RUN_LOG_PATH, PROGRESS_SVG_PATH, REPORT_PATH]) {
    if (existsSync(path)) {
      await rm(path, { force: true });
    }
  }

  await ensureResultsFile();
}
