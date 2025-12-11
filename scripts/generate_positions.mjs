#!/usr/bin/env node
/**
 * Generate player_position_overrides.csv from FPL players data
 *
 * Fetches players from the external FPL‑Elo‑Insights repo and maps their positions
 * to canonical positions for the FPL analytics application.
 *
 * Canonical positions:
 *   GK, CB, LB, RB, CDM, CM, AM, LW, RW, CF
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Source of FPL player data (complete season snapshot)
const PLAYERS_CSV_URL =
  'https://raw.githubusercontent.com/olbauday/FPL-Elo-Insights/main/data/2025-2026/players.csv';
// Destination path for generated overrides CSV
const OUTPUT_PATH = path.join(__dirname, 'player_position_overrides.csv');

// Additional source: per‑gameweek stats.  We use this file solely to
// determine the set of valid player IDs.  The gameweek stats file
// contains an `id` column that should match the `player_id` column
// in players.csv.  Filtering the players by this set prevents
// generating overrides for players that are not present in the
// stats data.
const GAMEWEEK_STATS_CSV_URL =
  'https://raw.githubusercontent.com/olbauday/FPL-Elo-Insights/main/data/2025-2026/By%20Tournament/Premier%20League/GW1/player_gameweek_stats.csv';

/**
 * Map various position strings (from APIs or FPL data) to canonical positions.
 *
 * The Sportmonks Football API uses names like `centre-back`, `defensive-midfied`,
 * `attacking-midfied`, `central-midfied`, `centre-forward`, `left-wing`,
 * `right-wing`, `left-midfield`, `right-midfield`, `secondary_striker` etc【873026161308000†L219-L299】.
 * The FPL‑Elo dataset uses high‑level positions: Goalkeeper, Defender, Midfielder,
 * Forward【690444723428106†L0-L3】. This mapping handles both cases and normalizes them
 * to a fixed set of canonical codes: GK, CB, LB, RB, CDM, CM, AM, LW, RW, CF.
 */
const POSITION_MAPPING = {
  // Goalkeepers
  'goalkeeper': 'GK',
  'gk': 'GK',
  'gkp': 'GK',
  'goal keeper': 'GK',
  'keeper': 'GK',
  'goalie': 'GK',

  // Centre‑backs / central defenders
  'centre-back': 'CB',
  'center-back': 'CB',
  'centre back': 'CB',
  'center back': 'CB',
  'centre_back': 'CB',
  'center_back': 'CB',
  'cb': 'CB',

  // Full‑backs & wing‑backs
  'left-back': 'LB',
  'left back': 'LB',
  'left_back': 'LB',
  'lb': 'LB',
  'lwb': 'LB',
  'left wing-back': 'LB',
  'left wingback': 'LB',
  'left wing back': 'LB',

  'right-back': 'RB',
  'right back': 'RB',
  'right_back': 'RB',
  'rb': 'RB',
  'rwb': 'RB',
  'right wing-back': 'RB',
  'right wingback': 'RB',
  'right wing back': 'RB',

  // Defensive midfield
  'defensive midfield': 'CDM',
  'defensive midfielder': 'CDM',
  'defensive mid': 'CDM',
  'defensive-midfied': 'CDM',
  'dm': 'CDM',
  'cdm': 'CDM',

  // Central midfield
  'central midfield': 'CM',
  'central midfielder': 'CM',
  'central mid': 'CM',
  'central-midfied': 'CM',
  'cm': 'CM',

  // Wide midfield (LM/RM) – fold into CM
  'left-midfield': 'LW',
  'left midfield': 'LW',
  'left_midfield': 'LW',
  'lm': 'LW',
  'right-midfield': 'RW',
  'right midfield': 'RW',
  'right_midfield': 'RW',
  'rm': 'RW',

  // Attacking midfield / number 10s
  'attacking midfield': 'AM',
  'attacking midfielder': 'AM',
  'attacking mid': 'AM',
  'attacking-midfied': 'AM',
  'am': 'AM',
  'cam': 'AM',

  // Wingers (wide forwards)
  'left wing': 'LW',
  'left-wing': 'LW',
  'left winger': 'LW',
  'left_wing': 'LW',
  'lw': 'LW',

  'right wing': 'RW',
  'right-wing': 'RW',
  'right winger': 'RW',
  'right_wing': 'RW',
  'rw': 'RW',

  // Forwards (strikers)
  'centre-forward': 'CF',
  'center-forward': 'CF',
  'centre forward': 'CF',
  'center forward': 'CF',
  'centre_forward': 'CF',
  'center_forward': 'CF',
  'cf': 'CF',
  'striker': 'CF',
  'st': 'CF',
  'second striker': 'CF',
  'secondary striker': 'CF',
  'secondary_striker': 'CF',
  'ss': 'CF',
};

/**
 * Convert a raw position string to its canonical code.
 *
 * If the input string contains hyphens or underscores, normalizes them to spaces
 * before looking up. Handles undefined / empty input gracefully.
 */
function toCanonical(positionStr) {
  if (!positionStr) return null;
  const normalized = positionStr.trim().toLowerCase();

  // Try exact match
  if (POSITION_MAPPING[normalized]) return POSITION_MAPPING[normalized];

  // Replace hyphens with spaces
  const noHyphen = normalized.replace(/-/g, ' ');
  if (POSITION_MAPPING[noHyphen]) return POSITION_MAPPING[noHyphen];

  // Replace underscores with spaces
  const noUnderscore = normalized.replace(/_/g, ' ');
  if (POSITION_MAPPING[noUnderscore]) return POSITION_MAPPING[noUnderscore];

  return null;
}

/**
 * Fetch text content from a URL
 */
async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  }
  return res.text();
}

/**
 * Parse CSV text into an array of objects. Handles quoted fields with commas.
 */
function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];

  const headers = lines[0].split(',').map(h => h.trim());
  const result = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const values = [];
    let current = '';
    let inQuotes = false;
    for (const char of line) {
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === ',' && !inQuotes) {
        values.push(current.replace(/^"|"$/g, '').trim());
        current = '';
      } else {
        current += char;
      }
    }
    values.push(current.replace(/^"|"$/g, '').trim());
    if (values.length !== headers.length) {
      console.warn(`⚠️ Row ${i + 1}: expected ${headers.length} columns, got ${values.length}`);
      continue;
    }
    const obj = {};
    headers.forEach((header, idx) => {
      obj[header] = values[idx];
    });
    result.push(obj);
  }
  return result;
}

/**
 * Determine the canonical position for a player.
 * Looks at detailed_position, role, and position fields in order.
 */
function derivePosition(player) {
  // Sportmonks / API detailed position
  const detailedPos = player.detailed_position || player.detailedPosition;
  if (detailedPos) {
    const canonical = toCanonical(detailedPos);
    if (canonical) return canonical;
  }
  // Generic role field
  const role = player.role;
  if (role) {
    const canonical = toCanonical(role);
    if (canonical) return canonical;
  }
  // FPL‑Elo position field
  const pos = player.position;
  if (pos) {
    const canonical = toCanonical(pos);
    if (canonical) return canonical;
  }
  return null;
}

/**
 * Main entrypoint.
 * Fetch players CSV, map positions to canonical codes, and write to output.
 */
async function main() {
  console.log('🔄 Fetching players CSV…');
  const csvText = await fetchText(PLAYERS_CSV_URL);

  console.log('🔄 Fetching gameweek stats CSV…');
  // The stats file is optional: if it fails to load we still proceed
  // without filtering.  This ensures the script remains robust when
  // the stats file is unavailable (e.g. offline or different season).
  let statsText;
  try {
    statsText = await fetchText(GAMEWEEK_STATS_CSV_URL);
  } catch (err) {
    console.warn(
      `⚠️ Failed to fetch gameweek stats: ${err.message}. Proceeding without stats filter.`
    );
  }

  console.log('📊 Parsing CSV…');
  const players = parseCSV(csvText);
  console.log(`   Found ${players.length} players`);

  // Build a set of valid player IDs from the stats file, if loaded.
  let validPlayerIds = null;
  if (statsText) {
    const statsRows = parseCSV(statsText);
    validPlayerIds = new Set();
    for (const row of statsRows) {
      const id = row.id || row.player_id;
      if (id) validPlayerIds.add(id);
    }
    console.log(
      `   Loaded ${validPlayerIds.size} player IDs from gameweek stats`
    );
  }

  const overrides = [];
  let mapped = 0;
  let skipped = 0;
  for (const player of players) {
    const playerId = player.player_id || player.id;
    if (!playerId) {
      skipped++;
      continue;
    }

    // If we loaded valid IDs from the stats file, skip players not present there.
    if (validPlayerIds && !validPlayerIds.has(playerId)) {
      skipped++;
      continue;
    }

    const canonical = derivePosition(player);
    if (canonical) {
      overrides.push([playerId, canonical]);
      mapped++;
    } else {
      skipped++;
    }
  }
  console.log(`   ✓ Mapped ${mapped} positions`);
  if (skipped > 0) {
    console.log(`   ⚠️ Skipped ${skipped} players without position data`);
  }

  console.log(`📝 Writing overrides to ${OUTPUT_PATH}…`);
  const content = [
    'player_id,actual_position',
    ...overrides.map(([id, pos]) => `${id},${pos}`),
  ].join('\n');
  await fs.writeFile(OUTPUT_PATH, content, 'utf8');
  console.log(`✅ Done. Saved ${overrides.length} records.`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});