import { createServer } from "node:http";
import { access, readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generateChart } from "./chart.mjs";
import { runOptimizationCycle } from "./optimizer.mjs";
import { DIFFS_DIR } from "./optimizer.mjs";
import { PROGRESS_SVG_PATH, REPORT_PATH, RESULTS_PATH, readResults, resetAutoresearchState } from "./results.mjs";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const CONFIG_PATH = join(ROOT, "autoresearch-fpl", "config.json");
const REPO_STRATEGY_PATH = join(ROOT, "autoresearch-fpl", "strategy.mjs");
const REPO_WEIGHTS_PATH = join(ROOT, "autoresearch-fpl", "weights.json");
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

  // Results API endpoint - JSON
  if (url.pathname === "/results") {
    try {
      const results = await readResults();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(results, null, 2));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // Experiments page - chart + table with reasoning
  if (url.pathname === "/experiments") {
    try {
      const results = await readResults();
      const statusCounts = {
        keep: results.filter(r => r.status === "keep").length,
        discard: results.filter(r => r.status === "discard").length,
        crash: results.filter(r => r.status === "crash").length,
      };
      
      const rows = results.map(r => {
        const statusColor = r.status === "keep" ? "#2ecc71" : r.status === "discard" ? "#e74c3c" : "#f39c12";
        const timestamp = r.timestamp ? escapeHtml(r.timestamp.replace("T", " ").replace("Z", " UTC")) : "—";
        const holdout = Number.isFinite(r.holdout_avg_points) ? r.holdout_avg_points.toFixed(2) : "—";
        const gap = Number.isFinite(r.holdout_gap) ? r.holdout_gap.toFixed(2) : "—";
        return `
          <tr class="${r.status}">
            <td>${r.id}</td>
            <td>${timestamp}</td>
            <td><code>${r.commit}</code></td>
            <td>${r.avg_points_per_gw.toFixed(2)}</td>
            <td>${holdout}</td>
            <td>${gap}</td>
            <td>${r.total_hit_cost}</td>
            <td style="color:${statusColor};font-weight:bold">${r.status.toUpperCase()}</td>
            <td class="reasoning">${escapeHtml(r.description || "-")}</td>
          </tr>`;
      }).join("");
      
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>FPL Autoresearch Experiments</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: 'SF Mono', 'Monaco', 'Inconsolata', 'Fira Mono', monospace; max-width: 1400px; margin: 0 auto; padding: 2rem; background: #0d1117; color: #c9d1d9; line-height: 1.6; }
    h1 { margin: 0 0 0.5rem 0; font-size: 1.5rem; }
    .stats { color: #8b949e; font-size: 0.9em; margin-bottom: 1.5rem; }
    .stats span { margin-right: 1rem; }
    .chart-container { background: #161b22; border-radius: 8px; padding: 1rem; margin-bottom: 2rem; }
    .chart-container img { width: 100%; max-width: 100%; height: auto; }
    table { width: 100%; border-collapse: collapse; background: #161b22; border-radius: 8px; overflow: hidden; }
    th, td { padding: 0.75rem 1rem; text-align: left; }
    th { background: #21262d; color: #8b949e; font-weight: 600; text-transform: uppercase; font-size: 0.75rem; letter-spacing: 0.05em; }
    tr { border-bottom: 1px solid #21262d; }
    tr:last-child { border-bottom: none; }
    tr:hover { background: #1c2128; }
    code { background: #21262d; padding: 0.2rem 0.5rem; border-radius: 4px; font-size: 0.85em; }
    .reasoning { max-width: 500px; word-wrap: break-word; }
    a { color: #58a6ff; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .nav { margin-bottom: 1.5rem; }
    .nav a { margin-right: 1rem; }
  </style>
</head>
<body>
  <h1>FPL Autoresearch Experiments</h1>
  <div class="nav">
    <a href="/">Home</a>
    <a href="/report">Report</a>
  </div>
  <div class="stats">
    <span>${results.length} experiments</span>
    <span style="color:#2ecc71">${statusCounts.keep} kept</span>
    <span style="color:#e74c3c">${statusCounts.discard} discarded</span>
    <span style="color:#f39c12">${statusCounts.crash} crashed</span>
  </div>
  <div class="chart-container">
    <img src="/progress.svg" alt="Progress Chart">
  </div>
  <table>
    <thead>
      <tr>
        <th>#</th>
        <th>When</th>
        <th>Revision</th>
        <th>Avg Pts/GW</th>
        <th>Holdout</th>
        <th>Gap</th>
        <th>Hit Cost</th>
        <th>Status</th>
        <th>Reasoning</th>
      </tr>
    </thead>
    <tbody>
      ${rows}
    </tbody>
  </table>
</body>
</html>`);
    } catch (err) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Error reading results: " + err.message);
    }
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


  // Reset endpoint - clears file-backed state and restores the repo weights
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
      await resetAutoresearchState(REPO_STRATEGY_PATH, REPO_WEIGHTS_PATH);
      console.log("[reset] restored repo weights and cleared file-backed experiment state");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "reset", message: "State cleared and repo weights restored" }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // Results TSV endpoint
  if (url.pathname === "/results.tsv") {
    try {
      const raw = await readFile(RESULTS_PATH, "utf8");
      res.writeHead(200, { "Content-Type": "text/tab-separated-values" });
      res.end(raw);
    } catch (err) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
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

  // Diff endpoint - serve diff file by revision
  const diffMatch = url.pathname.match(/^\/diffs\/([a-f0-9]{7})$/);
  if (diffMatch) {
    const revision = diffMatch[1];
    const diffPath = join(DIFFS_DIR, `${revision}.diff`);
    try {
      const diff = await readFile(diffPath, "utf8");
      const escaped = diff
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
      
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Diff ${revision}</title>
  <style>
    body { font-family: 'SF Mono', 'Monaco', 'Inconsolata', 'Fira Mono', monospace; max-width: 1200px; margin: 2rem auto; padding: 0 1rem; background: #0d1117; color: #c9d1d9; line-height: 1.5; }
    h1 { font-size: 1.2rem; margin-bottom: 1rem; }
    pre { white-space: pre; overflow-x: auto; background: #161b22; padding: 1rem; border-radius: 8px; }
    .add { color: #3fb950; }
    .del { color: #f85149; }
    .ctx { color: #8b949e; }
    a { color: #58a6ff; text-decoration: none; }
    a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <h1>Diff for revision <code>${revision}</code></h1>
  <p><a href="/experiments">← Back to experiments</a></p>
  <pre>${escaped.split('\n').map(line => {
    if (line.startsWith('+')) return `<span class="add">${line}</span>`;
    if (line.startsWith('-')) return `<span class="del">${line}</span>`;
    if (line.startsWith('@@')) return `<span class="ctx">${line}</span>`;
    return line;
  }).join('\n')}</pre>
</body>
</html>`);
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Diff not found");
    }
    return;
  }

  // Static files
  await serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT}`);
});
