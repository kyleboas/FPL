import { createServer } from "node:http";
import { access, readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generateChart } from "./chart.mjs";
import { runOptimizationCycle } from "./optimizer.mjs";
import { PROGRESS_SVG_PATH, REPORT_PATH, RESULTS_PATH, readResults, resetAutoresearchState } from "./results.mjs";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const CONFIG_PATH = join(ROOT, "autoresearch-fpl", "config.json");
const REPO_STRATEGY_PATH = join(ROOT, "autoresearch-fpl", "strategy.mjs");
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || null;
const CYCLE_INTERVAL_MINUTES = parseInt(process.env.CYCLE_INTERVAL_MINUTES ?? "30", 10);
const CYCLE_INTERVAL_MS = CYCLE_INTERVAL_MINUTES * 60 * 1000;
const RATE_LIMIT_DELAY_MS = 10_000;

let cachedConfig = null;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function loadConfig() {
  if (cachedConfig) return cachedConfig;
  try {
    cachedConfig = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
  } catch {
    cachedConfig = {};
  }
  return cachedConfig;
}

async function getProvider() {
  if (process.env.LLM_PROVIDER) return process.env.LLM_PROVIDER;
  const config = await loadConfig();
  return config.llm?.provider || "openrouter";
}

async function getModel() {
  const provider = await getProvider();
  if (provider === "cloudflare" && process.env.CF_MODEL) return process.env.CF_MODEL;
  if (provider !== "cloudflare" && process.env.OPENROUTER_MODEL) return process.env.OPENROUTER_MODEL;
  if (process.env.CF_MODEL || process.env.OPENROUTER_MODEL) {
    return process.env.CF_MODEL || process.env.OPENROUTER_MODEL;
  }
  const config = await loadConfig();
  return config.llm?.model || "qwen/qwen3-4b:free";
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".md": "text/markdown; charset=utf-8",
};

// ── Optimization cycle ──────────────────────────────────────────────────────

let cycleRunning = false;
let cycleCount = 0;

async function runCycle() {
  if (cycleRunning) {
    console.log("[cycle] already running, skipping");
    return;
  }
  cycleRunning = true;
  cycleCount += 1;
  const nExperiments = parseInt(process.env.EXPERIMENTS_PER_CRON ?? "1", 10);
  console.log(`[cycle] #${cycleCount} starting (${nExperiments} experiments)...`);

  try {
    for (let i = 0; i < nExperiments; i++) {
      await runOptimizationCycle();
      if (i < nExperiments - 1) {
        console.log(`[cycle] waiting ${RATE_LIMIT_DELAY_MS / 1000}s before next experiment...`);
        await delay(RATE_LIMIT_DELAY_MS);
      }
    }
    await generateChart();
    console.log(`[cycle] #${cycleCount} complete`);
  } catch (err) {
    console.error(`[cycle] #${cycleCount} failed:`, err.message);
  } finally {
    cycleRunning = false;
  }
}

console.log("[startup] file-backed autoresearch state ready");
console.log(
  CYCLE_INTERVAL_MS > 0
    ? `[cycle] scheduled every ${CYCLE_INTERVAL_MINUTES} minutes`
    : "[cycle] interval disabled (CYCLE_INTERVAL_MINUTES=0), using external cron",
);

if (CYCLE_INTERVAL_MS > 0) {
  setInterval(runCycle, CYCLE_INTERVAL_MS);
}

// ── HTTP server ──────────────────────────────────────────────────────────────

async function serveStatic(req, res) {
  let urlPath = new URL(req.url, `http://localhost`).pathname;

  // Default to index.html
  if (urlPath === "/") urlPath = "/index.html";

  // Prevent path traversal
  const filePath = resolve(join(ROOT, urlPath));
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    await access(filePath);
    const data = await readFile(filePath);
    const mime = MIME[extname(filePath)] ?? "application/octet-stream";
    res.writeHead(200, { "Content-Type": mime });
    res.end(data);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost`);

  // Progress SVG endpoint - serve from DATA_DIR
  if (url.pathname === "/progress.svg") {
    try {
      const svg = await readFile(PROGRESS_SVG_PATH, "utf8");
      res.writeHead(200, { "Content-Type": "image/svg+xml" });
      res.end(svg);
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
    }
    return;
  }

  // Health check
  if (url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", cycleRunning, cycleCount }));
    return;
  }

  // Debug endpoint
  if (url.pathname === "/debug") {
    const provider = await getProvider();
    const model = await getModel();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      openRouterConfigured: !!process.env.OPENROUTER_API_KEY,
      cloudflareConfigured: !!(process.env.CF_GATEWAY_URL && process.env.CF_AIG_TOKEN),
      provider,
      model,
      experimentsPerCron: process.env.EXPERIMENTS_PER_CRON || "1",
      cycleIntervalMinutes: CYCLE_INTERVAL_MINUTES,
      dataDir: DATA_DIR ? "set" : "not set"
    }));
    return;
  }

  // Manual trigger endpoint (requires auth)
  if (url.pathname === "/trigger") {
    // Check for secret token
    const triggerSecret = process.env.TRIGGER_SECRET;
    const providedSecret = url.searchParams.get("secret") || req.headers["x-trigger-secret"];
    
    if (triggerSecret && providedSecret !== triggerSecret) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }
    
    if (cycleRunning) {
      res.writeHead(409, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Cycle already running" }));
      return;
    }
    // Get optional experiments count from query param
    const experimentsParam = url.searchParams.get("experiments");
    const nExperiments = experimentsParam ? parseInt(experimentsParam, 10) : parseInt(process.env.EXPERIMENTS_PER_CRON ?? "1", 10);
    
    // Run cycle in background with specified experiment count
    cycleRunning = true;
    cycleCount += 1;
    console.log(`[trigger] starting cycle #${cycleCount} with ${nExperiments} experiments...`);
    
    // Fire and forget
    (async () => {
      try {
        for (let i = 0; i < nExperiments; i++) {
          await runOptimizationCycle();
          if (i < nExperiments - 1) {
            console.log(`[trigger] waiting 10s before experiment ${i + 2}...`);
            await new Promise(r => setTimeout(r, 10000));
          }
        }
        await generateChart();
        console.log(`[trigger] cycle #${cycleCount} complete`);
      } catch (err) {
        console.error(`[trigger] cycle #${cycleCount} failed:`, err.message);
      } finally {
        cycleRunning = false;
      }
    })();
    
    res.writeHead(202, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "triggered", cycleCount, experiments: nExperiments }));
    return;
  }


  // Reset endpoint - clears file-backed state and restores the repo strategy
  if (url.pathname === "/reset") {
    const triggerSecret = process.env.TRIGGER_SECRET;
    const providedSecret = url.searchParams.get("secret") || req.headers["x-trigger-secret"];
    
    if (triggerSecret && providedSecret !== triggerSecret) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }
    
    if (!DATA_DIR) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "No DATA_DIR set" }));
      return;
    }
    
    try {
      await resetAutoresearchState(REPO_STRATEGY_PATH);
      console.log("[reset] restored repo strategy and cleared file-backed experiment state");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "reset", message: "State cleared and repo strategy restored" }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // Experiment results endpoint — shows reasoning for each experiment
  if (url.pathname === "/results" || url.pathname === "/results.tsv") {
    try {
      const raw = await readFile(RESULTS_PATH, "utf8");
      if (url.pathname === "/results.tsv") {
        res.writeHead(200, { "Content-Type": "text/tab-separated-values" });
        res.end(raw);
        return;
      }
      
      const results = await readResults();
      const rows = results.map(r => `
        <tr class="${r.status}">
          <td>#${r.id}</td>
          <td>${r.commit || "-"}</td>
          <td>${r.avg_points_per_gw.toFixed(2)}</td>
          <td>${Math.round(r.total_hit_cost)}</td>
          <td class="status-cell">${r.status}</td>
          <td class="desc-cell">${escapeHtml(r.description) || "-"}</td>
        </tr>
      `).join("");
      
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>FPL Autoresearch Experiments</title>
  <style>
    body { font-family: monospace; max-width: 1200px; margin: 2rem auto; padding: 0 1rem; background: #0f1117; color: #e8eaf0; line-height: 1.6; }
    h1 { color: #7cb9e8; }
    table { width: 100%; border-collapse: collapse; margin-top: 1rem; font-size: 0.85rem; }
    th, td { padding: 0.5rem 0.75rem; text-align: left; border-bottom: 1px solid #333; }
    th { background: #1a1d24; color: #888; font-weight: normal; }
    tr.keep { background: rgba(46, 204, 113, 0.1); }
    tr.discard { opacity: 0.6; }
    tr.crash { background: rgba(231, 76, 60, 0.1); }
    .status-cell { text-transform: uppercase; font-weight: bold; }
    tr.keep .status-cell { color: #2ecc71; }
    tr.discard .status-cell { color: #f39c12; }
    tr.crash .status-cell { color: #e74c3c; }
    .desc-cell { max-width: 500px; word-break: break-word; }
    a { color: #7cb9e8; }
    .nav { margin-bottom: 1rem; }
    .nav a { margin-right: 1rem; }
  </style>
</head>
<body>
  <div class="nav">
    <a href="/">Home</a>
    <a href="/report">Report</a>
    <a href="/progress.svg">Chart</a>
    <a href="/results.tsv">Raw TSV</a>
  </div>
  <h1>Experiment History</h1>
  <p>${results.length} experiments, ${results.filter(r => r.status === "keep").length} kept, best: ${results.filter(r => r.status === "keep").reduce((best, r) => r.avg_points_per_gw > best.avg_points_per_gw ? r : best, {avg_points_per_gw: 0}).avg_points_per_gw.toFixed(2)} avg pts/gw</p>
  <table>
    <thead>
      <tr>
        <th>#</th>
        <th>Commit</th>
        <th>Avg Pts/GW</th>
        <th>Hit Cost</th>
        <th>Status</th>
        <th>Description / Reasoning</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>
</body>
</html>`);
    } catch (err) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Error reading results: " + err.message);
    }
    return;
  }

  // Report endpoint — renders latest-report.md as HTML with progress chart
  if (url.pathname === "/report") {
    let md;
    try {
      md = await readFile(REPORT_PATH, "utf8");
    } catch {
      res.writeHead(503, { "Content-Type": "text/plain" });
      res.end("Report not yet generated. Check back soon.");
      return;
    }

    const escaped = md
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");

    // Check if progress.svg exists
    let progressChart = "";
    try {
      await access(PROGRESS_SVG_PATH);
      progressChart = `<img src="/progress.svg" alt="Autoresearch Progress" style="max-width:100%; margin: 1rem 0; border-radius: 8px;">`;
    } catch {}

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>FPL Autoresearch Report</title>
  <style>
    body { font-family: monospace; max-width: 960px; margin: 2rem auto; padding: 0 1rem; background: #0f1117; color: #e8eaf0; line-height: 1.6; }
    pre { white-space: pre-wrap; word-break: break-word; }
    a { color: #7cb9e8; }
    .status { color: #888; font-size: 0.85em; margin-bottom: 1rem; }
  </style>
</head>
<body>
<div class="status">Optimization cycle #${cycleCount} | ${cycleRunning ? "Running..." : "Idle"} | ${CYCLE_INTERVAL_MS > 0 ? `Every ${CYCLE_INTERVAL_MS / 60000}m` : "Manual triggers only"}</div>
${progressChart}
<pre>${escaped}</pre>
</body>
</html>`);
    return;
  }

  // Static files
  await serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT}`);
});
