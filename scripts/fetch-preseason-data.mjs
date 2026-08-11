#!/usr/bin/env node

/**
 * Fetch and sanitize API-Football player data for the current FPL teams.
 *
 * The API key is read from API_FOOTBALL_KEY for controlled CI. The normal
 * project command invokes the fixed root-installed broker, which reads the
 * project secret in-process. API responses are cached outside public data.
 */

import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.FPL_PRESEASON_PROJECT_ROOT || dirname(dirname(fileURLToPath(import.meta.url)));
const API_BASE = 'https://v3.football.api-sports.io';
const FPL_BOOTSTRAP_URL = 'https://fantasy.premierleague.com/api/bootstrap-static/';
const LEAGUE_ID = 39;
const SEASON = 2026;
const SEASON_LABEL = '2026-27';
const FROM = '2026-07-01';
const TO = '2026-08-16';
const CACHE_DIR = process.env.PRESEASON_CACHE_DIR || join(ROOT, '.cache', 'preseason-api');
const OUTPUT_PATH = process.env.PRESEASON_OUTPUT || join(ROOT, 'data', 'preseason', `${SEASON_LABEL}.json`);
const OVERRIDES_PATH = process.env.PRESEASON_OVERRIDES || join(ROOT, 'data', 'preseason', 'player-overrides.json');
const DEFAULT_MAX_REQUESTS = 90;
const DEFAULT_DELAY_MS = 300;
const COMPLETED_STATUSES = new Set(['FT', 'AET', 'PEN']);

function parseArgs(argv) {
  const args = { refresh: false, delayMs: DEFAULT_DELAY_MS, maxRequests: DEFAULT_MAX_REQUESTS };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--refresh') args.refresh = true;
    else if (arg === '--delay-ms') args.delayMs = Math.max(0, Number(argv[++i]));
    else if (arg === '--max-requests') args.maxRequests = Math.max(1, Number(argv[++i]));
    else if (arg === '--help') {
      console.log('Usage: node scripts/fetch-preseason-data.mjs [--refresh] [--delay-ms N] [--max-requests N]');
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!Number.isFinite(args.delayMs) || !Number.isFinite(args.maxRequests)) {
    throw new Error('--delay-ms and --max-requests must be numbers');
  }
  return args;
}

function normalise(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\b(fc|afc|cf|sc)\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function playerNameKeys(player) {
  const first = player.first_name || player.firstname || '';
  const second = player.second_name || player.lastname || '';
  const full = player.name || `${first} ${second}`;
  return [...new Set([normalise(full), normalise(player.web_name), normalise(`${first} ${second}`)].filter(Boolean))];
}

function readInstalledBrokerKey() {
  if (process.env.FPL_PRESEASON_BROKER !== '1') return '';
  const secretPath = '/etc/agent-secrets/projects/fpl/api-football.secret';
  try {
    const stat = lstatSync(secretPath);
    if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o077) !== 0) return '';
    return readFileSync(secretPath, 'utf8').replace(/[\r\n]/g, '').trim();
  } catch {
    return '';
  }
}

function getApiKey() {
  const fromEnv = process.env.API_FOOTBALL_KEY?.trim();
  if (fromEnv) return fromEnv;
  const fromInstalledBroker = readInstalledBrokerKey();
  if (fromInstalledBroker) return fromInstalledBroker;
  throw new Error('API-Football key unavailable. Use the installed preseason broker or set API_FOOTBALL_KEY for controlled CI.');
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

async function writeJsonAtomic(path, value, mode = 0o600) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode });
  await rename(temporary, path);
}

function cachePath(endpoint, params) {
  const query = new URLSearchParams(params).toString();
  const digest = createHash('sha256').update(`${endpoint}?${query}`).digest('hex');
  return join(CACHE_DIR, `${digest}.json`);
}

async function fetchFplBootstrap() {
  const response = await fetch(FPL_BOOTSTRAP_URL);
  if (!response.ok) throw new Error(`FPL bootstrap request failed (HTTP ${response.status})`);
  return response.json();
}

function makeApiClient(key, options) {
  let requests = 0;
  let lastRequestAt = 0;

  return {
    get count() { return requests; },
    async get(endpoint, params) {
      const path = cachePath(endpoint, params);
      if (!options.refresh) {
        const cached = await readJson(path);
        if (cached?.response && cached?.cached_at) return cached.response;
      }

      if (requests >= options.maxRequests) {
        throw new Error(`API-Football request budget reached (${options.maxRequests}); rerun with cached results or raise --max-requests deliberately.`);
      }
      const wait = options.delayMs - (Date.now() - lastRequestAt);
      if (wait > 0) await sleep(wait);

      const url = new URL(`${API_BASE}${endpoint}`);
      Object.entries(params).forEach(([name, value]) => url.searchParams.set(name, String(value)));
      const response = await fetch(url, { headers: { 'x-apisports-key': key } });
      requests += 1;
      lastRequestAt = Date.now();
      if (!response.ok) throw new Error(`API-Football request failed (HTTP ${response.status}) for ${endpoint}`);
      const body = await response.json();
      if (body.errors && Object.keys(body.errors).length > 0) {
        throw new Error(`API-Football returned an error for ${endpoint}`);
      }
      await writeJsonAtomic(path, { cached_at: new Date().toISOString(), response: body });
      return body;
    },
  };
}

function buildFplTeams(bootstrap) {
  return (bootstrap.teams || []).map(team => ({
    id: Number(team.id),
    name: team.name || team.short_name || String(team.id),
    shortName: team.short_name || team.name || String(team.id),
  }));
}

function buildFplPlayers(bootstrap) {
  return (bootstrap.elements || []).map(player => ({
    id: Number(player.id),
    teamId: Number(player.team),
    name: `${player.first_name || ''} ${player.second_name || ''}`.trim() || player.web_name || String(player.id),
    webName: player.web_name || '',
    firstName: player.first_name || '',
    secondName: player.second_name || '',
  }));
}

function loadOverrides(overrides) {
  return {
    teamOverrides: overrides?.team_overrides || {},
    playerOverrides: overrides?.player_overrides || {},
  };
}

function findTeamMapping(fplTeams, apiTeams, overrides) {
  const apiByName = new Map(apiTeams.map(team => [normalise(team.name), team]));
  const mappings = [];
  for (const fplTeam of fplTeams) {
    const reverseOverride = Object.entries(overrides.teamOverrides).find(([, value]) => normalise(value) === normalise(fplTeam.name))?.[0];
    const requestedName = overrides.teamOverrides[fplTeam.name] || overrides.teamOverrides[fplTeam.shortName] || reverseOverride || fplTeam.name;
    const apiTeam = apiByName.get(normalise(requestedName));
    if (apiTeam) mappings.push({ fplTeam, apiTeam });
  }
  return mappings;
}

function makePlayerIndex(fplPlayers, fplTeams) {
  const teamNames = new Map(fplTeams.map(team => [team.id, team.name]));
  const index = new Map();
  for (const player of fplPlayers) {
    for (const name of playerNameKeys(player)) {
      const key = `${name}::${normalise(teamNames.get(player.teamId))}`;
      const existing = index.get(key);
      if (existing && existing.id !== player.id) index.set(key, null);
      else index.set(key, player);
    }
  }
  return { index, teamNames };
}

function overrideValue(overrides, sourcePlayer) {
  return overrides.playerOverrides[`api-football-player:${sourcePlayer.id}`]
    ?? overrides.playerOverrides[normalise(sourcePlayer.name)]
    ?? overrides.playerOverrides[`${normalise(sourcePlayer.name)}::${normalise(sourcePlayer.teamName)}`];
}

function mapSourcePlayer(sourcePlayer, sourceTeam, fplIndex, overrides) {
  const explicit = overrideValue(overrides, sourcePlayer);
  if (explicit != null) return fplIndex.byId.get(Number(explicit)) || null;
  const key = `${normalise(sourcePlayer.name)}::${normalise(sourceTeam.fplTeam.name)}`;
  return fplIndex.index.get(key) || null;
}

function asNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function completedFixture(fixture) {
  return COMPLETED_STATUSES.has(fixture.status?.short) || fixture.status?.type === 'finished';
}

function fixtureRecord({ fixture, sourcePlayer, sourceTeam, statistics, fplPlayer, fetchedAt }) {
  const isHome = Number(fixture.teams?.home?.id) === Number(sourceTeam.apiTeam.id);
  const opponent = isHome ? fixture.teams?.away : fixture.teams?.home;
  const games = statistics.games || {};
  const goals = statistics.goals || {};
  return {
    fpl_player_id: fplPlayer.id,
    source_player_id: Number(sourcePlayer.id),
    source_team_id: Number(sourceTeam.apiTeam.id),
    source_fixture_id: Number(fixture.fixture?.id),
    name: sourcePlayer.name,
    date: fixture.fixture?.date || null,
    competition: fixture.league?.name || 'Premier League',
    opponent: opponent?.name || null,
    home_away: isHome ? 'home' : 'away',
    completed: true,
    started: Boolean(games.lineups) || games.position != null,
    minutes: asNumber(games.minutes),
    goals: asNumber(goals.total),
    assists: asNumber(goals.assists),
    source_updated_at: fixture.fixture?.updated || fixture.fixture?.date || fetchedAt,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const key = getApiKey();
  const overrides = loadOverrides(await readJson(OVERRIDES_PATH));
  const bootstrap = await fetchFplBootstrap();
  const fplTeams = buildFplTeams(bootstrap);
  const fplPlayers = buildFplPlayers(bootstrap);
  const fplIndex = makePlayerIndex(fplPlayers, fplTeams);
  fplIndex.byId = new Map(fplPlayers.map(player => [player.id, player]));
  const api = makeApiClient(key, options);
  const fetchedAt = new Date().toISOString();

  const teamsResponse = await api.get('/teams', { league: LEAGUE_ID, season: SEASON });
  const apiTeams = (teamsResponse.response || []).map(item => item.team || item).filter(team => team?.id && team?.name);
  const teamMappings = findTeamMapping(fplTeams, apiTeams, overrides);
  if (teamMappings.length === 0) throw new Error('No current FPL teams matched API-Football teams; review data/preseason/player-overrides.json.');

  const fixturesById = new Map();
  for (const sourceTeam of teamMappings) {
    const fixturesResponse = await api.get('/fixtures', {
      team: sourceTeam.apiTeam.id,
      from: FROM,
      to: TO,
      league: LEAGUE_ID,
      season: SEASON,
    });
    for (const item of fixturesResponse.response || []) {
      const fixture = item.fixture ? item : { fixture: item };
      if (fixture.fixture?.id && completedFixture(fixture)) fixturesById.set(Number(fixture.fixture.id), fixture);
    }
  }

  const records = [];
  const unmapped = [];
  const seenUnmapped = new Set();
  for (const fixture of fixturesById.values()) {
    const sourceTeams = teamMappings.filter(mapping =>
      Number(mapping.apiTeam.id) === Number(fixture.teams?.home?.id) || Number(mapping.apiTeam.id) === Number(fixture.teams?.away?.id));
    if (sourceTeams.length === 0) continue;
    const fixtureResponse = await api.get('/fixtures/players', { fixture: fixture.fixture.id });
    for (const teamBlock of fixtureResponse.response || []) {
      const sourceTeamId = Number(teamBlock.team?.id || teamBlock.team);
      const sourceTeam = sourceTeams.find(mapping => Number(mapping.apiTeam.id) === sourceTeamId);
      if (!sourceTeam) continue;
      for (const playerBlock of teamBlock.players || []) {
        const sourcePlayer = playerBlock.player || {};
        if (!sourcePlayer.id || !sourcePlayer.name) continue;
        sourcePlayer.teamName = sourceTeam.apiTeam.name;
        const fplPlayer = mapSourcePlayer(sourcePlayer, sourceTeam, fplIndex, overrides);
        if (!fplPlayer) {
          const key = `${sourcePlayer.id}:${sourceTeam.apiTeam.id}`;
          if (!seenUnmapped.has(key)) {
            seenUnmapped.add(key);
            unmapped.push({ source_player_id: Number(sourcePlayer.id), name: sourcePlayer.name, source_team_id: sourceTeam.apiTeam.id, source_team: sourceTeam.apiTeam.name });
          }
          continue;
        }
        const statistics = playerBlock.statistics?.[0] || {};
        records.push(fixtureRecord({ fixture, sourcePlayer, sourceTeam, statistics, fplPlayer, fetchedAt }));
      }
    }
  }

  const sourceUpdatedAt = records.map(record => record.source_updated_at).filter(Boolean).sort().at(-1) || fetchedAt;
  const uniquePlayers = new Set(records.map(record => record.fpl_player_id));
  const publicData = {
    schema_version: 1,
    season: SEASON_LABEL,
    source: 'API-Football',
    attribution: 'Data provided by API-Football (api-sports.io).',
    source_url: API_BASE,
    generated_at: fetchedAt,
    source_updated_at: sourceUpdatedAt,
    date_range: { from: FROM, to: TO },
    coverage: {
      current_fpl_teams: fplTeams.length,
      matched_fpl_teams: teamMappings.length,
      completed_fixtures: fixturesById.size,
      source_player_records: records.length + unmapped.length,
      mapped_player_records: records.length,
      mapped_players: uniquePlayers.size,
      unmapped_players: unmapped.length,
      mapping_complete: unmapped.length === 0 && teamMappings.length === fplTeams.length,
      api_requests_this_run: api.count,
    },
    unmapped_players: unmapped,
    records,
  };

  await writeJsonAtomic(OUTPUT_PATH, publicData, 0o644);
  console.log(`Wrote sanitized preseason data to ${OUTPUT_PATH}`);
  console.log(`Coverage: ${teamMappings.length}/${fplTeams.length} teams, ${fixturesById.size} completed fixtures, ${uniquePlayers.size} mapped players, ${unmapped.length} unmapped players.`);
}

main().catch(error => {
  console.error(`Preseason import failed: ${error.message}`);
  process.exitCode = 1;
});
