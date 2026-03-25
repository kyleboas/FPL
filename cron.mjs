#!/usr/bin/env node

/**
 * One-shot cron entry point for Railway.
 * Runs N optimization cycles (EXPERIMENTS_PER_CRON, default 1), regenerates the chart, then exits.
 * Schedule via a Railway Cron service: node cron.mjs
 */

import { readFile } from "node:fs/promises";
import { runOptimizationCycle } from "./optimizer.mjs";
import { generateChart } from "./chart.mjs";

const RATE_LIMIT_DELAY_MS = 8000; // 8 seconds for 8 RPM free tier limit

const config = JSON.parse(await readFile("./autoresearch-fpl/config.json", "utf8"));
const N = parseInt(process.env.EXPERIMENTS_PER_CRON ?? config.experimentsPerCron ?? 1, 10) || 1;
console.log(`[cron] running ${N} experiment(s)`);

for (let i = 0; i < N; i++) {
  await runOptimizationCycle();
  
  // Delay between experiments to respect rate limits
  if (i < N - 1) {
    console.log(`[cron] waiting ${RATE_LIMIT_DELAY_MS/1000}s before next experiment...`);
    await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_DELAY_MS));
  }
}

await generateChart().catch((err) => console.error("[cron] chart failed:", err.message));
process.exit(0);
