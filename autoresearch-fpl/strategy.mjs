/**
 * FPL Player Strategy — the agent-editable file.
 *
 * This file contains all player scoring, feature engineering,
 * transfer planning, and squad selection logic.
 *
 * The autoresearch LLM agent modifies THIS file to improve
 * the backtest metric (avg_points_per_gw). The evaluation
 * harness (run.mjs) is fixed and should not be edited.
 *
 * After each change, run:
 *   node autoresearch-fpl/run.mjs backtest
 * to measure the effect.
 */

import {
  toNumber,
  clamp,
  mean,
  sum,
  getPlayerId,
  getTeamId,
  getPosition,
  groupRowsByPlayer,
  POSITION_NAMES,
  AVAILABILITY_BY_STATUS,
} from "./run.mjs";

// ── Feature engineering helpers ─────────────────────────────────────────────

export function availabilityScore(player) {
  const chance = player.chance_of_playing_next_round;
  if (chance !== null && chance !== undefined && chance !== "") {
    return clamp(toNumber(chance) / 100, 0, 1);
  }
  return AVAILABILITY_BY_STATUS[player.status] ?? 1;
}

export function mergePlayerData(playerMeta, snapshotPlayer) {
  const merged = { ...playerMeta };
  for (const [key, value] of Object.entries(snapshotPlayer)) {
    if (value === "" || value === null || value === undefined) continue;
    merged[key] = value;
  }
  return merged;
}

export function averagePer90(rows, key) {
  const per90Values = rows
    .map((row) => {
      const minutes = toNumber(row.minutes, 0);
      if (minutes <= 0) return null;
      return (toNumber(row[key], 0) / minutes) * 90;
    })
    .filter((value) => value !== null);
  return mean(per90Values);
}

export function countRecentCleanSheets(rows) {
  const matches = rows.filter((row) => toNumber(row.minutes, 0) > 0);
  if (!matches.length) return 0;
  const cleanSheets = matches.filter((row) => toNumber(row.clean_sheets, 0) > 0).length;
  return cleanSheets / matches.length;
}

export function recentMinutesRatio(rows) {
  const minutes = rows.map((row) => clamp(toNumber(row.minutes, 0) / 90, 0, 1));
  return mean(minutes);
}

export function recentTotalMinutes(rows) {
  return sum(rows.map((row) => toNumber(row.minutes, 0)));
}

export function normalizeFeature(value, divisor) {
  return clamp(value / divisor, 0, 2);
}

export function featureLabel(name, rawValue) {
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

// ── Player scoring ──────────────────────────────────────────────────────────

export function scorePlayer({
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

export function rankPlayers({
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

// ── Multi-GW scoring ────────────────────────────────────────────────────────

export function scorePlayerSeason({
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

export function buildSeasonScores({
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
    const playerMeta = playerMetaById.get(playerId) ?? {};
    const mergedPlayer = mergePlayerData(playerMeta, player);
    const positionName = POSITION_NAMES[getPosition(mergedPlayer)] ?? null;
    const teamId = getTeamId(mergedPlayer);
    const fixtures = fixturesByTeamAndGw.get(fromGw)?.get(teamId) ?? [];

    const eligible = scorePlayer({
      player,
      playerMetaById,
      historyRows,
      weights,
      targetGw: fromGw,
      fixturesByTeamAndGw,
      teamsById,
    });

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
      scored: eligible ?? (
        playerId && positionName
          ? {
              id: playerId,
              player: mergedPlayer,
              position: getPosition(mergedPlayer),
              positionName,
              teamId,
              teamName: teamsById.get(teamId)?.name ?? String(teamId),
              score: 0,
              fixtures,
              topReasons: [],
              totalRecentMinutes: recentTotalMinutes(historyRows),
              contributions: [],
            }
          : null
      ),
    });
  }

  return scores;
}

// ── Squad selection ─────────────────────────────────────────────────────────

export function positionPickCount(weights, positionName) {
  return toNumber(weights.picksPerPosition[positionName], 0);
}

export function buildStartingSquad({
  snapshotRows,
  playerMetaById,
  historyRowsByPlayer,
  weights,
  targetGw,
  fixturesByTeamAndGw,
  teamsById,
}) {
  const ranked = rankPlayers({
    snapshotRows,
    playerMetaById,
    historyRowsByPlayer,
    weights,
    targetGw,
    fixturesByTeamAndGw,
    teamsById,
  });

  const rankedIds = new Set(ranked.map((player) => player.id));
  const fallbackPlayers = snapshotRows
    .map((player) => {
      const playerId = getPlayerId(player);
      if (!playerId || rankedIds.has(playerId)) return null;

      const playerMeta = playerMetaById.get(playerId) ?? {};
      const mergedPlayer = mergePlayerData(playerMeta, player);
      const position = getPosition(mergedPlayer);
      const positionName = POSITION_NAMES[position];
      if (!positionName) return null;

      const teamId = getTeamId(mergedPlayer);
      return {
        id: playerId,
        player: mergedPlayer,
        position,
        positionName,
        teamId,
        teamName: teamsById.get(teamId)?.name ?? String(teamId),
        score: -1,
        fixtures: fixturesByTeamAndGw.get(targetGw)?.get(teamId) ?? [],
        topReasons: [],
        totalRecentMinutes: 0,
        contributions: [],
      };
    })
    .filter(Boolean);

  const { squad } = selectBudgetSquad([...ranked, ...fallbackPlayers], weights);
  return squad.map((p) => p.id);
}

export function selectBudgetSquad(ranked, weights) {
  const budget = toNumber(weights.budget, 1000);
  const squadSize = weights.squadSize ?? { GK: 2, DEF: 5, MID: 5, FWD: 3 };

  const squad = [];
  const remaining = { ...squadSize };
  const selectedIds = new Set();
  let spent = 0;

  for (const player of ranked) {
    const pos = player.positionName;
    if (!remaining[pos] || remaining[pos] <= 0) continue;

    const cost = toNumber(player.player.now_cost, 0);
    if (spent + cost > budget) continue;

    squad.push(player);
    selectedIds.add(player.id);
    remaining[pos] -= 1;
    spent += cost;

    const totalPicked = Object.values(squadSize).reduce((a, b) => a + b, 0);
    if (squad.length >= totalPicked) break;
  }

  if (Object.values(remaining).some((count) => count > 0)) {
    const cheapestByPosition = new Map();

    for (const player of ranked) {
      if (selectedIds.has(player.id)) continue;
      const pos = player.positionName;
      if (!remaining[pos] || remaining[pos] <= 0) continue;
      if (!cheapestByPosition.has(pos)) cheapestByPosition.set(pos, []);
      cheapestByPosition.get(pos).push(player);
    }

    for (const playersForPosition of cheapestByPosition.values()) {
      playersForPosition.sort(
        (a, b) => toNumber(a.player.now_cost, 0) - toNumber(b.player.now_cost, 0) || b.score - a.score,
      );
    }

    for (const positionName of Object.keys(remaining)) {
      while ((remaining[positionName] ?? 0) > 0) {
        const candidates = cheapestByPosition.get(positionName) ?? [];
        const nextPlayer = candidates.shift();
        if (!nextPlayer) break;

        squad.push(nextPlayer);
        selectedIds.add(nextPlayer.id);
        remaining[positionName] -= 1;
        spent += toNumber(nextPlayer.player.now_cost, 0);
      }
    }
  }

  return { squad, spent, budget };
}

const STARTING_MINIMUMS = { GK: 1, DEF: 3, MID: 2, FWD: 1 };
const STARTING_MAXIMUMS = { GK: 1, DEF: 5, MID: 5, FWD: 3 };

function playerScore(player, scoreKey) {
  return toNumber(player?.[scoreKey], 0);
}

function squadPlayersForGw(squadIds, seasonScores, gw) {
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

export function projectedLineupForGw(squadIds, seasonScores, gw) {
  const squad = squadPlayersForGw(squadIds, seasonScores, gw);
  return selectStartingEleven(squad, "score");
}

export function projectedLineupScore(squadIds, seasonScores, gw, { benchBoost = false } = {}) {
  const lineup = projectedLineupForGw(squadIds, seasonScores, gw);
  const startingTotal = sum(lineup.starting.map((player) => playerScore(player, "score")));
  const benchTotal = sum(lineup.bench.map((player) => playerScore(player, "score")));
  const captainBonus = playerScore(lineup.captain, "score");

  return {
    ...lineup,
    startingTotal,
    benchTotal,
    captainBonus,
    total: startingTotal + captainBonus + (benchBoost ? benchTotal : 0),
  };
}

export function selectStartingEleven(squad, scoreKey = "score") {
  const byPosition = { GK: [], DEF: [], MID: [], FWD: [] };
  for (const player of squad) {
    const pos = player.positionName;
    if (byPosition[pos]) byPosition[pos].push(player);
  }

  for (const pos of Object.keys(byPosition)) {
    byPosition[pos].sort((a, b) => playerScore(b, scoreKey) - playerScore(a, scoreKey));
  }

  const starting = [];
  const startingSet = new Set();
  const counts = { GK: 0, DEF: 0, MID: 0, FWD: 0 };

  const addStarter = (player) => {
    if (!player || startingSet.has(player) || starting.length >= 11) return;
    starting.push(player);
    startingSet.add(player);
    counts[player.positionName] = (counts[player.positionName] ?? 0) + 1;
  };

  for (const [positionName, minimum] of Object.entries(STARTING_MINIMUMS)) {
    for (let i = 0; i < minimum && byPosition[positionName].length > 0; i += 1) {
      addStarter(byPosition[positionName].shift());
    }
  }

  const remaining = [...byPosition.DEF, ...byPosition.MID, ...byPosition.FWD]
    .sort((a, b) => playerScore(b, scoreKey) - playerScore(a, scoreKey));

  for (const player of remaining) {
    if (starting.length >= 11) break;
    const pos = player.positionName;
    if ((counts[pos] ?? 0) >= (STARTING_MAXIMUMS[pos] ?? 0)) continue;
    addStarter(player);
  }

  const benchGoalkeepers = byPosition.GK.filter((player) => !startingSet.has(player));
  const benchOutfield = squad
    .filter((player) => !startingSet.has(player) && player.positionName !== "GK")
    .sort((a, b) => playerScore(b, scoreKey) - playerScore(a, scoreKey));
  const bench = [...benchGoalkeepers.slice(0, 1), ...benchOutfield.slice(0, 3)];

  const sortedStarting = [...starting].sort((a, b) => playerScore(b, scoreKey) - playerScore(a, scoreKey));
  const captain = sortedStarting[0] || null;
  const viceCaptain = sortedStarting[1] || null;

  return { starting: starting.slice(0, 11), bench, captain, viceCaptain };
}

export function buildOptimalSquadForGw({
  seasonScores,
  weights,
  gw,
  budget,
}) {
  const byGwScore = [...seasonScores.entries()]
    .filter(([, data]) => data.scored)
    .map(([id, data]) => {
      const gwEntry = data.gwScores.find((g) => g.gw === gw);
      return { id, score: gwEntry ? gwEntry.score : 0, data };
    })
    .sort((a, b) => b.score - a.score);

  const squadSize = weights.squadSize ?? { GK: 2, DEF: 5, MID: 5, FWD: 3 };
  const remaining = { ...squadSize };
  const squad = [];
  let spent = 0;

  for (const { id, data } of byGwScore) {
    const pos = data.scored.positionName;
    if (!remaining[pos] || remaining[pos] <= 0) continue;

    const cost = toNumber(data.scored.player.now_cost, 0);
    if (spent + cost > budget) continue;

    squad.push(id);
    remaining[pos] -= 1;
    spent += cost;

    const totalSlots = Object.values(squadSize).reduce((a, b) => a + b, 0);
    if (squad.length >= totalSlots) break;
  }

  return squad;
}

// ── Transfer planning ───────────────────────────────────────────────────────

export function planTransfersForGw({ squadIds, seasonScores, weights, gw, endGw, freeTransfers, bank }) {
  const currentSquad = new Set(squadIds);
  let currentBank = bank;
  const candidates = [];

  for (const outId of currentSquad) {
    const outData = seasonScores.get(outId);
    if (!outData) continue;

    const outPlayer = outData.scored;
    const outRemaining = outData.gwScores
      .filter((g) => g.gw >= gw)
      .reduce((s, g) => s + g.score, 0);
    const outCost = toNumber(outPlayer.player.now_cost, 0);

    for (const [inId, inData] of seasonScores) {
      if (currentSquad.has(inId)) continue;
      if (!inData.scored) continue;
      if (inData.scored.positionName !== outPlayer.positionName) continue;

      const inCost = toNumber(inData.scored.player.now_cost, 0);
      if (inCost > outCost + currentBank) continue;

      const inRemaining = inData.gwScores
        .filter((g) => g.gw >= gw)
        .reduce((s, g) => s + g.score, 0);

      const gain = inRemaining - outRemaining;
      if (gain <= 0) continue;

      candidates.push({ outId, inId, gain, costDelta: inCost - outCost, outPlayer, inPlayer: inData.scored });
    }
  }

  candidates.sort((a, b) => b.gain - a.gain);

  let transfersMade = 0;
  let hitsTaken = 0;
  const usedOut = new Set();
  const usedIn = new Set();

  for (const c of candidates) {
    if (transfersMade >= freeTransfers) break;
    if (usedOut.has(c.outId) || usedIn.has(c.inId)) continue;

    currentSquad.delete(c.outId);
    currentSquad.add(c.inId);
    currentBank -= c.costDelta;
    usedOut.add(c.outId);
    usedIn.add(c.inId);
    transfersMade += 1;
  }

  return {
    newSquadIds: [...currentSquad],
    newBank: currentBank,
    transfersMade,
    hitsTaken,
  };
}

export function evaluateChips({
  currentSquadIds,
  seasonScores,
  weights,
  fromGw,
  toGw,
  bank,
}) {
  const squadSize = weights.squadSize ?? { GK: 2, DEF: 5, MID: 5, FWD: 3 };
  const totalBudget = bank + sum(
    currentSquadIds.map((id) => toNumber(seasonScores.get(id)?.scored?.player?.now_cost, 0)),
  );

  const results = { wildcard: [], freeHit: [], benchBoost: [] };

  const currentGwTotals = new Map();
  for (let gw = fromGw; gw <= toGw; gw += 1) {
    currentGwTotals.set(gw, projectedLineupScore(currentSquadIds, seasonScores, gw).total);
  }

  for (let gw = fromGw; gw <= toGw; gw += 1) {
    const currentGwTotal = currentGwTotals.get(gw) ?? 0;

    // Free Hit
    const fhSquad = buildOptimalSquadForGw({ seasonScores, weights, gw, budget: totalBudget });
    const fhTotal = projectedLineupScore(fhSquad, seasonScores, gw).total;
    results.freeHit.push({ gw, gain: fhTotal - currentGwTotal });

    // Wildcard
    const wcCandidates = [...seasonScores.entries()]
      .filter(([, data]) => data.scored)
      .map(([id, data]) => {
        const remaining = data.gwScores
          .filter((g) => g.gw >= gw)
          .reduce((s, g) => s + g.score, 0);
        return { id, remainingScore: remaining, data };
      })
      .sort((a, b) => b.remainingScore - a.remainingScore);

    const wcRemaining = { ...squadSize };
    const wcSquad = [];
    let wcSpent = 0;
    for (const { id, data } of wcCandidates) {
      const pos = data.scored.positionName;
      if (!wcRemaining[pos] || wcRemaining[pos] <= 0) continue;
      const cost = toNumber(data.scored.player.now_cost, 0);
      if (wcSpent + cost > totalBudget) continue;
      wcSquad.push(id);
      wcRemaining[pos] -= 1;
      wcSpent += cost;
      const totalSlots = Object.values(squadSize).reduce((a, b) => a + b, 0);
      if (wcSquad.length >= totalSlots) break;
    }

    let wcSeasonTotal = 0;
    let currentSeasonTotal = 0;
    for (let futureGw = gw; futureGw <= toGw; futureGw += 1) {
      wcSeasonTotal += projectedLineupScore(wcSquad, seasonScores, futureGw).total;
      currentSeasonTotal += projectedLineupScore(currentSquadIds, seasonScores, futureGw).total;
    }
    results.wildcard.push({ gw, gain: wcSeasonTotal - currentSeasonTotal, wcSquad });

    // Bench Boost
    const benchTotal = projectedLineupScore(currentSquadIds, seasonScores, gw, { benchBoost: true }).benchTotal;
    results.benchBoost.push({ gw, gain: benchTotal });
  }

  return results;
}

export function planTransfers({
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
  const chips = weights.chips ?? {};
  let freeTransfers = toNumber(weights.freeTransfers, 1);
  let currentBank = bank;
  const squadIds = new Set(currentSquadIds);
  const transfers = [];
  const chipPlan = [];

  let chipEval = null;
  if (chips.wildcard || chips.freeHit || chips.benchBoost) {
    chipEval = evaluateChips({
      currentSquadIds: [...squadIds],
      seasonScores,
      weights,
      fromGw,
      toGw,
      bank: currentBank,
    });
  }

  const chipSchedule = new Map();

  if (chipEval) {
    const available = [];

    if (chips.wildcard && chipEval.wildcard.length > 0) {
      const best = chipEval.wildcard.reduce((a, b) => (b.gain > a.gain ? b : a));
      if (best.gain > 0) available.push({ chip: "wildcard", gw: best.gw, gain: best.gain, wcSquad: best.wcSquad });
    }
    if (chips.freeHit && chipEval.freeHit.length > 0) {
      const best = chipEval.freeHit.reduce((a, b) => (b.gain > a.gain ? b : a));
      if (best.gain > 0) available.push({ chip: "freeHit", gw: best.gw, gain: best.gain });
    }
    if (chips.benchBoost && chipEval.benchBoost.length > 0) {
      const best = chipEval.benchBoost.reduce((a, b) => (b.gain > a.gain ? b : a));
      if (best.gain > 0) available.push({ chip: "benchBoost", gw: best.gw, gain: best.gain });
    }

    available.sort((a, b) => b.gain - a.gain);
    const usedGws = new Set();
    for (const entry of available) {
      if (usedGws.has(entry.gw)) {
        const chipList = chipEval[entry.chip]
          .filter((e) => !usedGws.has(e.gw) && e.gain > 0)
          .sort((a, b) => b.gain - a.gain);
        if (chipList.length > 0) {
          entry.gw = chipList[0].gw;
          entry.gain = chipList[0].gain;
          if (chipList[0].wcSquad) entry.wcSquad = chipList[0].wcSquad;
        } else {
          continue;
        }
      }
      chipSchedule.set(entry.gw, entry);
      usedGws.add(entry.gw);
    }
  }

  for (let gw = fromGw; gw <= toGw; gw += 1) {
    const chipForGw = chipSchedule.get(gw);
    const remainingGws = toGw - gw + 1;

    if (chipForGw?.chip === "wildcard" && chipForGw.wcSquad) {
      const oldSquad = [...squadIds];
      const newSquad = chipForGw.wcSquad;

      const outIds = oldSquad.filter((id) => !newSquad.includes(id));
      const inIds = newSquad.filter((id) => !oldSquad.includes(id));

      for (let i = 0; i < Math.max(outIds.length, inIds.length); i += 1) {
        const outId = outIds[i];
        const inId = inIds[i];
        if (!outId || !inId) continue;
        transfers.push({
          gw,
          out: seasonScores.get(outId)?.scored ?? { player: playerMetaById.get(outId) ?? {} },
          in: seasonScores.get(inId)?.scored ?? { player: playerMetaById.get(inId) ?? {} },
          hit: false,
          gain: 0,
          gainPerGw: 0,
          chip: "wildcard",
        });
      }

      squadIds.clear();
      for (const id of newSquad) squadIds.add(id);
      currentBank = toNumber(weights.budget, 1000) - sum(newSquad.map((id) => toNumber(seasonScores.get(id)?.scored?.player?.now_cost ?? playerMetaById.get(id)?.now_cost, 0)));
      chipPlan.push({ gw, chip: "WILDCARD", gain: chipForGw.gain });
      freeTransfers = 1;
      continue;
    }

    if (chipForGw?.chip === "freeHit") {
      chipPlan.push({ gw, chip: "FREE HIT", gain: chipForGw.gain });
      freeTransfers = Math.min(5, freeTransfers + 1);
      continue;
    }

    if (chipForGw?.chip === "benchBoost") {
      chipPlan.push({ gw, chip: "BENCH BOOST", gain: chipForGw.gain });
    }

    const candidates = [];

    for (const outId of squadIds) {
      const outData = seasonScores.get(outId);
      if (!outData) continue;

      const outPlayer = outData.scored;
      const outRemainingScore = outData.gwScores
        .filter((g) => g.gw >= gw)
        .reduce((s, g) => s + g.score, 0);
      const outCost = toNumber(outPlayer.player.now_cost, 0);

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

    candidates.sort((a, b) => b.gain - a.gain);

    let transfersMade = 0;
    const usedOut = new Set();
    const usedIn = new Set();

    for (const candidate of candidates) {
      if (usedOut.has(candidate.outId) || usedIn.has(candidate.inId)) continue;

      const isHit = transfersMade >= freeTransfers;
      const gainPerGw = candidate.gain / remainingGws;
      if (isHit && gainPerGw < 1.5) continue;

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

      if (transfersMade >= Math.min(freeTransfers + 2, 3)) break;
    }

    const unusedFree = Math.max(0, freeTransfers - transfersMade);
    freeTransfers = Math.min(5, 1 + unusedFree);
  }

  const squadStateById = new Map();
  const squadPerGw = [];

  for (const id of currentSquadIds) {
    squadStateById.set(id, true);
  }

  for (let gw = fromGw; gw <= toGw; gw++) {
    const transfersForGw = transfers.filter(t => t.gw === gw);
    for (const t of transfersForGw) {
      if (t.out) squadStateById.delete(getPlayerId(t.out.player));
      if (t.in) squadStateById.set(getPlayerId(t.in.player), true);
    }
    const gwSquadIds = [...squadStateById.keys()];
    squadPerGw.push({ gw, squadIds: gwSquadIds });
  }

  return { transfers, finalSquadIds: [...squadStateById.keys()], finalBank: currentBank, chipPlan, squadPerGw };
}
