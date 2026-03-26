#!/usr/bin/env node

import { writeFile } from "node:fs/promises";
import { readResults, PROGRESS_SVG_PATH } from "./results.mjs";

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export async function generateChart() {
  const results = await readResults();
  if (!results.length) {
    console.log("[chart] no experiments to plot");
    return null;
  }

  const valid = results.filter((result) => result.status !== "crash");
  if (!valid.length) {
    console.log("[chart] no non-crash experiments to plot");
    return null;
  }

  const W = 960;
  const H = 480;
  const PAD = { top: 50, right: 30, bottom: 50, left: 80 };
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;

  const minScore = Math.min(...valid.map((result) => result.avg_points_per_gw));
  const maxScore = Math.max(...valid.map((result) => result.avg_points_per_gw));
  const scoreRange = maxScore - minScore || 1;
  const margin = Math.max(scoreRange * 0.15, 0.5);
  const yMin = minScore - margin;
  const yMax = maxScore + margin;
  const xMax = Math.max(valid.length - 1, 1);

  const xScale = (index) => PAD.left + (index / xMax) * plotW;
  const yScale = (value) => PAD.top + plotH - ((value - yMin) / (yMax - yMin)) * plotH;

  const kept = [];
  const discarded = [];
  valid.forEach((result, index) => {
    const point = { ...result, index, x: xScale(index), y: yScale(result.avg_points_per_gw) };
    if (result.status === "keep") kept.push(point);
    if (result.status === "discard") discarded.push(point);
  });

  let runningBest = -Infinity;
  const runningBestPoints = [];
  for (const point of kept) {
    runningBest = Math.max(runningBest, point.avg_points_per_gw);
    runningBestPoints.push({ x: point.x, y: yScale(runningBest) });
  }
  if (runningBestPoints.length) {
    runningBestPoints.push({ x: xScale(xMax), y: runningBestPoints[runningBestPoints.length - 1].y });
  }

  let stepPath = "";
  for (let index = 0; index < runningBestPoints.length; index += 1) {
    const point = runningBestPoints[index];
    if (index === 0) {
      stepPath += `M ${point.x} ${point.y}`;
    } else {
      stepPath += ` H ${point.x} V ${point.y}`;
    }
  }

  const ticks = [];
  for (let index = 0; index <= 6; index += 1) {
    const value = yMin + (index / 6) * (yMax - yMin);
    ticks.push({ value, y: yScale(value) });
  }

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="#fafafa"/>

  ${ticks.map((tick) => `<line x1="${PAD.left}" y1="${tick.y}" x2="${W - PAD.right}" y2="${tick.y}" stroke="#e5e7eb" stroke-width="1"/>`).join("\n  ")}

  <line x1="${PAD.left}" y1="${PAD.top}" x2="${PAD.left}" y2="${H - PAD.bottom}" stroke="#555" stroke-width="1"/>
  <line x1="${PAD.left}" y1="${H - PAD.bottom}" x2="${W - PAD.right}" y2="${H - PAD.bottom}" stroke="#555" stroke-width="1"/>

  ${ticks.map((tick) => `<text x="${PAD.left - 8}" y="${tick.y + 4}" text-anchor="end" fill="#64748b" font-size="11" font-family="monospace">${tick.value.toFixed(2)}</text>`).join("\n  ")}

  ${stepPath ? `<path d="${stepPath}" fill="none" stroke="#2ecc71" stroke-width="2.5" opacity="0.7"/>` : ""}

  ${discarded.map((point) => `<circle cx="${point.x}" cy="${point.y}" r="4" fill="#666" opacity="0.5"/>`).join("\n  ")}
  ${kept.map((point) => `<circle cx="${point.x}" cy="${point.y}" r="6" fill="#2ecc71" stroke="white" stroke-width="0.8"/>`).join("\n  ")}

  ${kept.map((point) => {
    const label = escapeXml(point.description.length > 40 ? `${point.description.slice(0, 37)}...` : point.description);
    return `<text x="${point.x + 8}" y="${point.y - 8}" fill="#1a7a3a" font-size="8" font-family="monospace" transform="rotate(-20 ${point.x + 8} ${point.y - 8})">${label}</text>`;
  }).join("\n  ")}

  <text x="${W / 2}" y="28" text-anchor="middle" fill="#334155" font-size="15" font-family="monospace" font-weight="bold">Autoresearch Progress: ${results.length} Experiments, ${kept.length} Kept</text>
  <text x="${W / 2}" y="${H - 10}" text-anchor="middle" fill="#64748b" font-size="12" font-family="monospace">Experiment #</text>
  <text x="16" y="${H / 2}" text-anchor="middle" fill="#64748b" font-size="12" font-family="monospace" transform="rotate(-90 16 ${H / 2})">Avg Points Per GW (higher is better)</text>

  <circle cx="${W - 150}" cy="20" r="4" fill="#666" opacity="0.5"/>
  <text x="${W - 142}" y="24" fill="#64748b" font-size="10" font-family="monospace">Discarded</text>
  <circle cx="${W - 150}" cy="36" r="5" fill="#2ecc71" stroke="white" stroke-width="0.8"/>
  <text x="${W - 142}" y="40" fill="#64748b" font-size="10" font-family="monospace">Kept</text>
  <line x1="${W - 158}" y1="52" x2="${W - 142}" y2="52" stroke="#2ecc71" stroke-width="2.5" opacity="0.7"/>
  <text x="${W - 138}" y="56" fill="#64748b" font-size="10" font-family="monospace">Running best</text>
</svg>`;

  await writeFile(PROGRESS_SVG_PATH, svg, "utf8");
  console.log(`[chart] saved to ${PROGRESS_SVG_PATH}`);
  return PROGRESS_SVG_PATH;
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  generateChart().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
