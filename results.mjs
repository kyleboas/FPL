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
export const PERSISTED_STRATEGY_PATH = DATA_DIR ? join(DATA_DIR, "strategy.mjs") : null;

const RESULTS_HEADER = "commit\tavg_points_per_gw\ttotal_hit_cost\tstatus\tdescription\n";

function parseNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
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
    const [commit = "", avg = "", hitCost = "", status = "", ...descriptionParts] = line.split("\t");
    return {
      id: index + 1,
      commit,
      avg_points_per_gw: parseNumber(avg),
      total_hit_cost: parseNumber(hitCost),
      status,
      description: descriptionParts.join("\t"),
    };
  });
}

export async function appendResult({ commit, avgPointsPerGw, totalHitCost, status, description }) {
  await ensureResultsFile();
  const row = [
    commit,
    parseNumber(avgPointsPerGw).toFixed(2),
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
  return kept.reduce((best, result) => (
    result.avg_points_per_gw > best.avg_points_per_gw ? result : best
  ));
}

export async function persistAcceptedStrategy(strategyPath) {
  if (!PERSISTED_STRATEGY_PATH) return;
  await ensureDataDir();
  await copyFile(strategyPath, PERSISTED_STRATEGY_PATH);
}

export async function syncPersistedStrategy(strategyPath) {
  if (!PERSISTED_STRATEGY_PATH || !existsSync(PERSISTED_STRATEGY_PATH)) return false;
  await copyFile(PERSISTED_STRATEGY_PATH, strategyPath);
  return true;
}

export async function resetAutoresearchState(repoStrategyPath) {
  await ensureDataDir();

  if (PERSISTED_STRATEGY_PATH) {
    await copyFile(repoStrategyPath, PERSISTED_STRATEGY_PATH);
  }

  for (const path of [RESULTS_PATH, RUN_LOG_PATH, PROGRESS_SVG_PATH, REPORT_PATH]) {
    if (existsSync(path)) {
      await rm(path, { force: true });
    }
  }

  await ensureResultsFile();
}
