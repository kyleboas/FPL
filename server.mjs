import { createServer } from "node:http";
import { readFile, access } from "node:fs/promises";
import { spawn } from "node:child_process";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const PORT = process.env.PORT || 3000;
const REPORT_PATH = join(ROOT, "autoresearch-fpl", "latest-report.md");
const REPORT_INTERVAL_MS =
  (parseInt(process.env.REPORT_INTERVAL_HOURS ?? "6", 10) || 6) * 60 * 60 * 1000;

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

// ── Autoresearch runner ──────────────────────────────────────────────────────

let reportRunning = false;

function runReport() {
  if (reportRunning) {
    console.log("[report] already running, skipping");
    return;
  }
  reportRunning = true;
  console.log("[report] starting autoresearch run...");

  const child = spawn(
    process.execPath,
    ["autoresearch-fpl/run.mjs", "report"],
    { cwd: ROOT, stdio: "inherit" }
  );

  child.on("close", (code) => {
    reportRunning = false;
    if (code === 0) {
      console.log("[report] finished successfully");
    } else {
      console.error(`[report] exited with code ${code}`);
    }
  });

  child.on("error", (err) => {
    reportRunning = false;
    console.error("[report] failed to start:", err.message);
  });
}

// Run on startup, then on schedule
runReport();
setInterval(runReport, REPORT_INTERVAL_MS);
console.log(
  `[report] scheduled every ${REPORT_INTERVAL_MS / 3600000}h`
);

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

  // Health check
  if (url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", reportRunning }));
    return;
  }

  // Report endpoint — renders latest-report.md as HTML
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

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>FPL Autoresearch Report</title>
  <style>
    body { font-family: monospace; max-width: 900px; margin: 2rem auto; padding: 0 1rem; background: #0f1117; color: #e8eaf0; line-height: 1.6; }
    pre { white-space: pre-wrap; word-break: break-word; }
    a { color: #7cb9e8; }
  </style>
</head>
<body>
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
