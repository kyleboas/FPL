#!/usr/bin/env node

import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import {
  rankPlayers,
  buildSeasonScores,
  buildStartingSquad,
  planTransfersForGw,
  planTransfers,
  selectStartingEleven,
  selectBudgetSquad,
} from "./strategy.mjs";

const DATA_DIR = process.env.DATA_DIR || null;
const ROOT = fileURLToPath(new URL(".", import.meta.url));
const CACHE_DIR = join(tmpdir(), "fpl-cache");
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

async function readCache(key) {
  const file = join(CACHE_DIR, `${key}.json`);
  try {
    const s = await stat(file);
    if (Date.now() - s.mtimeMs > CACHE_TTL_MS) return null;
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

async function writeCache(key, data) {
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(join(CACHE_DIR, `${key}.json`), JSON.stringify(data), "utf8");
}

const WEIGHTS_URL = new URL("./weights.json", import.meta.url);
const REPORT_PATH = DATA_DIR ? join(DATA_DIR, "latest-report.md") : fileURLToPath(new URL("./latest-report.md", import.meta.url));

const FPL_BASE = "https://fantasy.premierleague.com/api";
const FPL_BOOTSTRAP_URL = `${FPL_BASE}/bootstrap-static/`;
const FPL_FIXTURES_URL = `${FPL_BASE}/fixtures/`;
const FINAL_GW = 38;
const SEASON_BASE =
  "https://raw.githubusercontent.com/olbauday/FPL-Elo-Insights/main/data/2025-2026/By%20Tournament/Premier%20League";

export const POSITION_NAMES = {
  1: "GK",
  2: "DEF",
  3: "MID",
  4: "FWD",
};

export const AVAILABILITY_BY_STATUS = {
  a: 1,
  d: 0.75,
  i: 0.5,
  u: 0.25,
  s: 0,
  n: 0,
};

export function toNumber(value, fallback = 0) {
  if (value === null || value === undefined || value === "") return fallback;
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function mean(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

function parseCsv(text) {
  const rows = [];
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) return rows;
  const lines = normalized.split("\n");
  const headers = splitCsvLine(lines[0]);

  for (let i = 1; i < lines.length; i += 1) {
    if (!lines[i].trim()) continue;
    const values = splitCsvLine(lines[i]);
    const row = {};
    for (let j = 0; j < headers.length; j += 1) {
      row[headers[j]] = castCsvValue(values[j] ?? "");
    }
    rows.push(row);
  }

  return rows;
}

function splitCsvLine(line) {
  const values = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];

    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === "," && !inQuotes) {
      values.push(current);
      current = "";
      continue;
    }

    current += char;
  }

  values.push(current);
  return values.map((value) => value.trim());
}

function castCsvValue(value) {
  const trimmed = value.trim();
  if (trimmed === "") return "";
  if (trimmed === "True") return true;
  if (trimmed === "False") return false;
  const num = Number(trimmed);
  if (Number.isFinite(num)) return num;
  return trimmed;
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url} (${response.status})`);
  }
  return response.json();
}

async function fetchCsv(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url} (${response.status})`);
  }
  const text = await response.text();
  return parseCsv(text);
}

async function loadWeights() {
  const raw = await readFile(WEIGHTS_URL, "utf8");
  return JSON.parse(raw);
}

async function loadBootstrap() {
  const cached = await readCache("bootstrap");
  if (cached) return cached;
  const data = await fetchJson(FPL_BOOTSTRAP_URL);
  await writeCache("bootstrap", data);
  return data;
}

async function loadFixtures() {
  const cached = await readCache("fixtures");
  if (cached) return cached;
  const data = await fetchJson(FPL_FIXTURES_URL);
  await writeCache("fixtures", data);
  return data;
}

async function loadSnapshotRows(gw) {
  const cached = await readCache(`gw-${gw}`);
  if (cached) return cached;
  const data = await fetchCsv(`${SEASON_BASE}/GW${gw}/player_gameweek_stats.csv`);
  await writeCache(`gw-${gw}`, data);
  return data;
}

async function loadTeamPicks(teamId, gw) {
  const data = await fetchJson(`${FPL_BASE}/entry/${teamId}/event/${gw}/picks/`);
  const picks = (data.picks ?? []).map((p) => p.element);
  const bank = toNumber(data.entry_history?.bank, 0);
  const teamValue = toNumber(data.entry_history?.value, 0);
  return { picks, bank, teamValue };
}

export function getPlayerId(player) {
  return toNumber(player.id ?? player.player_id, 0);
}

export function getTeamId(player) {
  return toNumber(player.team, 0);
}

export function getPosition(player) {
  return toNumber(player.element_type, 0);
}

export function groupRowsByPlayer(rows) {
  const grouped = new Map();
  for (const row of rows) {
    const playerId = getPlayerId(row);
    if (!playerId) continue;
    if (!grouped.has(playerId)) grouped.set(playerId, []);
    grouped.get(playerId).push(row);
  }
  return grouped;
}

function buildFixturesByTeamAndGw(fixtures) {
  const grouped = new Map();

  for (const fixture of fixtures) {
    const gw = toNumber(fixture.event, 0);
    if (!gw) continue;

    const homeTeam = toNumber(fixture.team_h, 0);
    const awayTeam = toNumber(fixture.team_a, 0);
    const homeDifficulty = toNumber(fixture.team_h_difficulty, 3);
    const awayDifficulty = toNumber(fixture.team_a_difficulty, 3);

    if (!grouped.has(gw)) grouped.set(gw, new Map());
    const byTeam = grouped.get(gw);

    if (!byTeam.has(homeTeam)) byTeam.set(homeTeam, []);
    if (!byTeam.has(awayTeam)) byTeam.set(awayTeam, []);

    byTeam.get(homeTeam).push({
      opponentTeam: awayTeam,
      isHome: true,
      difficulty: homeDifficulty,
    });
    byTeam.get(awayTeam).push({
      opponentTeam: homeTeam,
      isHome: false,
      difficulty: awayDifficulty,
    });
  }

  return grouped;
}

function formatMoney(nowCost) {
  return `£${(toNumber(nowCost, 0) / 10).toFixed(1)}m`;
}

function formatFixtures(fixtures, teamsById) {
  if (!fixtures.length) return "Blank";
  return fixtures
    .map((fixture) => {
      const team = teamsById.get(fixture.opponentTeam);
      const label = team?.short_name ?? team?.name ?? String(fixture.opponentTeam);
      return `${label}(${fixture.isHome ? "H" : "A"})`;
    })
    .join(", ");
}

function buildHistoryWindow(rowsByGw, endGw, historyWindow) {
  const startGw = Math.max(1, endGw - historyWindow + 1);
  const rows = [];
  for (let gw = startGw; gw <= endGw; gw += 1) {
    const gwRows = rowsByGw.get(gw) ?? [];
    rows.push(...gwRows);
  }
  return groupRowsByPlayer(rows);
}

function actualPoints(actualRowsById, playerId) {
  return toNumber(actualRowsById.get(playerId)?.event_points, 0);
}

function actualMinutes(actualRowsById, playerId) {
  return toNumber(actualRowsById.get(playerId)?.minutes, 0);
}

const STARTING_MINIMUMS = { DEF: 3, MID: 2, FWD: 1 };
const STARTING_MAXIMUMS = { DEF: 5, MID: 5, FWD: 3 };

function projectedSquadPlayersForGw(squadIds, seasonScores, gw) {
  return squadIds
    .map((id) => {
      const data = seasonScores.get(id);
      if (!data?.scored) return null;
      const gwEntry = data.gwScores.find((entry) => entry.gw === gw);
      return {
        id,
        player: data.scored.player,
        positionName: data.scored.positionName,
        teamName: data.scored.teamName,
        score: gwEntry ? gwEntry.score : 0,
      };
    })
    .filter(Boolean);
}

function validOutfieldFormation(counts) {
  return Object.entries(STARTING_MINIMUMS).every(([positionName, minimum]) => toNumber(counts[positionName], 0) >= minimum)
    && Object.entries(STARTING_MAXIMUMS).every(([positionName, maximum]) => toNumber(counts[positionName], 0) <= maximum);
}

function scoreActualLineup({ lineup, actualById, benchBoost = false }) {
  const finalStarting = [...lineup.starting];
  const benchGoalkeeper = lineup.bench.find((player) => player.positionName === "GK") ?? null;
  const benchOutfield = lineup.bench.filter((player) => player.positionName !== "GK");

  if (!benchBoost) {
    const startingGoalkeeperIndex = finalStarting.findIndex((player) => player.positionName === "GK");
    if (startingGoalkeeperIndex >= 0) {
      const starter = finalStarting[startingGoalkeeperIndex];
      if (actualMinutes(actualById, getPlayerId(starter)) <= 0 && benchGoalkeeper) {
        if (actualMinutes(actualById, getPlayerId(benchGoalkeeper)) > 0) {
          finalStarting[startingGoalkeeperIndex] = benchGoalkeeper;
        }
      }
    }

    const outfieldCounts = { DEF: 0, MID: 0, FWD: 0 };
    const absentOutfieldIndices = [];

    for (let index = 0; index < finalStarting.length; index += 1) {
      const player = finalStarting[index];
      if (player.positionName === "GK") continue;
      outfieldCounts[player.positionName] = toNumber(outfieldCounts[player.positionName], 0) + 1;
      if (actualMinutes(actualById, getPlayerId(player)) <= 0) {
        absentOutfieldIndices.push(index);
      }
    }

    for (const benchPlayer of benchOutfield) {
      if (actualMinutes(actualById, getPlayerId(benchPlayer)) <= 0) continue;

      const replacementIndex = absentOutfieldIndices.find((index) => {
        const starter = finalStarting[index];
        if (!starter || starter.positionName === "GK") return false;

        const nextCounts = { ...outfieldCounts };
        nextCounts[starter.positionName] = toNumber(nextCounts[starter.positionName], 0) - 1;
        nextCounts[benchPlayer.positionName] = toNumber(nextCounts[benchPlayer.positionName], 0) + 1;
        return validOutfieldFormation(nextCounts);
      });

      if (replacementIndex === undefined) continue;

      const replaced = finalStarting[replacementIndex];
      outfieldCounts[replaced.positionName] = toNumber(outfieldCounts[replaced.positionName], 0) - 1;
      finalStarting[replacementIndex] = benchPlayer;
      outfieldCounts[benchPlayer.positionName] = toNumber(outfieldCounts[benchPlayer.positionName], 0) + 1;
      absentOutfieldIndices.splice(absentOutfieldIndices.indexOf(replacementIndex), 1);
    }
  }

  const startingTotal = sum(finalStarting.map((player) => actualPoints(actualById, getPlayerId(player))));
  const benchTotal = benchBoost
    ? sum(lineup.bench.map((player) => actualPoints(actualById, getPlayerId(player))))
    : 0;

  const captainPlayed = lineup.captain && actualMinutes(actualById, getPlayerId(lineup.captain)) > 0;
  const vicePlayed = lineup.viceCaptain && actualMinutes(actualById, getPlayerId(lineup.viceCaptain)) > 0;
  const captainBonus = captainPlayed
    ? actualPoints(actualById, getPlayerId(lineup.captain))
    : vicePlayed
      ? actualPoints(actualById, getPlayerId(lineup.viceCaptain))
      : 0;

  return {
    finalStarting,
    startingTotal,
    benchTotal,
    captainBonus,
    total: startingTotal + benchTotal + captainBonus,
  };
}

function renderLineup(lines, title, lineup, scoreKey, decimals = 1, scoreLabel = "score") {
  lines.push(title);
  lines.push("");
  lines.push(`- Captain: ${lineup.captain?.player?.web_name ?? "?"} (${toNumber(lineup.captain?.[scoreKey], 0).toFixed(decimals)})`);
  lines.push(`- Vice captain: ${lineup.viceCaptain?.player?.web_name ?? "?"} (${toNumber(lineup.viceCaptain?.[scoreKey], 0).toFixed(decimals)})`);
  lines.push("");
  lines.push("### Starting 11");
  lines.push("");
  for (const player of lineup.starting) {
    const isCaptain = player === lineup.captain;
    const isViceCaptain = player === lineup.viceCaptain;
    const tag = isCaptain ? " (C)" : isViceCaptain ? " (VC)" : "";
    lines.push(
      `- ${player.player.web_name ?? player.player.second_name}${tag} (${player.positionName}, ${formatMoney(player.player.now_cost)}, ${player.teamName}) — ${scoreLabel} ${toNumber(player[scoreKey], 0).toFixed(decimals)}`,
    );
  }
  lines.push("");
  lines.push("### Bench");
  lines.push("");
  for (const player of lineup.bench) {
    lines.push(
      `- ${player.player.web_name ?? player.player.second_name} (${player.positionName}, ${formatMoney(player.player.now_cost)}, ${player.teamName}) — ${scoreLabel} ${toNumber(player[scoreKey], 0).toFixed(decimals)}`,
    );
  }
  lines.push("");
}

/**
 * Season simulator backtest.
 *
 * 1. Build a starting squad at an early GW using budget selection
 * 2. Each subsequent GW:
 *    a. Re-score all players using point-in-time data up to previous GW
 *    b. Use planTransfers to decide transfers (driven by weights)
 *    c. Score the squad using ACTUAL points from historical data
 *    d. Deduct hit costs
 * 3. Return total points as the metric
 */
function simulateSeason({
  rowsByGw,
  playerMetaById,
  weights,
  fixturesByTeamAndGw,
  teamsById,
  startGw,
  endGw,
}) {
  const hitCost = toNumber(weights.hitCost, 4);
  const squadSize = weights.squadSize ?? { GK: 2, DEF: 5, MID: 5, FWD: 3 };

  // Build starting squad using data available at startGw-1
  const historyForStart = buildHistoryWindow(rowsByGw, startGw - 1, weights.historyWindow);
  const startSnapshot = rowsByGw.get(startGw - 1) ?? [];

  let squadIds = buildStartingSquad({
    snapshotRows: startSnapshot,
    playerMetaById,
    historyRowsByPlayer: historyForStart,
    weights,
    targetGw: startGw,
    fixturesByTeamAndGw,
    teamsById,
  });

  let totalPoints = 0;
  let totalHitCost = 0;
  let freeTransfers = 1;
  let bank = toNumber(weights.budget, 1000) - sum(squadIds.map((id) => toNumber(playerMetaById.get(id)?.now_cost, 0)));
  const gwResults = [];

  for (let gw = startGw; gw <= endGw; gw += 1) {
    // Re-score players using data available up to gw-1 (no future knowledge)
    const historyRows = buildHistoryWindow(rowsByGw, gw - 1, weights.historyWindow);
    const snapshot = rowsByGw.get(gw - 1) ?? [];

    // Build season scores from this GW forward using point-in-time knowledge
    const seasonScores = buildSeasonScores({
      players: snapshot.length > 0 ? snapshot : [...playerMetaById.values()],
      playerMetaById,
      historyRowsByPlayer: historyRows,
      weights,
      fromGw: gw,
      toGw: endGw,
      fixturesByTeamAndGw,
      teamsById,
    });

    // Plan transfers for this GW
    const plan = planTransfersForGw({
      squadIds,
      seasonScores,
      weights,
      gw,
      endGw,
      freeTransfers,
      bank,
    });

    squadIds = plan.newSquadIds;
    bank = plan.newBank;
    totalHitCost += plan.hitsTaken * hitCost;

    // Bank unused free transfers
    const unusedFree = Math.max(0, freeTransfers - plan.transfersMade);
    freeTransfers = Math.min(5, 1 + unusedFree);

    // Pick the projected XI and score it using the actual GW outcome.
    const actualRows = rowsByGw.get(gw) ?? [];
    const actualById = new Map(actualRows.map((row) => [getPlayerId(row), row]));
    const projectedSquad = projectedSquadPlayersForGw(squadIds, seasonScores, gw);
    const lineup = selectStartingEleven(projectedSquad, "score");
    const { total: gwPoints } = scoreActualLineup({ lineup, actualById });

    const netPoints = gwPoints - plan.hitsTaken * hitCost;
    totalPoints += netPoints;

    gwResults.push({
      gw,
      gwPoints,
      hitsTaken: plan.hitsTaken,
      netPoints,
      transfersMade: plan.transfersMade,
      squadSize: squadIds.length,
    });
  }

  return { totalPoints, totalHitCost, gwResults };
}

function renderBacktestSummary(simResult, startGw, endGw, splitGw) {
  const lines = [];
  lines.push("Season simulation backtest");
  lines.push(`Gameweeks simulated: GW${startGw} → GW${endGw} (${simResult.gwResults.length} GWs)`);
  lines.push(`total_points: ${simResult.totalPoints.toFixed(1)}`);
  lines.push(`total_hit_cost: ${simResult.totalHitCost.toFixed(0)}`);
  lines.push(`avg_points_per_gw: ${(simResult.totalPoints / simResult.gwResults.length).toFixed(2)}`);

  // Train/holdout reporting
  if (splitGw && splitGw > startGw && splitGw < endGw) {
    const trainGws = simResult.gwResults.filter((g) => g.gw <= splitGw);
    const holdoutGws = simResult.gwResults.filter((g) => g.gw > splitGw);
    if (trainGws.length > 0) {
      const trainPts = trainGws.reduce((s, g) => s + g.netPoints, 0);
      lines.push(`train_gws: GW${trainGws[0].gw} → GW${trainGws.at(-1)?.gw ?? trainGws[0].gw} (${trainGws.length} GWs)`);
      lines.push(`train_avg_points: ${(trainPts / trainGws.length).toFixed(2)}`);
    }
    if (holdoutGws.length > 0) {
      const holdoutPts = holdoutGws.reduce((s, g) => s + g.netPoints, 0);
      const holdoutAvg = holdoutPts / holdoutGws.length;
      const trainAvg = trainGws.length > 0
        ? trainGws.reduce((s, g) => s + g.netPoints, 0) / trainGws.length
        : 0;
      lines.push(`holdout_gws: GW${holdoutGws[0].gw} → GW${holdoutGws.at(-1)?.gw ?? holdoutGws[0].gw} (${holdoutGws.length} GWs)`);
      lines.push(`holdout_avg_points: ${holdoutAvg.toFixed(2)}`);
      lines.push(`holdout_gap: ${(holdoutAvg - trainAvg).toFixed(2)}`);
    }
  }

  lines.push("");

  lines.push("Per-GW breakdown (last 5):");
  for (const gw of simResult.gwResults.slice(-5)) {
    lines.push(
      `  GW${gw.gw}: ${gw.gwPoints} pts, ${gw.transfersMade} transfers, ${gw.hitsTaken} hits → net ${gw.netPoints}`,
    );
  }

  return lines.join("\n");
}

function resolveBacktestSplitGw(startGw, endGw) {
  const explicitSplitArg = process.argv.find((a) => a.startsWith("--split-gw="));
  if (explicitSplitArg) {
    const splitGw = parseInt(explicitSplitArg.split("=")[1], 10);
    return Number.isFinite(splitGw) ? splitGw : null;
  }

  const explicitHoldoutArg = process.argv.find((a) => a.startsWith("--holdout-gws="));
  if (explicitHoldoutArg) {
    const holdoutGws = parseInt(explicitHoldoutArg.split("=")[1], 10);
    if (!Number.isFinite(holdoutGws) || holdoutGws <= 0) return null;
    return endGw - holdoutGws;
  }

  const totalGws = endGw - startGw + 1;
  if (totalGws < 12) return null;

  const defaultHoldoutGws = Math.min(8, Math.max(6, Math.floor(totalGws / 4)));
  return endGw - defaultHoldoutGws;
}

function renderReport({
  ranked,
  targetGw,
  currentGw,
  weights,
  teamsById,
  currentSquadScored,
  transferPlan,
  bank,
  seasonScores,
}) {
  const lines = [];
  lines.push(`# FPL autoresearch report`);
  lines.push("");
  lines.push(`- Target GW: ${targetGw} → ${FINAL_GW} (${FINAL_GW - targetGw + 1} GWs remaining)`);
  lines.push(`- Completed GW: ${currentGw}`);
  lines.push(`- History window: last ${weights.historyWindow} completed GWs`);
  lines.push(`- Filters: min ${weights.minimumRecentMinutes} recent minutes, min ${weights.minimumChanceOfPlaying}% availability`);

  if (currentSquadScored) {
    const chipList = Object.entries(weights.chips ?? {}).filter(([, v]) => v).map(([k]) => k);
    const chipStr = chipList.length > 0 ? chipList.join(", ") : "none";
    lines.push(`- Bank: ${formatMoney(bank)} | Free transfers: ${weights.freeTransfers} | Chips: ${chipStr}`);
    lines.push("");

    // Current squad with season scores
    lines.push("## Current squad");
    lines.push("");
    const sorted = [...currentSquadScored].sort((a, b) => b.seasonScore - a.seasonScore);
    for (const p of sorted) {
      const fixtures = formatFixtures(
        p.scored?.fixtures ?? [],
        teamsById,
      );
      lines.push(
        `- ${p.scored?.player?.web_name ?? "?"} (${p.scored?.positionName ?? "?"}, ${formatMoney(
          p.scored?.player?.now_cost,
        )}, ${p.scored?.teamName ?? "?"}) — season score ${p.seasonScore.toFixed(1)} — next: ${fixtures}`,
      );
    }
    lines.push("");

    const currentLineupPlayers = currentSquadScored.map((p) => ({
      player: p.scored.player,
      positionName: p.scored.positionName,
      teamName: p.scored.teamName,
      score: p.seasonScore,
    }));
    renderLineup(lines, "## Current lineup", selectStartingEleven(currentLineupPlayers, "score"), "score", 1, "season score");

    // Chip plan
    if (transferPlan?.chipPlan?.length > 0) {
      lines.push("## Chip strategy");
      lines.push("");
      for (const chip of transferPlan.chipPlan) {
        lines.push(`- GW${chip.gw}: ${chip.chip} (projected gain: +${chip.gain.toFixed(1)})`);
      }
      lines.push("");
    }

    // Transfer plan
    if (transferPlan && transferPlan.transfers.length > 0) {
      const normalTransfers = transferPlan.transfers.filter((t) => !t.chip);
      const totalHits = normalTransfers.filter((t) => t.hit).length;
      const totalHitCost = totalHits * toNumber(weights.hitCost, 4);
      lines.push(`## Transfer plan (${transferPlan.transfers.length} transfers, ${totalHits} hits = -${totalHitCost} pts)`);
      lines.push("");

      let lastGw = 0;
      for (const t of transferPlan.transfers) {
        if (t.gw !== lastGw) {
          const chipForGw = transferPlan.chipPlan?.find((c) => c.gw === t.gw);
          const chipTag = chipForGw ? ` [${chipForGw.chip}]` : "";
          lines.push(`### GW${t.gw}${chipTag}`);
          lastGw = t.gw;
        }
        const outName = t.out?.player?.web_name ?? t.out?.player?.second_name ?? "?";
        const inName = t.in?.player?.web_name ?? t.in?.player?.second_name ?? "?";
        const tag = t.chip ? ` [${t.chip.toUpperCase()}]` : t.hit ? " [HIT]" : " [FREE]";
        lines.push(
          `- OUT: ${outName} (${formatMoney(t.out?.player?.now_cost)}) → IN: ${inName} (${formatMoney(t.in?.player?.now_cost)})${t.gain ? ` — gain +${t.gain.toFixed(1)}` : ""}${tag}`,
        );
      }
      lines.push("");

      // Final squad after all transfers
      lines.push("## Final squad (after all transfers)");
      lines.push("");
      for (const positionName of ["GK", "DEF", "MID", "FWD"]) {
        const posPlayers = transferPlan.finalSquadIds
          .map((id) => seasonScores.get(id))
          .filter((p) => p?.scored?.positionName === positionName)
          .sort((a, b) => b.seasonScore - a.seasonScore);
        for (const p of posPlayers) {
          lines.push(
            `- ${p.scored.player.web_name ?? p.scored.player.second_name} (${positionName}, ${formatMoney(p.scored.player.now_cost)}, ${p.scored.teamName}) — season score ${p.seasonScore.toFixed(1)}`,
          );
        }
      }
      lines.push("");

      // Starting 11 from final squad
      const finalSquadPlayers = transferPlan.finalSquadIds
        .map((id) => seasonScores.get(id))
        .filter((p) => p?.scored)
        .map((p) => ({
          player: p.scored.player,
          positionName: p.scored.positionName,
          teamName: p.scored.teamName,
          score: p.seasonScore,
        }));
      renderLineup(lines, "## Final lineup", selectStartingEleven(finalSquadPlayers, "score"), "score", 1, "season score");
      
      // Starting 11 per GW
      if (transferPlan.squadPerGw && transferPlan.squadPerGw.length > 0) {
        lines.push("## Starting 11 per GW");
        lines.push("");
        
        for (const { gw, squadIds } of transferPlan.squadPerGw) {
          // Get GW-specific scores for each player
          const gwPlayers = squadIds
            .map((id) => {
              const data = seasonScores.get(id);
              if (!data?.scored) return null;
              const gwEntry = data.gwScores.find((g) => g.gw === gw);
              return {
                player: data.scored.player,
                positionName: data.scored.positionName,
                teamName: data.scored.teamName,
                gwScore: gwEntry ? gwEntry.score : 0,
              };
            })
            .filter((p) => p !== null);
          
          const { starting: gwStarting, bench: gwBench, captain, viceCaptain } = selectStartingEleven(gwPlayers, "gwScore");
          
          const chipForGw = transferPlan.chipPlan?.find((c) => c.gw === gw);
          const chipTag = chipForGw ? ` [${chipForGw.chip}]` : "";
          
          lines.push(`### GW${gw}${chipTag}`);
          lines.push("");
          lines.push(`**Captain:** ${captain?.player?.web_name ?? "?"} (${captain?.gwScore?.toFixed(2) ?? 0})`);
          lines.push(`**Vice-Captain:** ${viceCaptain?.player?.web_name ?? "?"} (${viceCaptain?.gwScore?.toFixed(2) ?? 0})`);
          lines.push("");
          lines.push("**Starting:**");
          for (const player of gwStarting) {
            const isCaptain = player === captain;
            const isViceCaptain = player === viceCaptain;
            const tag = isCaptain ? " (C)" : isViceCaptain ? " (VC)" : "";
            lines.push(
              `- ${player.player.web_name ?? player.player.second_name}${tag} (${player.positionName}, ${formatMoney(player.player.now_cost)}, ${player.teamName}) — GW score ${player.gwScore.toFixed(2)}`,
            );
          }
          lines.push("");
          lines.push("**Bench:**");
          for (const player of gwBench) {
            lines.push(
              `- ${player.player.web_name ?? player.player.second_name} (${player.positionName}, ${formatMoney(player.player.now_cost)}, ${player.teamName}) — GW score ${player.gwScore.toFixed(2)}`,
            );
          }
          lines.push("");
        }
      }
    } else {
      lines.push("## Transfer plan");
      lines.push("");
      lines.push("No beneficial transfers found.");
      lines.push("");
    }
  } else {
    // No team ID — fall back to budget squad selection
    const { squad, spent, budget } = selectBudgetSquad(ranked, weights);
    const squadSize = weights.squadSize ?? { GK: 2, DEF: 5, MID: 5, FWD: 3 };
    const totalSlots = Object.values(squadSize).reduce((a, b) => a + b, 0);

    lines.push(`- Budget: ${formatMoney(budget)} | Spent: ${formatMoney(spent)} | Remaining: ${formatMoney(budget - spent)}`);
    lines.push(`- Squad: ${squad.length}/${totalSlots} (no teamId set — showing best budget squad)`);
    lines.push("");

    lines.push(`## Best ${totalSlots} (within budget)`);
    lines.push("");
    for (const player of squad) {
      lines.push(
        `- ${player.player.web_name ?? player.player.second_name} (${player.positionName}, ${formatMoney(
          player.player.now_cost,
        )}, ${player.teamName}) — score ${player.score.toFixed(2)} — ${formatFixtures(player.fixtures, teamsById)} — ${player.topReasons.join("; ")}`,
      );
    }
    lines.push("");

    renderLineup(lines, "## Suggested lineup", selectStartingEleven(squad, "score"), "score", 2, "score");
  }

  // Always show top overall picks for reference
  lines.push("## Top players by season score");
  lines.push("");
  const topSeason = [...seasonScores.entries()]
    .filter(([, v]) => v.scored)
    .sort((a, b) => b[1].seasonScore - a[1].seasonScore)
    .slice(0, 20);
  for (const [, data] of topSeason) {
    const p = data.scored;
    lines.push(
      `- ${p.player.web_name ?? p.player.second_name} (${p.positionName}, ${formatMoney(p.player.now_cost)}, ${p.teamName}) — season score ${data.seasonScore.toFixed(1)} — ${p.topReasons.join("; ")}`,
    );
  }
  lines.push("");

  return lines.join("\n").trim() + "\n";
}

async function runBacktest(weights) {
  const bootstrap = await loadBootstrap();
  const fixtures = await loadFixtures();
  const currentGw =
    bootstrap.events.find((event) => event.is_current)?.id ??
    bootstrap.events.find((event) => event.is_next)?.id ??
    1;

  const teamsById = new Map(bootstrap.teams.map((team) => [team.id, team]));
  const playerMetaById = new Map(bootstrap.elements.map((player) => [player.id, player]));
  const fixturesByTeamAndGw = buildFixturesByTeamAndGw(fixtures);

  // Load all historical snapshots
  const rowsByGw = new Map();
  const snapshotPromises = [];
  for (let gw = 1; gw <= currentGw; gw += 1) {
    snapshotPromises.push(
      loadSnapshotRows(gw).then((rows) => {
        rowsByGw.set(gw, rows);
      }),
    );
  }
  await Promise.all(snapshotPromises);

  // Simulate a full season: build squad at startGw, then transfer through endGw
  // Start after enough history is available for features
  const startGw = Math.max(2, weights.historyWindow + 2);
  const endGw = currentGw;

  if (startGw >= endGw) {
    console.log("Not enough completed gameweeks to simulate. Need at least " + (weights.historyWindow + 3));
    return;
  }

  const simResult = simulateSeason({
    rowsByGw,
    playerMetaById,
    weights,
    fixturesByTeamAndGw,
    teamsById,
    startGw,
    endGw,
  });

  const splitGw = resolveBacktestSplitGw(startGw, endGw);

  const output = renderBacktestSummary(simResult, startGw, endGw, splitGw);
  console.log(output);
}

async function runReport(weights) {
  const bootstrap = await loadBootstrap();
  const fixtures = await loadFixtures();
  const currentGw =
    bootstrap.events.find((event) => event.is_current)?.id ??
    bootstrap.events.find((event) => event.finished)?.id ??
    1;
  const nextGw =
    bootstrap.events.find((event) => event.is_next)?.id ??
    bootstrap.events.find((event) => !event.finished && event.id >= currentGw)?.id ??
    currentGw;

  const teamsById = new Map(bootstrap.teams.map((team) => [team.id, team]));
  const playerMetaById = new Map(bootstrap.elements.map((player) => [player.id, player]));
  const fixturesByTeamAndGw = buildFixturesByTeamAndGw(fixtures);

  const rowsByGw = new Map();
  const startGw = Math.max(1, currentGw - weights.historyWindow + 1);
  const snapshotPromises = [];
  for (let gw = startGw; gw <= currentGw; gw += 1) {
    snapshotPromises.push(
      loadSnapshotRows(gw).then((rows) => {
        rowsByGw.set(gw, rows);
      }),
    );
  }
  await Promise.all(snapshotPromises);

  const historyRowsByPlayer = buildHistoryWindow(rowsByGw, currentGw, weights.historyWindow);

  // Rank for next GW (used as fallback if no teamId)
  const ranked = rankPlayers({
    snapshotRows: bootstrap.elements,
    playerMetaById,
    historyRowsByPlayer,
    weights,
    targetGw: nextGw,
    fixturesByTeamAndGw,
    teamsById,
  });

  // Build season scores for all players (nextGw through GW38)
  const seasonScores = buildSeasonScores({
    players: bootstrap.elements,
    playerMetaById,
    historyRowsByPlayer,
    weights,
    fromGw: nextGw,
    toGw: FINAL_GW,
    fixturesByTeamAndGw,
    teamsById,
  });

  // If teamId is set, fetch current squad and plan transfers
  let currentSquadScored = null;
  let transferPlan = null;
  let bank = 0;
  const teamId = toNumber(weights.teamId, 0);

  if (teamId > 0) {
    try {
      const teamData = await loadTeamPicks(teamId, currentGw);
      bank = teamData.bank;

      currentSquadScored = teamData.picks.map((id) => {
        const data = seasonScores.get(id);
        if (data) return data;
        // Player not in season scores (filtered out) — score them minimally
        const meta = playerMetaById.get(id);
        return {
          seasonScore: 0,
          gwScores: [],
          scored: meta
            ? {
                id,
                player: meta,
                positionName: POSITION_NAMES[getPosition(meta)] ?? "?",
                teamName: teamsById.get(getTeamId(meta))?.name ?? "?",
                fixtures: [],
                topReasons: [],
              }
            : null,
        };
      }).filter((p) => p.scored);

      transferPlan = planTransfers({
        currentSquadIds: teamData.picks,
        seasonScores,
        playerMetaById,
        weights,
        fromGw: nextGw,
        toGw: FINAL_GW,
        fixturesByTeamAndGw,
        teamsById,
        bank,
      });

      console.log(`[report] team ${teamId}: ${teamData.picks.length} players, bank ${formatMoney(bank)}, ${transferPlan.transfers.length} transfers planned`);
    } catch (err) {
      console.error(`[report] failed to load team ${teamId}: ${err.message}`);
      console.error("[report] falling back to budget squad mode");
    }
  }

  const report = renderReport({
    ranked,
    targetGw: nextGw,
    currentGw,
    weights,
    teamsById,
    currentSquadScored,
    transferPlan,
    bank,
    seasonScores,
  });

  await writeFile(REPORT_PATH, report, "utf8");
  console.log(report);
  console.log(`Saved report to ${REPORT_PATH}`);
}

async function main() {
  const mode = process.argv[2] ?? "report";
  const weights = await loadWeights();

  if (mode === "backtest") {
    await runBacktest(weights);
    return;
  }

  if (mode === "report") {
    await runReport(weights);
    return;
  }

  throw new Error(`Unknown mode: ${mode}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
