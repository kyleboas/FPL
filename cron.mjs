#!/usr/bin/env node

/**
 * One-shot cron entry point for Railway.
 * Runs N optimization cycles (EXPERIMENTS_PER_CRON, default 1), regenerates the chart, then exits.
 * Schedule via a Railway Cron service: node cron.mjs
 */

import { readFile } from "node:fs/promises";
import { runOptimizationCycle } from "./optimizer.mjs";
import { generateChart } from "./chart.mjs";

const config = JSON.parse(await readFile("./autoresearch-fpl/config.json", "utf8"));
const N = parseInt(process.env.EXPERIMENTS_PER_CRON ?? config.experimentsPerCron ?? 1, 10) || 1;

// Rate limit delay: OpenRouter free tier = 8 req/min = 7.5 sec between requests
const RATE_LIMIT_DELAY_MS = 8000;

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

console.log(`[cron] running ${N} experiment(s) with ${RATE_LIMIT_DELAY_MS}ms delay between each`);

for (let i = 0; i < N; i++) {
  if (i > 0) {
    console.log(`[cron] waiting ${RATE_LIMIT_DELAY_MS}ms before experiment #${i + 1}...`);
    await delay(RATE_LIMIT_DELAY_MS);
  }
  await runOptimizationCycle();
}

await generateChart().catch((err) => console.error("[cron] chart failed:", err.message));
process.exit(0);
