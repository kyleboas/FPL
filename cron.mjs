#!/usr/bin/env node

/**
 * One-shot cron entry point for Railway.
 * Runs N optimization cycles (EXPERIMENTS_PER_CRON, default 1), regenerates the chart, then exits.
 * Schedule via a Railway Cron service: node cron.mjs
 */

import { runOptimizationCycle } from "./optimizer.mjs";
import { generateChart } from "./chart.mjs";

const N = parseInt(process.env.EXPERIMENTS_PER_CRON ?? "1", 10) || 1;
console.log(`[cron] running ${N} experiment(s)`);
for (let i = 0; i < N; i++) {
  await runOptimizationCycle();
}
await generateChart().catch((err) => console.error("[cron] chart failed:", err.message));
process.exit(0);
