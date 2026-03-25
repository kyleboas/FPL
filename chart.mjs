#!/usr/bin/env node

/**
 * Generate an SVG progress chart from experiment data.
 * Shows train/test split scores and annealing-accepted experiments.
 * Pure Node.js — no external dependencies.
 */

import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { getAllExperiments } from "./db.mjs";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const DATA_DIR = process.env.DATA_DIR || null;
const OUTPUT_PATH = DATA_DIR ? join(DATA_DIR, "progress.svg") : join(ROOT, "progress.svg");

function escapeXml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export async function generateChart() {
  const experiments = await getAllExperiments();
  if (!experiments.length) {
    console.log("[chart] no experiments to plot");
    return null;
  }

  const valid = experiments.filter((e) => e.status !== "crash");
  if (!valid.length) return null;

  const hasTrainTest = valid.some((e) => e.train_avg_points != null && e.test_avg_points != null);

  // Chart dimensions — taller if showing train/test
  const W = 960;
  const H = hasTrainTest ? 580 : 480;
  const PAD = { top: 50, right: 30, bottom: 50, left: 80 };
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;

  // Data ranges — include train/test scores in range
  const allScores = [];
  for (const e of valid) {
    allScores.push(e.overall_avg_points);
    if (e.train_avg_points != null) allScores.push(e.train_avg_points);
    if (e.test_avg_points != null) allScores.push(e.test_avg_points);
  }
  const minScore = Math.min(...allScores);
  const maxScore = Math.max(...allScores);
  const scoreRange = maxScore - minScore || 1;
  const margin = scoreRange * 0.1;
  const yMin = minScore - margin;
  const yMax = maxScore + margin;
  const xMax = valid.length - 1 || 1;

  const xScale = (i) => PAD.left + (i / xMax) * plotW;
  const yScale = (v) => PAD.top + plotH - ((v - yMin) / (yMax - yMin)) * plotH;

  const kept = [];
  const annealingAccepted = [];
  const discarded = [];
  valid.forEach((e, i) => {
    const point = { x: xScale(i), y: yScale(e.overall_avg_points), ...e, idx: i };
    if (e.status === "keep") {
      // Distinguish true improvements from annealing accepts
      if (e.parent_score != null && e.overall_avg_points < e.parent_score) {
        annealingAccepted.push(point);
      } else {
        kept.push(point);
      }
    } else {
      discarded.push(point);
    }
  });

  // Running best line (step) — only from true improvements
  let runningBest = -Infinity;
  const stepPoints = [];
  for (const k of kept) {
    if (k.overall_avg_points > runningBest) {
      runningBest = k.overall_avg_points;
    }
    stepPoints.push({ x: k.x, y: yScale(runningBest) });
  }
  if (stepPoints.length && valid.length > 1) {
    stepPoints.push({ x: xScale(xMax), y: stepPoints[stepPoints.length - 1].y });
  }

  let stepPath = "";
  for (let i = 0; i < stepPoints.length; i++) {
    const p = stepPoints[i];
    if (i === 0) {
      stepPath += `M ${p.x} ${p.y}`;
    } else {
      stepPath += ` H ${p.x} V ${p.y}`;
    }
  }

  // Train/test trend lines (for kept experiments that have both)
  let trainPath = "";
  let testPath = "";
  if (hasTrainTest) {
    const keptWithSplit = [...kept, ...annealingAccepted]
      .filter((k) => k.train_avg_points != null && k.test_avg_points != null)
      .sort((a, b) => a.idx - b.idx);
    if (keptWithSplit.length > 1) {
      trainPath = keptWithSplit
        .map((k, i) => `${i === 0 ? "M" : "L"} ${k.x} ${yScale(k.train_avg_points)}`)
        .join(" ");
      testPath = keptWithSplit
        .map((k, i) => `${i === 0 ? "M" : "L"} ${k.x} ${yScale(k.test_avg_points)}`)
        .join(" ");
    }
  }

  // Y-axis ticks
  const nTicks = 6;
  const ticks = [];
  for (let i = 0; i <= nTicks; i++) {
    const val = yMin + (i / nTicks) * (yMax - yMin);
    ticks.push({ val, y: yScale(val) });
  }

  const nKept = kept.length + annealingAccepted.length;
  const nTotal = experiments.length;
  const nAnnealing = annealingAccepted.length;

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="#0f1117"/>

  <!-- Grid -->
  ${ticks
    .map(
      (t) =>
        `<line x1="${PAD.left}" y1="${t.y}" x2="${W - PAD.right}" y2="${t.y}" stroke="#222" stroke-width="1"/>`,
    )
    .join("\n  ")}

  <!-- Axes -->
  <line x1="${PAD.left}" y1="${PAD.top}" x2="${PAD.left}" y2="${H - PAD.bottom}" stroke="#555" stroke-width="1"/>
  <line x1="${PAD.left}" y1="${H - PAD.bottom}" x2="${W - PAD.right}" y2="${H - PAD.bottom}" stroke="#555" stroke-width="1"/>

  <!-- Y-axis labels -->
  ${ticks
    .map(
      (t) =>
        `<text x="${PAD.left - 8}" y="${t.y + 4}" text-anchor="end" fill="#888" font-size="11" font-family="monospace">${t.val.toFixed(2)}</text>`,
    )
    .join("\n  ")}

  <!-- Train/test trend lines -->
  ${trainPath ? `<path d="${trainPath}" fill="none" stroke="#3b82f6" stroke-width="1.5" opacity="0.5" stroke-dasharray="4 2"/>` : ""}
  ${testPath ? `<path d="${testPath}" fill="none" stroke="#f59e0b" stroke-width="1.5" opacity="0.5" stroke-dasharray="4 2"/>` : ""}

  <!-- Running best line -->
  ${stepPath ? `<path d="${stepPath}" fill="none" stroke="#2ecc71" stroke-width="2.5" opacity="0.7"/>` : ""}

  <!-- Discarded dots -->
  ${discarded
    .map((d) => `<circle cx="${d.x}" cy="${d.y}" r="4" fill="#666" opacity="0.5"/>`)
    .join("\n  ")}

  <!-- Annealing-accepted dots (kept but worse than parent) -->
  ${annealingAccepted
    .map(
      (a) =>
        `<circle cx="${a.x}" cy="${a.y}" r="5" fill="#f59e0b" stroke="white" stroke-width="0.8" opacity="0.8"/>`,
    )
    .join("\n  ")}

  <!-- Kept dots (true improvements) -->
  ${kept
    .map(
      (k) =>
        `<circle cx="${k.x}" cy="${k.y}" r="6" fill="#2ecc71" stroke="white" stroke-width="0.8"/>`,
    )
    .join("\n  ")}

  <!-- Kept labels -->
  ${kept
    .map((k) => {
      const desc = escapeXml(k.description.length > 40 ? k.description.slice(0, 37) + "..." : k.description);
      return `<text x="${k.x + 8}" y="${k.y - 8}" fill="#1a7a3a" font-size="8" font-family="monospace" transform="rotate(-20 ${k.x + 8} ${k.y - 8})">${desc}</text>`;
    })
    .join("\n  ")}

  <!-- Title -->
  <text x="${W / 2}" y="28" text-anchor="middle" fill="#e8eaf0" font-size="15" font-family="monospace" font-weight="bold">Autoresearch Progress: ${nTotal} Experiments, ${nKept} Kept${nAnnealing > 0 ? ` (${nAnnealing} annealing)` : ""}</text>

  <!-- Axis labels -->
  <text x="${W / 2}" y="${H - 10}" text-anchor="middle" fill="#888" font-size="12" font-family="monospace">Experiment #</text>
  <text x="16" y="${H / 2}" text-anchor="middle" fill="#888" font-size="12" font-family="monospace" transform="rotate(-90 16 ${H / 2})">Avg Points (higher is better)</text>

  <!-- Legend -->
  <circle cx="${W - 150}" cy="20" r="4" fill="#666" opacity="0.5"/>
  <text x="${W - 142}" y="24" fill="#888" font-size="10" font-family="monospace">Discarded</text>
  <circle cx="${W - 150}" cy="36" r="5" fill="#2ecc71" stroke="white" stroke-width="0.8"/>
  <text x="${W - 142}" y="40" fill="#888" font-size="10" font-family="monospace">Kept (improved)</text>
  ${nAnnealing > 0 ? `<circle cx="${W - 150}" cy="52" r="4" fill="#f59e0b" stroke="white" stroke-width="0.8"/>
  <text x="${W - 142}" y="56" fill="#888" font-size="10" font-family="monospace">Annealing accept</text>
  <line x1="${W - 158}" y1="68" x2="${W - 142}" y2="68" stroke="#2ecc71" stroke-width="2.5" opacity="0.7"/>
  <text x="${W - 138}" y="72" fill="#888" font-size="10" font-family="monospace">Running best</text>` :
  `<line x1="${W - 158}" y1="52" x2="${W - 142}" y2="52" stroke="#2ecc71" stroke-width="2.5" opacity="0.7"/>
  <text x="${W - 138}" y="56" fill="#888" font-size="10" font-family="monospace">Running best</text>`}
  ${hasTrainTest ? `<line x1="${W - 158}" y1="${nAnnealing > 0 ? 84 : 68}" x2="${W - 142}" y2="${nAnnealing > 0 ? 84 : 68}" stroke="#3b82f6" stroke-width="1.5" stroke-dasharray="4 2"/>
  <text x="${W - 138}" y="${nAnnealing > 0 ? 88 : 72}" fill="#888" font-size="10" font-family="monospace">Train avg</text>
  <line x1="${W - 158}" y1="${nAnnealing > 0 ? 100 : 84}" x2="${W - 142}" y2="${nAnnealing > 0 ? 100 : 84}" stroke="#f59e0b" stroke-width="1.5" stroke-dasharray="4 2"/>
  <text x="${W - 138}" y="${nAnnealing > 0 ? 104 : 88}" fill="#888" font-size="10" font-family="monospace">Test avg</text>` : ""}
</svg>`;

  await writeFile(OUTPUT_PATH, svg, "utf8");
  console.log(`[chart] saved to ${OUTPUT_PATH}`);
  return OUTPUT_PATH;
}

// Allow running standalone
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  import("./db.mjs").then(({ migrate }) => migrate()).then(() => generateChart()).catch(console.error);
}
