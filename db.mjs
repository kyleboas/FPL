#!/usr/bin/env node

/**
 * Minimal Postgres helper using psql CLI.
 *
 * Expects DATABASE_URL in the environment (standard Railway Postgres).
 * Falls back to a local JSON file when DATABASE_URL is not set.
 */

import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const LOCAL_FILE = join(ROOT, "experiments.json");

function getDatabaseUrl() {
  return process.env.DATABASE_URL || "";
}

// ── psql runner ─────────────────────────────────────────────────────────────

function psql(sql) {
  const url = getDatabaseUrl();
  if (!url) return Promise.reject(new Error("DATABASE_URL not set"));

  return new Promise((resolve, reject) => {
    execFile(
      "psql",
      [url, "-t", "-A", "-F", "\t", "-c", sql],
      { timeout: 15_000 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(`psql error: ${stderr || err.message}`));
        resolve(stdout.trim());
      },
    );
  });
}

// ── Migrations ──────────────────────────────────────────────────────────────

export async function migrate() {
  if (!getDatabaseUrl()) {
    // Ensure local file exists
    try {
      await readFile(LOCAL_FILE, "utf8");
    } catch {
      await writeFile(LOCAL_FILE, "[]", "utf8");
    }
    console.log("[db] using local experiments.json (no DATABASE_URL)");
    return;
  }

  await psql(`
    CREATE TABLE IF NOT EXISTS experiments (
      id SERIAL PRIMARY KEY,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      overall_avg_points REAL NOT NULL,
      hit_rate REAL NOT NULL,
      weights_json TEXT NOT NULL,
      description TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'keep'
    )
  `);
  console.log("[db] experiments table ready");
}

// ── Read / Write ────────────────────────────────────────────────────────────

async function readLocal() {
  try {
    const raw = await readFile(LOCAL_FILE, "utf8");
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

async function writeLocal(rows) {
  await writeFile(LOCAL_FILE, JSON.stringify(rows, null, 2), "utf8");
}

export async function insertExperiment({ overallAvgPoints, hitRate, weights, description, status }) {
  const weightsJson = JSON.stringify(weights);

  if (!getDatabaseUrl()) {
    const rows = await readLocal();
    rows.push({
      id: rows.length + 1,
      created_at: new Date().toISOString(),
      overall_avg_points: overallAvgPoints,
      hit_rate: hitRate,
      weights_json: weightsJson,
      description,
      status,
    });
    await writeLocal(rows);
    return;
  }

  const escaped = (s) => s.replace(/'/g, "''");
  await psql(`
    INSERT INTO experiments (overall_avg_points, hit_rate, weights_json, description, status)
    VALUES (${overallAvgPoints}, ${hitRate}, '${escaped(weightsJson)}', '${escaped(description)}', '${escaped(status)}')
  `);
}

export async function getAllExperiments() {
  if (!getDatabaseUrl()) {
    return readLocal();
  }

  const raw = await psql(`
    SELECT id, created_at, overall_avg_points, hit_rate, description, status
    FROM experiments ORDER BY id ASC
  `);

  if (!raw) return [];

  return raw.split("\n").map((line) => {
    const [id, created_at, overall_avg_points, hit_rate, description, status] = line.split("\t");
    return {
      id: Number(id),
      created_at,
      overall_avg_points: Number(overall_avg_points),
      hit_rate: Number(hit_rate),
      description,
      status,
    };
  });
}

export async function getBestExperiment() {
  const all = await getAllExperiments();
  const kept = all.filter((e) => e.status === "keep");
  if (!kept.length) return null;
  return kept.reduce((best, e) => (e.overall_avg_points > best.overall_avg_points ? e : best));
}

/**
 * Returns the weights object from the best kept experiment, or null if none.
 * Used by optimizer to seed from Postgres rather than the on-disk weights.json.
 */
export async function loadActiveWeights() {
  if (!getDatabaseUrl()) return null;

  const raw = await psql(`
    SELECT weights_json FROM experiments
    WHERE status = 'keep'
    ORDER BY overall_avg_points DESC LIMIT 1
  `);

  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
