#!/usr/bin/env node

/**
 * Minimal Postgres helper using node-postgres (pg).
 *
 * Expects DATABASE_URL in the environment (standard Railway Postgres).
 * Falls back to a local JSON file when DATABASE_URL is not set.
 *
 * For Railway volume persistence, set DATA_DIR=/app/data
 */

import pg from "pg";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const { Pool } = pg;

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const DATA_DIR = process.env.DATA_DIR || ROOT;
const LOCAL_FILE = join(DATA_DIR, "experiments.json");

let pool = null;

function getDatabaseUrl() {
  return process.env.DATABASE_URL || "";
}

function getPool() {
  if (!pool && getDatabaseUrl()) {
    pool = new Pool({ connectionString: getDatabaseUrl() });
  }
  return pool;
}

async function query(sql, values = []) {
  const p = getPool();
  if (!p) return null;
  const result = await p.query(sql, values);
  return result.rows;
}

// ── Migrations ──────────────────────────────────────────────────────────────

export async function migrate() {
  if (!getDatabaseUrl()) {
    // Ensure data directory exists
    try {
      await mkdir(DATA_DIR, { recursive: true });
    } catch {}
    // Ensure local file exists
    try {
      await readFile(LOCAL_FILE, "utf8");
    } catch {
      await writeFile(LOCAL_FILE, "[]", "utf8");
    }
    console.log("[db] using", LOCAL_FILE, "(no DATABASE_URL)");
    return;
  }

  await query(`
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
  // Add columns for train/test split and parent tracking (ignore if already exist)
  for (const col of [
    "train_avg_points REAL",
    "test_avg_points REAL",
    "parent_score REAL",
    "temperature REAL",
  ]) {
    try {
      await query(`ALTER TABLE experiments ADD COLUMN IF NOT EXISTS ${col}`);
    } catch {}
  }
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

export async function insertExperiment({ overallAvgPoints, hitRate, weights, description, status, trainAvgPoints, testAvgPoints, parentScore, temperature }) {
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
      train_avg_points: trainAvgPoints ?? null,
      test_avg_points: testAvgPoints ?? null,
      parent_score: parentScore ?? null,
      temperature: temperature ?? null,
    });
    await writeLocal(rows);
    return;
  }

  await query(
    `INSERT INTO experiments (overall_avg_points, hit_rate, weights_json, description, status, train_avg_points, test_avg_points, parent_score, temperature)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [overallAvgPoints, hitRate, weightsJson, description, status, trainAvgPoints ?? null, testAvgPoints ?? null, parentScore ?? null, temperature ?? null]
  );
}

export async function getAllExperiments() {
  if (!getDatabaseUrl()) {
    return readLocal();
  }

  return query(`
    SELECT id, created_at, overall_avg_points, hit_rate, description, status,
           train_avg_points, test_avg_points, parent_score, temperature
    FROM experiments ORDER BY id ASC
  `);
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

  const rows = await query(`
    SELECT weights_json FROM experiments
    WHERE status = 'keep'
    ORDER BY overall_avg_points DESC LIMIT 1
  `);

  if (!rows || !rows.length) return null;
  try {
    return JSON.parse(rows[0].weights_json);
  } catch {
    return null;
  }
}

export async function getExperimentCount() {
  const all = await getAllExperiments();
  return all.length;
}

export async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}