#!/usr/bin/env node

/**
 * One-shot cron entry point for Railway.
 * Runs a single optimization cycle, regenerates the chart, then exits.
 * Schedule via a Railway Cron service: node cron.mjs
 */

import { runOptimizationCycle } from "./optimizer.mjs";
import { generateChart } from "./chart.mjs";

await runOptimizationCycle();
await generateChart().catch((err) => console.error("[cron] chart failed:", err.message));
process.exit(0);
