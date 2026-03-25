#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";

const ROOT = new URL(".", import.meta.url);
const WEIGHTS_URL = new URL("./weights.json", ROOT);
const REPORT_URL = new URL("./latest-report.md", ROOT);

const FPL_BASE = "https://fantasy.premierleague.com/api";
const FPL_BOOTSTRAP_URL = `${FPL_BASE}/bootstrap-static/`;
const FPL_FIXTURES_URL = `${FPL_BASE}/fixtures/`;
const FINAL_GW = 38;
const SEASON_BASE =
  "https://raw.githubusercontent.com/olbauday/FPL-Elo-Insights/main/data/2025-2026/By%20Tournament/Premier%20League";

const POSITION_NAMES = {
  1: "GK",
  2: "DEF",
  3: "MID",
  4: "FWD",
};

const AVAILABILITY_BY_STATUS = {
  a: 1,
  d: 0.75,
  i: 0.5,
  u: 0.25,
  s: 0,
  n: 0,
};

function toNumber(value, fallback = 0) {
  if (value === null || value === undefined || value === "") return fallback;
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function mean(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function sum(values) {
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
  return fetchJson(FPL_BOOTSTRAP_URL);
}

async function loadFixtures() {
  return fetchJson(FPL_FIXTURES_URL);
}

async function loadSnapshotRows(gw) {
  return fetchCsv(`${SEASON_BASE}/GW${gw}/player_gameweek_stats.csv`);
}

async function loadTeamPicks(teamId, gw) {
  const data = await fetchJson(`${FPL_BASE}/entry/${teamId}/event/${gw}/picks/`);
  const picks = (data.picks ?? []).map((p) => p.element);
  const bank = toNumber(data.entry_history?.bank, 0);
  const teamValue = toNumber(data.entry_history?.value, 0);
  return { picks, bank, teamValue };
}

function getPlayerId(player) {
  return toNumber(player.id ?? player.player_id, 0);
}

function getTeamId(player) {
  return toNumber(player.team, 0);
}

function getPosition(player) {
  return toNumber(player.element_type, 0);
}

function groupRowsByPlayer(rows) {
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

function availabilityScore(player) {
  const chance = player.chance_of_playing_next_round;
  if (chance !== null && chance !== undefined && chance !== "") {
    return clamp(toNumber(chance) / 100, 0, 1);
  }
  return AVAILABILITY_BY_STATUS[player.status] ?? 1;
}

function mergePlayerData(playerMeta, snapshotPlayer) {
  const merged = { ...playerMeta };
  for (const [key, value] of Object.entries(snapshotPlayer)) {
    if (value === "" || value === null || value === undefined) continue;
    merged[key] = value;
  }
  return merged;
}

function averagePer90(rows, key) {
  const per90Values = rows
    .map((row) => {
      const minutes = toNumber(row.minutes, 0);
      if (minutes <= 0) return null;
      return (toNumber(row[key], 0) / minutes) * 90;
    })
    .filter((value) => value !== null);
  return mean(per90Values);
}

function countRecentCleanSheets(rows) {
  const matches = rows.filter((row) => toNumber(row.minutes, 0) > 0);
  if (!matches.length) return 0;
  const cleanSheets = matches.filter((row) => toNumber(row.clean_sheets, 0) > 0).length;
  return cleanSheets / matches.length;
}

function recentMinutesRatio(rows) {
  const minutes = rows.map((row) => clamp(toNumber(row.minutes, 0) / 90, 0, 1));
  return mean(minutes);
}

function recentTotalMinutes(rows) {
  return sum(rows.map((row) => toNumber(row.minutes, 0)));
}

function normalizeFeature(value, divisor) {
  return clamp(value / divisor, 0, 2);
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

function featureLabel(name, rawValue) {
  switch (name) {
    case "fixtureEase":
      return `fixture ease ${rawValue.toFixed(2)}`;
    case "fixtureCountBonus":
      return rawValue > 0 ? `${rawValue + 1} fixtures` : "single fixture";
    case "availability":
      return `${Math.round(rawValue * 100)}% availability`;
    case "epNext":
      return `ep_next ${rawValue.toFixed(1)}`;
    case "form":
      return `form ${rawValue.toFixed(1)}`;
    case "pointsPerGame":
      return `${rawValue.toFixed(1)} pts/game`;
    case "seasonMinutes":
      return `${Math.round(rawValue * 2500)} season minutes`;
    case "recentMinutesRatio":
      return `${Math.round(rawValue * 90)} mins avg`;
    case "recentPointsPer90":
      return `${rawValue.toFixed(1)} pts/90`;
    case "recentXgiPer90":
      return `${rawValue.toFixed(2)} xGI/90`;
    case "recentBonusPer90":
      return `${rawValue.toFixed(2)} bonus/90`;
    case "value":
      return `${rawValue.toFixed(2)} value`;
    case "recentCleanSheetRate":
      return `${Math.round(rawValue * 100)}% clean-sheet rate`;
    case "recentSavesPer90":
      return `${rawValue.toFixed(1)} saves/90`;
    case "recentGoalsConcededPer90":
      return `${rawValue.toFixed(2)} goals conceded/90`;
    case "recentExpectedGoalsPer90":
      return `${rawValue.toFixed(2)} xG/90`;
    case "recentExpectedAssistsPer90":
      return `${rawValue.toFixed(2)} xA/90`;
    default:
      return `${name} ${rawValue.toFixed(2)}`;
  }
}

function scorePlayer({
  player,
  playerMetaById,
  historyRows,
  weights,
  targetGw,
  fixturesByTeamAndGw,
  teamsById,
}) {
  const playerId = getPlayerId(player);
  const playerMeta = playerMetaById.get(playerId) ?? {};
  const mergedPlayer = mergePlayerData(playerMeta, player);
  const position = getPosition(mergedPlayer);
  const positionName = POSITION_NAMES[position];
  if (!playerId || !positionName) return null;

  const teamId = getTeamId(mergedPlayer);
  const fixtures = fixturesByTeamAndGw.get(targetGw)?.get(teamId) ?? [];
  if (!fixtures.length) return null;

  const totalRecentMinutes = recentTotalMinutes(historyRows);
  const availability = availabilityScore(mergedPlayer);
  const seasonMinutes = toNumber(playerMeta.minutes ?? mergedPlayer.minutes, 0);
  if (totalRecentMinutes < weights.minimumRecentMinutes) return null;
  if (availability * 100 < weights.minimumChanceOfPlaying) return null;
  if (seasonMinutes < weights.minimumSeasonMinutes) return null;

  const fixtureEaseRaw = sum(fixtures.map((fixture) => 6 - toNumber(fixture.difficulty, 3)));
  const featureValues = {
    availability,
    fixtureEase: fixtureEaseRaw / (fixtures.length * 5),
    fixtureCountBonus: Math.max(0, fixtures.length - 1),
    epNext: normalizeFeature(toNumber(mergedPlayer.ep_next, 0), 10),
    form: normalizeFeature(toNumber(mergedPlayer.form, 0), 10),
    pointsPerGame: normalizeFeature(toNumber(mergedPlayer.points_per_game, 0), 10),
    seasonMinutes: normalizeFeature(seasonMinutes, 2500),
    recentMinutesRatio: recentMinutesRatio(historyRows),
    recentPointsPer90: normalizeFeature(averagePer90(historyRows, "event_points"), 10),
    recentXgiPer90: normalizeFeature(
      averagePer90(historyRows, "expected_goals") + averagePer90(historyRows, "expected_assists"),
      1.5,
    ),
    recentBonusPer90: normalizeFeature(averagePer90(historyRows, "bonus"), 2),
    value: normalizeFeature(
      toNumber(mergedPlayer.points_per_game, 0) / Math.max(toNumber(mergedPlayer.now_cost, 0) / 10, 3.5),
      1.2,
    ),
    recentCleanSheetRate: countRecentCleanSheets(historyRows),
    recentSavesPer90: normalizeFeature(averagePer90(historyRows, "saves"), 5),
    recentGoalsConcededPer90: normalizeFeature(averagePer90(historyRows, "goals_conceded"), 3),
    recentExpectedGoalsPer90: normalizeFeature(averagePer90(historyRows, "expected_goals"), 1.2),
    recentExpectedAssistsPer90: normalizeFeature(averagePer90(historyRows, "expected_assists"), 1.2),
  };

  const contributions = [];
  let score = 0;

  for (const [name, weight] of Object.entries(weights.common)) {
    const value = featureValues[name] ?? 0;
    const contribution = value * weight;
    score += contribution;
    contributions.push({
      name,
      weight,
      rawValue: featureValues[name] ?? 0,
      contribution,
    });
  }

  for (const [name, weight] of Object.entries(weights.byPosition[positionName] ?? {})) {
    const value = featureValues[name] ?? 0;
    const contribution = value * weight;
    score += contribution;
    contributions.push({
      name,
      weight,
      rawValue: featureValues[name] ?? 0,
      contribution,
    });
  }

  const topReasons = contributions
    .filter((item) => item.contribution > 0)
    .sort((a, b) => b.contribution - a.contribution)
    .slice(0, 3)
    .map((item) => featureLabel(item.name, item.rawValue));

  return {
    id: playerId,
    player: mergedPlayer,
    position,
    positionName,
    teamId,
    teamName: teamsById.get(teamId)?.name ?? String(teamId),
    score,
    fixtures,
    topReasons,
    totalRecentMinutes,
    contributions,
  };
}

function rankPlayers({
  snapshotRows,
  playerMetaById,
  historyRowsByPlayer,
  weights,
  targetGw,
  fixturesByTeamAndGw,
  teamsById,
}) {
  const ranked = [];
  for (const player of snapshotRows) {
    const playerId = getPlayerId(player);
    const historyRows = historyRowsByPlayer.get(playerId) ?? [];
    const scored = scorePlayer({
      player,
      playerMetaById,
      historyRows,
      weights,
      targetGw,
      fixturesByTeamAndGw,
      teamsById,
    });
    if (scored) ranked.push(scored);
  }

  ranked.sort((a, b) => b.score - a.score);
  return ranked;
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

function positionPickCount(weights, positionName) {
  return toNumber(weights.picksPerPosition[positionName], 0);
}

function actualPoints(actualRowsById, playerId) {
  return toNumber(actualRowsById.get(playerId)?.event_points, 0);
}

function summarizeBacktest(gwSummaries) {
  const positionBuckets = new Map();
  let allPoints = [];
  let allHits = [];

  for (const gwSummary of gwSummaries) {
    allPoints = allPoints.concat(gwSummary.points);
    allHits = allHits.concat(gwSummary.hits);

    for (const [positionName, data] of Object.entries(gwSummary.byPosition)) {
      if (!positionBuckets.has(positionName)) {
        positionBuckets.set(positionName, { points: [], hits: [] });
      }
      positionBuckets.get(positionName).points.push(...data.points);
      positionBuckets.get(positionName).hits.push(...data.hits);
    }
  }

  return {
    overallAvgPoints: mean(allPoints),
    overallHitRate: mean(allHits),
    byPosition: Object.fromEntries(
      Array.from(positionBuckets.entries()).map(([positionName, data]) => [
        positionName,
        {
          avgPoints: mean(data.points),
          hitRate: mean(data.hits),
          picks: data.points.length,
        },
      ]),
    ),
  };
}

function renderBacktestSummary(summary, gwSummaries) {
  const lines = [];
  lines.push("Backtest summary");
  lines.push(`Gameweeks tested: ${gwSummaries[0]?.targetGw ?? "-"}-${gwSummaries.at(-1)?.targetGw ?? "-"}`);
  lines.push(`overall_avg_points: ${summary.overallAvgPoints.toFixed(2)}`);
  lines.push(`overall_hit_rate: ${(summary.overallHitRate * 100).toFixed(1)}%`);
  lines.push("");

  for (const positionName of ["GK", "DEF", "MID", "FWD"]) {
    const row = summary.byPosition[positionName];
    if (!row) continue;
    lines.push(
      `${positionName}: avg_points=${row.avgPoints.toFixed(2)} hit_rate=${(row.hitRate * 100).toFixed(1)}% picks=${row.picks}`,
    );
  }

  lines.push("");
  lines.push("Recent gameweeks");
  for (const gwSummary of gwSummaries.slice(-5)) {
    lines.push(
      `GW${gwSummary.targetGw}: avg_points=${mean(gwSummary.points).toFixed(2)} hit_rate=${(
        mean(gwSummary.hits) * 100
      ).toFixed(1)}%`,
    );
  }

  return lines.join("\n");
}

/**
 * Score a player across multiple future GWs.
 * Uses current form/stats but per-GW fixture difficulty.
 */
function scorePlayerSeason({
  player,
  playerMetaById,
  historyRows,
  weights,
  fromGw,
  toGw,
  fixturesByTeamAndGw,
  teamsById,
}) {
  let totalScore = 0;
  const gwScores = [];

  for (let gw = fromGw; gw <= toGw; gw += 1) {
    const result = scorePlayer({
      player,
      playerMetaById,
      historyRows,
      weights,
      targetGw: gw,
      fixturesByTeamAndGw,
      teamsById,
    });
    const gwScore = result ? result.score : 0;
    totalScore += gwScore;
    gwScores.push({ gw, score: gwScore });
  }

  return { totalScore, gwScores };
}

/**
 * Build a map of playerId → { seasonScore, perGw, scored } for all eligible players.
 */
function buildSeasonScores({
  players,
  playerMetaById,
  historyRowsByPlayer,
  weights,
  fromGw,
  toGw,
  fixturesByTeamAndGw,
  teamsById,
}) {
  const scores = new Map();

  for (const player of players) {
    const playerId = getPlayerId(player);
    const historyRows = historyRowsByPlayer.get(playerId) ?? [];

    // First check eligibility with the fromGw
    const eligible = scorePlayer({
      player,
      playerMetaById,
      historyRows,
      weights,
      targetGw: fromGw,
      fixturesByTeamAndGw,
      teamsById,
    });

    if (!eligible) continue;

    const season = scorePlayerSeason({
      player,
      playerMetaById,
      historyRows,
      weights,
      fromGw,
      toGw,
      fixturesByTeamAndGw,
      teamsById,
    });

    scores.set(playerId, {
      seasonScore: season.totalScore,
      gwScores: season.gwScores,
      scored: eligible,
    });
  }

  return scores;
}

/**
 * Greedy transfer planner.
 *
 * For each GW from nextGw to 38:
 *   - Use available free transfers to make the best upgrades
 *   - Optionally take hits if the gain over remaining GWs justifies it
 *   - Accumulate unused free transfers (max 5)
 */
function planTransfers({
  currentSquadIds,
  seasonScores,
  playerMetaById,
  weights,
  fromGw,
  toGw,
  fixturesByTeamAndGw,
  teamsById,
  bank,
}) {
  const hitCost = toNumber(weights.hitCost, 4);
  let freeTransfers = toNumber(weights.freeTransfers, 1);
  let currentBank = bank;
  const squadIds = new Set(currentSquadIds);
  const transfers = []; // { gw, out, in, hit, gainPerGw }

  for (let gw = fromGw; gw <= toGw; gw += 1) {
    const remainingGws = toGw - gw + 1;
    const candidates = [];

    // Find the best swap for each squad member
    for (const outId of squadIds) {
      const outData = seasonScores.get(outId);
      if (!outData) continue;

      const outPlayer = outData.scored;
      const outRemainingScore = outData.gwScores
        .filter((g) => g.gw >= gw)
        .reduce((s, g) => s + g.score, 0);
      const outCost = toNumber(outPlayer.player.now_cost, 0);

      // Find best replacement at same position within budget
      for (const [inId, inData] of seasonScores) {
        if (squadIds.has(inId)) continue;
        if (!inData.scored) continue;
        if (inData.scored.positionName !== outPlayer.positionName) continue;

        const inCost = toNumber(inData.scored.player.now_cost, 0);
        if (inCost > outCost + currentBank) continue;

        const inRemainingScore = inData.gwScores
          .filter((g) => g.gw >= gw)
          .reduce((s, g) => s + g.score, 0);

        const gain = inRemainingScore - outRemainingScore;
        if (gain <= 0) continue;

        candidates.push({
          gw,
          outId,
          inId,
          outPlayer,
          inPlayer: inData.scored,
          gain,
          gainPerGw: gain / remainingGws,
          costDelta: inCost - outCost,
        });
      }
    }

    // Sort by gain (best upgrades first)
    candidates.sort((a, b) => b.gain - a.gain);

    let transfersMade = 0;
    const usedOut = new Set();
    const usedIn = new Set();

    for (const candidate of candidates) {
      if (usedOut.has(candidate.outId) || usedIn.has(candidate.inId)) continue;

      const isHit = transfersMade >= freeTransfers;
      // Only take a hit if the gain justifies it (gain > hitCost equivalent in score)
      if (isHit && candidate.gain < hitCost * 1.5) continue;

      transfers.push({
        gw: candidate.gw,
        out: candidate.outPlayer,
        in: candidate.inPlayer,
        hit: isHit,
        gain: candidate.gain,
        gainPerGw: candidate.gainPerGw,
      });

      squadIds.delete(candidate.outId);
      squadIds.add(candidate.inId);
      currentBank -= candidate.costDelta;
      usedOut.add(candidate.outId);
      usedIn.add(candidate.inId);
      transfersMade += 1;

      // Max 3 transfers per GW (1 free + 2 hits max)
      if (transfersMade >= Math.min(freeTransfers + 2, 3)) break;
    }

    // Bank unused free transfers (max 5)
    const unusedFree = Math.max(0, freeTransfers - transfersMade);
    freeTransfers = Math.min(5, 1 + unusedFree);
  }

  return { transfers, finalSquadIds: [...squadIds], finalBank: currentBank };
}

function selectBudgetSquad(ranked, weights) {
  const budget = toNumber(weights.budget, 1000);
  const squadSize = weights.squadSize ?? { GK: 2, DEF: 5, MID: 5, FWD: 3 };

  const squad = [];
  const remaining = { ...squadSize };
  let spent = 0;

  for (const player of ranked) {
    const pos = player.positionName;
    if (!remaining[pos] || remaining[pos] <= 0) continue;

    const cost = toNumber(player.player.now_cost, 0);
    if (spent + cost > budget) continue;

    squad.push(player);
    remaining[pos] -= 1;
    spent += cost;

    const totalPicked = Object.values(squadSize).reduce((a, b) => a + b, 0);
    if (squad.length >= totalPicked) break;
  }

  return { squad, spent, budget };
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
    lines.push(`- Bank: ${formatMoney(bank)} | Free transfers: ${weights.freeTransfers}`);
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

    // Transfer plan
    if (transferPlan && transferPlan.transfers.length > 0) {
      const totalHits = transferPlan.transfers.filter((t) => t.hit).length;
      const totalHitCost = totalHits * toNumber(weights.hitCost, 4);
      lines.push(`## Transfer plan (${transferPlan.transfers.length} transfers, ${totalHits} hits = -${totalHitCost} pts)`);
      lines.push("");

      let lastGw = 0;
      for (const t of transferPlan.transfers) {
        if (t.gw !== lastGw) {
          lines.push(`### GW${t.gw}${t.hit ? "" : ""}`);
          lastGw = t.gw;
        }
        const outName = t.out.player.web_name ?? t.out.player.second_name;
        const inName = t.in.player.web_name ?? t.in.player.second_name;
        const hitTag = t.hit ? " [HIT]" : " [FREE]";
        lines.push(
          `- OUT: ${outName} (${formatMoney(t.out.player.now_cost)}) → IN: ${inName} (${formatMoney(t.in.player.now_cost)}) — gain +${t.gain.toFixed(1)} over remaining GWs${hitTag}`,
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

  const gwSummaries = [];
  const firstTestGw = Math.max(2, weights.historyWindow + 1);

  for (let targetGw = firstTestGw; targetGw <= currentGw; targetGw += 1) {
    const snapshotRows = rowsByGw.get(targetGw - 1) ?? [];
    const actualRows = rowsByGw.get(targetGw) ?? [];
    const actualRowsById = new Map(actualRows.map((row) => [getPlayerId(row), row]));
    const historyRowsByPlayer = buildHistoryWindow(rowsByGw, targetGw - 1, weights.historyWindow);
    const ranked = rankPlayers({
      snapshotRows,
      playerMetaById,
      historyRowsByPlayer,
      weights,
      targetGw,
      fixturesByTeamAndGw,
      teamsById,
    });

    const byPosition = {};
    const points = [];
    const hits = [];

    for (const positionName of ["GK", "DEF", "MID", "FWD"]) {
      const pickCount = positionPickCount(weights, positionName);
      const picks = ranked.filter((player) => player.positionName === positionName).slice(0, pickCount);
      const pickPoints = picks.map((player) => actualPoints(actualRowsById, player.id));
      const pickHits = pickPoints.map((value) => (value >= 6 ? 1 : 0));
      byPosition[positionName] = { points: pickPoints, hits: pickHits };
      points.push(...pickPoints);
      hits.push(...pickHits);
    }

    gwSummaries.push({ targetGw, byPosition, points, hits });
  }

  const summary = summarizeBacktest(gwSummaries);
  console.log(renderBacktestSummary(summary, gwSummaries));
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

  await writeFile(REPORT_URL, report, "utf8");
  console.log(report);
  console.log(`Saved report to ${REPORT_URL.pathname}`);
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
