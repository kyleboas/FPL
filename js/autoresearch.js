/**
 * Autoresearch Transfer Planner UI
 *
 * Fetches the latest report from /autoresearch-fpl/latest-report.md,
 * parses the markdown, and renders it as structured HTML.
 */

const loading = document.getElementById("loading");
const error = document.getElementById("error");
const mainContent = document.getElementById("main-content");
const statusBar = document.getElementById("status-bar");

function showError(msg) {
    error.style.display = "block";
    error.textContent = msg;
    loading.style.display = "none";
}

function show(id) {
    const el = document.getElementById(id);
    if (el) el.style.display = "";
}

// ── Parse the markdown report into structured data ──────────────────────────

function parseReport(md) {
    const lines = md.split("\n");
    const data = {
        meta: {},
        chips: [],
        squad: [],
        transfers: [],
        transferSummary: "",
        finalSquad: [],
        topPlayers: [],
        sections: [],
    };

    let currentSection = null;
    let currentGw = null;

    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        // Meta lines
        if (trimmed.startsWith("- ") && !currentSection) {
            const [key, ...rest] = trimmed.slice(2).split(":");
            if (rest.length > 0) {
                data.meta[key.trim()] = rest.join(":").trim();
            }
            continue;
        }

        // Section headers
        if (trimmed.startsWith("## ")) {
            currentSection = trimmed.slice(3).trim();
            currentGw = null;
            continue;
        }

        if (trimmed.startsWith("### ")) {
            currentGw = trimmed.slice(4).trim();
            continue;
        }

        if (!trimmed.startsWith("- ")) continue;
        const content = trimmed.slice(2);

        if (currentSection === "Chip strategy") {
            data.chips.push(parseChipLine(content));
        } else if (currentSection === "Current squad") {
            data.squad.push(parsePlayerLine(content));
        } else if (currentSection?.startsWith("Transfer plan")) {
            data.transferSummary = currentSection;
            data.transfers.push(parseTransferLine(content, currentGw));
        } else if (currentSection?.startsWith("Final squad")) {
            data.finalSquad.push(parsePlayerLine(content));
        } else if (currentSection?.startsWith("Top players")) {
            data.topPlayers.push(parsePlayerLine(content));
        } else if (currentSection?.startsWith("Best ")) {
            // Fallback budget squad mode
            data.squad.push(parsePlayerLine(content));
        }
    }

    return data;
}

function parsePlayerLine(line) {
    // "Name (POS, £X.Xm, Team) — season score X.X — next: FIX"
    // or "Name (POS, £X.Xm, Team) — score X.XX — FIX — reasons"
    const nameMatch = line.match(/^(.+?)\s*\(([^)]+)\)/);
    const scoreMatch = line.match(/(?:season )?score\s+([\d.]+)/);
    const reasonsMatch = line.match(/—\s*(?:next:\s*)?(.+)$/);

    const name = nameMatch ? nameMatch[1].trim() : line;
    const meta = nameMatch ? nameMatch[2].trim() : "";
    const score = scoreMatch ? parseFloat(scoreMatch[1]) : 0;

    let extra = "";
    if (reasonsMatch) {
        extra = reasonsMatch[1]
            .replace(/score\s+[\d.]+\s*—?\s*/, "")
            .replace(/season score\s+[\d.]+\s*—?\s*/, "")
            .trim();
    }

    return { name, meta, score, extra };
}

function parseChipLine(line) {
    // "GW32: WILDCARD (projected gain: +12.3)"
    const match = line.match(/GW(\d+):\s*(.+?)\s*\(projected gain:\s*\+?([\d.]+)\)/);
    if (match) {
        return { gw: parseInt(match[1]), chip: match[2].trim(), gain: parseFloat(match[3]) };
    }
    return { gw: 0, chip: line, gain: 0 };
}

function parseTransferLine(line, gwHeader) {
    // "OUT: Name (£X.Xm) → IN: Name (£X.Xm) — gain +X.X over remaining GWs [FREE]"
    const outMatch = line.match(/OUT:\s*(.+?)\s*\(([^)]+)\)/);
    const inMatch = line.match(/IN:\s*(.+?)\s*\(([^)]+)\)/);
    const gainMatch = line.match(/gain\s*\+?([\d.]+)/);
    const tagMatch = line.match(/\[([A-Z\s]+)\]/);

    return {
        gw: gwHeader || "",
        outName: outMatch ? outMatch[1].trim() : "?",
        outCost: outMatch ? outMatch[2].trim() : "",
        inName: inMatch ? inMatch[1].trim() : "?",
        inCost: inMatch ? inMatch[2].trim() : "",
        gain: gainMatch ? parseFloat(gainMatch[1]) : 0,
        tag: tagMatch ? tagMatch[1].trim() : "FREE",
    };
}

// ── Render ──────────────────────────────────────────────────────────────────

function renderMeta(meta) {
    const grid = document.getElementById("meta-grid");
    const items = Object.entries(meta);
    grid.innerHTML = items
        .map(
            ([key, value]) => `
        <div class="meta-item">
            <div class="meta-label">${escapeHtml(key)}</div>
            <div class="meta-value">${escapeHtml(value)}</div>
        </div>
    `,
        )
        .join("");
}

function renderChips(chips) {
    if (!chips.length) return;
    show("chips-section");
    const container = document.getElementById("chip-cards");

    container.innerHTML = chips
        .map((c) => {
            const cls = c.chip.toLowerCase().replace(/\s+/g, "");
            return `<div class="chip-card ${cls}">
                GW${c.gw}: ${escapeHtml(c.chip)}
                <span class="chip-gain">+${c.gain.toFixed(1)} projected</span>
            </div>`;
        })
        .join("");
}

function renderSquad(squad) {
    if (!squad.length) return;
    show("squad-section");
    const container = document.getElementById("squad-list");
    container.innerHTML = squad
        .map(
            (p) => `
        <div class="player-row">
            <span class="player-name">${escapeHtml(p.name)}</span>
            <span class="player-meta">${escapeHtml(p.meta)}</span>
            <span class="player-score">${p.score.toFixed(1)}</span>
            <span class="player-reasons">${escapeHtml(p.extra)}</span>
        </div>`,
        )
        .join("");
}

function renderTransfers(transfers, summary) {
    if (!transfers.length) return;
    show("transfers-section");

    const heading = document.getElementById("transfers-heading");
    heading.textContent = summary || "Transfer Plan";

    const container = document.getElementById("transfer-list");
    let html = "";
    let lastGw = "";

    for (const t of transfers) {
        if (t.gw && t.gw !== lastGw) {
            const chipTag = getGwChipTag(t.gw);
            html += `<div style="padding: 10px 12px; font-weight: 700; color: #334155; border-bottom: 2px solid #e2e8f0;">
                ${escapeHtml(t.gw)}${chipTag}
            </div>`;
            lastGw = t.gw;
        }

        const tagCls = getTagClass(t.tag);
        html += `
        <div class="transfer-row">
            <span class="transfer-out">${escapeHtml(t.outName)} <span class="player-meta">${escapeHtml(t.outCost)}</span></span>
            <span class="transfer-arrow">→</span>
            <span class="transfer-in">${escapeHtml(t.inName)} <span class="player-meta">${escapeHtml(t.inCost)}</span></span>
            <span class="transfer-tag ${tagCls}">${escapeHtml(t.tag)}</span>
            <span class="transfer-gain">+${t.gain.toFixed(1)}</span>
        </div>`;
    }

    container.innerHTML = html;
}

function renderPlayerList(players, containerId, sectionId) {
    if (!players.length) return;
    show(sectionId);
    const container = document.getElementById(containerId);
    container.innerHTML = players
        .map(
            (p) => `
        <div class="player-row">
            <span class="player-name">${escapeHtml(p.name)}</span>
            <span class="player-meta">${escapeHtml(p.meta)}</span>
            <span class="player-score">${p.score.toFixed(1)}</span>
            <span class="player-reasons">${escapeHtml(p.extra)}</span>
        </div>`,
        )
        .join("");
}

function getTagClass(tag) {
    const t = tag.toLowerCase();
    if (t.includes("wildcard")) return "tag-wildcard";
    if (t.includes("free hit") || t.includes("freehit")) return "tag-freehit";
    if (t.includes("bench")) return "tag-benchboost";
    if (t.includes("hit")) return "tag-hit";
    return "tag-free";
}

function getGwChipTag(gw) {
    // The GW header from parsing may contain chip info like "[WILDCARD]"
    const match = gw.match(/\[([A-Z\s]+)\]/);
    if (match) {
        const cls = getTagClass(match[1]);
        return ` <span class="transfer-tag ${cls}">${match[1]}</span>`;
    }
    return "";
}

function escapeHtml(str) {
    if (!str) return "";
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

// ── Load ────────────────────────────────────────────────────────────────────

async function loadReport() {
    try {
        const res = await fetch("/autoresearch-fpl/latest-report.md");
        if (!res.ok) throw new Error(`Report not available (${res.status})`);
        const md = await res.text();
        return md;
    } catch (err) {
        throw new Error("Report not yet generated. The optimizer will create it on its next cycle.");
    }
}

async function loadHealth() {
    try {
        const res = await fetch("/health");
        if (!res.ok) return null;
        return await res.json();
    } catch {
        return null;
    }
}

async function checkProgressChart() {
    try {
        const res = await fetch("/progress.svg", { method: "HEAD" });
        return res.ok;
    } catch {
        return false;
    }
}

async function init() {
    try {
        const [md, health, hasChart] = await Promise.all([
            loadReport(),
            loadHealth(),
            checkProgressChart(),
        ]);

        // Status
        if (health) {
            const statusEl = document.getElementById("cycle-status");
            if (health.cycleRunning) {
                statusEl.textContent = `Running cycle #${health.cycleCount}...`;
                statusEl.className = "cycle-status running";
            } else {
                statusEl.textContent = `Idle — ${health.cycleCount} cycles completed`;
                statusEl.className = "cycle-status idle";
            }
        }

        // Progress chart
        if (hasChart) {
            document.getElementById("progress-container").style.display = "";
            document.getElementById("progress-chart").src = "/progress.svg?" + Date.now();
        }

        // Parse and render report
        const data = parseReport(md);
        renderMeta(data.meta);
        renderChips(data.chips);
        renderSquad(data.squad);
        renderTransfers(data.transfers, data.transferSummary);
        renderPlayerList(data.finalSquad, "final-list", "final-section");
        renderPlayerList(data.topPlayers, "top-list", "top-section");

        statusBar.textContent = `Report loaded. Last updated: ${new Date().toLocaleString()}`;
        loading.style.display = "none";
        mainContent.style.display = "";
    } catch (err) {
        showError(err.message);
    }
}

init();

// Auto-refresh every 5 minutes
setInterval(init, 5 * 60 * 1000);
