#!/usr/bin/env node
/**
 * Generate per-gameweek scorers + match-position CSV
 *
 * - Uses API-Football (api-sports.io)
 * - League: Premier League (39)
 * - Season: 2025
 * - Uses fixtures -> events (goals) + fixtures/players (positions)
 * - Matches players to FPL-Elo players.csv by normalized name
 *
 * Usage:
 *   node scripts/generate_scorers_positions.mjs --gw=1
 *
 * Required env vars:
 *   FOOTBALL_API_KEY   (your API-Football key)
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

// -------------------------
// Setup & constants
// -------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const API_BASE = 'https://v3.football.api-sports.io';
const LEAGUE_ID = 39;   // Premier League
const SEASON = 2025;    // adjust if needed

const FPL_PLAYERS_URL =
  'https://raw.githubusercontent.com/olbauday/FPL-Elo-Insights/main/data/2025-2026/players.csv';

const OUTPUT_DIR = path.join(__dirname, '..', 'data', 'football-api');

// -------------------------
// Utility helpers
// -------------------------

function parseArgs() {
  const args = process.argv.slice(2);
  const out = {};
  for (const arg of args) {
    const [k, v] = arg.split('=');
    if (k.startsWith('--')) out[k.slice(2)] = v ?? true;
  }
  return out;
}

function normalizeName(name) {
  if (!name) return '';
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // strip accents
    .replace(/[^a-zA-Z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Very simple CSV parser (no newlines inside fields, but handles quotes).
 */
function parseCSV(text) {
  const lines = text.trim().split('\n').filter(l => l.trim());
  if (lines.length < 2) return [];

  const headers = lines[0].split(',').map(h => h.trim());
  const rows = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const values = [];
    let current = '';
    let inQuotes = false;

    for (const ch of line) {
      if (ch === '"') {
        inQuotes = !inQuotes;
      } else if (ch === ',' && !inQuotes) {
        values.push(current.replace(/^"|"$/g, '').trim());
        current = '';
      } else {
        current += ch;
      }
    }
    values.push(current.replace(/^"|"$/g, '').trim());

    const obj = {};
    headers.forEach((h, idx) => {
      obj[h] = values[idx] ?? '';
    });
    rows.push(obj);
  }

  return rows;
}

async function fetchJson(url, params = {}) {
  const key = process.env.FOOTBALL_API_KEY;
  if (!key) {
    throw new Error('Missing FOOTBALL_API_KEY env var');
  }

  const urlObj = new URL(url);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) {
      urlObj.searchParams.set(k, String(v));
    }
  }

  const res = await fetch(urlObj.toString(), {
    headers: {
      'x-rapidapi-key': key,
      'x-rapidapi-host': 'v3.football.api-sports.io',
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`HTTP ${res.status} for ${urlObj.toString()}: ${body.slice(0, 200)}`);
  }

  const json = await res.json();
  return json;
}

// -------------------------
// FPL players mapping
// -------------------------

async function loadFplPlayers() {
  console.log('🔄 Fetching FPL players.csv...');
  const res = await fetch(FPL_PLAYERS_URL);
  if (!res.ok) {
    throw new Error(`Failed to fetch FPL players.csv: HTTP ${res.status}`);
  }
  const text = await res.text();
  const players = parseCSV(text);

  // Build lookup by several keys
  const byKey = new Map();

  for (const p of players) {
    const first = (p.first_name || '').trim();
    const second = (p.second_name || '').trim();
    const web = (p.web_name || '').trim();

    const full = normalizeName(`${first} ${second}`);
    const rev = normalizeName(`${second} ${first}`);
    const webKey = normalizeName(web);
    const secondKey = normalizeName(second);

    const id = p.player_id;
    const record = {
      id,
      first,
      second,
      web,
      team_code: p.team_code,
      position: p.position,
    };

    for (const key of [full, rev, webKey, secondKey]) {
      if (!key) continue;
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(record);
    }
  }

  return { players, byKey };
}

function matchFplPlayer(apiName, fplIndex) {
  const norm = normalizeName(apiName);
  if (!norm) return null;

  const candidates = fplIndex.byKey.get(norm);
  if (!candidates || candidates.length === 0) return null;

  // If multiple, just take first – you can refine later by team if needed
  return candidates[0];
}

// -------------------------
// Football-API data fetch
// -------------------------

async function resolveRoundForGW(gw) {
  console.log(`🔎 Resolving round name for GW${gw}...`);

  const data = await fetchJson(`${API_BASE}/fixtures/rounds`, {
    league: LEAGUE_ID,
    season: SEASON,
  });

  let rounds = data.response;
  if (!Array.isArray(rounds)) {
    // Some clients flatten, just in case
    rounds = Array.isArray(data) ? data : [];
  }

  if (!rounds || rounds.length === 0) {
    throw new Error('Could not fetch any rounds from API-Football for this league/season.');
  }

  console.log(`   Available rounds (${rounds.length}): ${rounds.join(' | ')}`);

  const idx = gw - 1;
  const round = rounds[idx];

  if (!round) {
    throw new Error(
      `No round found for gw=${gw}. ` +
      `Available rounds indices: 0..${rounds.length - 1}`
    );
  }

  console.log(`   Using round "${round}" for GW${gw}`);
  return round;
}

async function fetchFixturesForGW(gw) {
  console.log(`🔄 Fetching fixtures for GW${gw} (Premier League)...`);

  const round = await resolveRoundForGW(gw);

  const data = await fetchJson(`${API_BASE}/fixtures`, {
    league: LEAGUE_ID,
    season: SEASON,
    round,
  });

  const fixtures = data.response || [];
  console.log(`   Found ${fixtures.length} fixtures for GW${gw} (round="${round}")`);
  return fixtures;
}

async function fetchGoalsForFixture(fixtureId) {
  const data = await fetchJson(`${API_BASE}/fixtures/events`, {
    fixture: fixtureId,
  });

  const events = data.response || [];
  return events.filter(e => e.type === 'Goal');
}

async function fetchPlayersForFixture(fixtureId) {
  const data = await fetchJson(`${API_BASE}/fixtures/players`, {
    fixture: fixtureId,
  });

  const resp = data.response || [];
  const posByPlayer = new Map();

  for (const teamBlock of resp) {
    const players = teamBlock.players || [];
    for (const p of players) {
      const pid = p.player?.id;
      const stats = (p.statistics && p.statistics[0]) || {};
      const games = stats.games || {};
      const pos = games.position || null;
      if (pid != null && pos) {
        posByPlayer.set(pid, pos);
      }
    }
  }

  return posByPlayer;
}

// -------------------------
// Main logic
// -------------------------

async function main() {
  try {
    const args = parseArgs();
    const gw = Number(args.gw || args.gameweek);

    if (!gw || Number.isNaN(gw)) {
      console.error('❌ Please provide --gw=N (e.g., --gw=1)');
      process.exit(1);
    }

    // Ensure output dir
    await fs.mkdir(OUTPUT_DIR, { recursive: true });

    const { byKey: fplIndex } = await loadFplPlayers();
    const fixtures = await fetchFixturesForGW(gw);

    const rows = [];

    for (const fixture of fixtures) {
      const fixtureId = fixture.fixture?.id;
      if (!fixtureId) continue;

      console.log(`⚽ Fixture ${fixtureId} – fetching events + players...`);

      const [goals, posByPlayer] = await Promise.all([
        fetchGoalsForFixture(fixtureId),
        fetchPlayersForFixture(fixtureId),
      ]);

      for (const ev of goals) {
        const apiPlayer = ev.player || {};
        const apiTeam = ev.team || {};
        const apiTime = ev.time || {};

        const apiPlayerId = apiPlayer.id;
        const apiPlayerName = apiPlayer.name || '';
        const minute = apiTime.elapsed ?? '';
        const detail = ev.detail || '';
        const teamApiId = apiTeam.id ?? '';
        const teamName = apiTeam.name || '';

        const apiMatchPosRaw = posByPlayer.get(apiPlayerId) || '';
        const apiMatchPos = apiMatchPosRaw || '';

        const fpl = matchFplPlayer(apiPlayerName, fplIndex);

        rows.push({
          gw,
          fixture_id: fixtureId,
          team_api_id: teamApiId,
          team_name: teamName,
          api_player_id: apiPlayerId ?? '',
          api_player_name: apiPlayerName,
          minute,
          goal_detail: detail,
          api_match_position: apiMatchPos,
          fpl_player_id: fpl?.id ?? '',
          fpl_web_name: fpl?.web ?? '',
          fpl_first_name: fpl?.first ?? '',
          fpl_second_name: fpl?.second ?? '',
        });
      }
    }

    // Write CSV
    const gwStr = String(gw).padStart(2, '0');
    const outPath = path.join(OUTPUT_DIR, `gw${gwStr}_scorers_positions.csv`);

    console.log(`📝 Writing ${rows.length} rows to ${outPath}...`);

    const headers = [
      'gw',
      'fixture_id',
      'team_api_id',
      'team_name',
      'api_player_id',
      'api_player_name',
      'minute',
      'goal_detail',
      'api_match_position',
      'fpl_player_id',
      'fpl_web_name',
      'fpl_first_name',
      'fpl_second_name',
    ];

    const lines = [headers.join(',')];

    for (const r of rows) {
      const vals = headers.map(h => {
        let v = r[h] ?? '';
        if (typeof v === 'string') {
          if (v.includes('"') || v.includes(',') || v.includes('\n')) {
            v = `"${v.replace(/"/g, '""')}"`;
          }
        }
        return v;
      });
      lines.push(vals.join(','));
    }

    await fs.writeFile(outPath, lines.join('\n'), 'utf8');
    console.log(`✅ Done. Saved ${rows.length} records for GW${gw}.`);
  } catch (err) {
    console.error('❌ Error:', err.message);
    process.exit(1);
  }
}

main();