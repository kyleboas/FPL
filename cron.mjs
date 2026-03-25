#!/usr/bin/env node

/**
 * One-shot cron entry point for Railway.
 * Runs N optimization cycles (EXPERIMENTS_PER_CRON, default 1), regenerates the chart, then exits.
 * Schedule via a Railway Cron service: node cron.mjs
 */

import { readFile, writeFile, unlink, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { runOptimizationCycle } from "./optimizer.mjs";
import { generateChart } from "./chart.mjs";

const LOCK_FILE = "/tmp/fpl-optimizer.lock";

async function acquireLock() {
  try {
    if (existsSync(LOCK_FILE)) {
      const s = await stat(LOCK_FILE);
      const age = Date.now() - s.mtimeMs;
      if (age < 10 * 60 * 1000) {
        console.log(`[cron] lock file exists (age: ${Math.round(age/1000)}s), another instance is running - exiting`);
        process.exit(0);
      }
      console.log(`[cron] stale lock file (age: ${Math.round(age/1000)}s), removing`);
    }
    await writeFile(LOCK_FILE, `${process.pid}\n${Date.now()}`, "utf8");
    return true;
  } catch (err) {
    console.error("[cron] lock error:", err.message);
    return false;
  }
}

async function releaseLock() {
  try {
    await unlink(LOCK_FILE);
  } catch {}
}

const RATE_LIMIT_DELAY_MS = 8000; // 8 seconds for 8 RPM free tier limit

const config = JSON.parse(await readFile("./autoresearch-fpl/config.json", "utf8"));
const N = parseInt(process.env.EXPERIMENTS_PER_CRON ?? config.experimentsPerCron ?? 1, 10) || 1;

// Acquire lock to prevent concurrent runs
if (!await acquireLock()) {
  process.exit(1);
}

console.log(`[cron] running ${N} experiment(s)`);

try {
  for (let i = 0; i < N; i++) {
    await runOptimizationCycle();
    
    // Delay between experiments to respect rate limits
    if (i < N - 1) {
      console.log(`[cron] waiting ${RATE_LIMIT_DELAY_MS/1000}s before next experiment...`);
      await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_DELAY_MS));
    }
  }

  await generateChart().catch((err) => console.error("[cron] chart failed:", err.message));
} finally {
  await releaseLock();
}

process.exit(0);
