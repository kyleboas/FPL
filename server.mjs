import { createServer } from "node:http";
import { readFile, access, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runOptimizationCycle } from "./optimizer.mjs";
import { generateChart } from "./chart.mjs";
import { migrate } from "./db.mjs";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || null;
const REPORT_PATH = DATA_DIR ? join(DATA_DIR, "latest-report.md") : join(ROOT, "autoresearch-fpl", "latest-report.md");
const PROGRESS_SVG_PATH = DATA_DIR ? join(DATA_DIR, "progress.svg") : join(ROOT, "progress.svg");
const CYCLE_INTERVAL_MINUTES = parseInt(process.env.CYCLE_INTERVAL_MINUTES ?? "30", 10);
const CYCLE_INTERVAL_MS = CYCLE_INTERVAL_MINUTES * 60 * 1000;

// Rate limit delay: OpenRouter free tier = 8 req/min = 7.5 sec between requests
const RATE_LIMIT_DELAY_MS = 8000;

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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

// File-based lock for multi-instance safety
const LOCK_FILE = DATA_DIR ? join(DATA_DIR, ".cycle.lock") : join(ROOT, ".cycle.lock");
const LOCK_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function acquireLock() {
  try {
    const existing = await readFile(LOCK_FILE, "utf8");
    const lockTime = parseInt(existing, 10);
    if (Date.now() - lockTime < LOCK_TTL_MS) {
      return false; // Lock is held by another process
    }
  } catch {}
  await writeFile(LOCK_FILE, String(Date.now()), "utf8");
  return true;
}

async function releaseLock() {
  try {
    await writeFile(LOCK_FILE, "", "utf8");
  } catch {}
}

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
      // Wait between experiments to respect rate limits
      // OpenRouter free tier = 8 RPM, so 8+ seconds between calls
      if (i < nExperiments - 1) {
        console.log("[cycle] waiting 10s before next experiment...");
        await new Promise(resolve => setTimeout(resolve, 10000));
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

// Initialize DB, then schedule (no startup cycle to avoid rate limit spam)
migrate()
  .then(() => {
    console.log("[db] ready");
    console.log(`[cycle] scheduled every ${CYCLE_INTERVAL_MINUTES} minutes`);
  })
  .catch((err) => console.error("[startup] migration failed:", err.message));

if (CYCLE_INTERVAL_MS > 0) {
  setInterval(runCycle, CYCLE_INTERVAL_MS);
} else {
  console.log("[cycle] interval disabled (CYCLE_INTERVAL_MINUTES=0), using external cron");
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

  // Manual trigger endpoint
  if (url.pathname === "/trigger") {
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
<div class="status">Optimization cycle #${cycleCount} | ${cycleRunning ? "Running..." : "Idle"} | Every ${CYCLE_INTERVAL_MS / 60000}m</div>
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
