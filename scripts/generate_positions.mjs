#!/usr/bin/env node
/**
 * Generate player_position_overrides.csv from FPL players data
 *
 * Fetches players from the external FPL-Elo-Insights repo and maps their positions
 * to canonical positions for the FPL analytics application.
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PLAYERS_CSV_URL = 'https://raw.githubusercontent.com/olbauday/FPL-Elo-Insights/main/data/2025-2026/players.csv';
const OUTPUT_PATH = path.join(__dirname, '..', 'data', 'player_position_overrides.csv');

/**
 * Map various position strings to canonical positions
 * Canonical positions: GK, CB, LB, RB, CDM, MID, FWD
 */
const POSITION_MAPPING = {
  // Goalkeepers
  'goalkeeper': 'GK',
  'gk': 'GK',

  // Defenders
  'centre-back': 'CB',
  'center-back': 'CB',
  'cb': 'CB',
  'defender': 'CB',
  'def': 'CB',

  'left-back': 'LB',
  'left back': 'LB',
  'lb': 'LB',
  'lwb': 'LB',
  'left wing-back': 'LB',
  'left wingback': 'LB',

  'right-back': 'RB',
  'right back': 'RB',
  'rb': 'RB',
  'rwb': 'RB',
  'right wing-back': 'RB',
  'right wingback': 'RB',

  // Midfielders
  'defensive midfield': 'CDM',
  'defensive mid': 'CDM',
  'defensive midfielder': 'CDM',
  'cdm': 'CDM',
  'dm': 'CDM',

  'central midfield': 'CM',
  'central midfielder': 'CM',
  'central mid': 'CM',
  'cm': 'CM',
  'midfield': 'CM',
  'midfielder': 'CM',
  'mid': 'CM',

  'attacking midfield': 'AM',
  'attacking midfielder': 'AM',
  'attacking mid': 'AM',
  'am': 'AM',

  'left winger': 'LW',
  'left wing': 'LW',
  'lw': 'LW',

  'right winger': 'RW,
  'right wing': 'RW',
  'rw': 'RW',

  'winger': 'MID',
  'wing': 'MID',

  // Forwards
  'centre-forward': 'CF',
  'center-forward': 'CF',
  'cf': 'CF',
  'forward': 'FWD',
  'fwd': 'CF',

  'striker': 'CF',
  'st': 'CF

  'second striker': 'CF',
  'ss': 'CF',

  'attacker': 'FWD',
};

/**
 * Parse a position string to canonical position
 */
function toCanonical(positionStr) {
  if (!positionStr) return null;
  const normalized = positionStr.trim().toLowerCase();
  return POSITION_MAPPING[normalized] || null;
}

/**
 * Fetch text content from a URL
 */
async function fetchText(url) {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    return response.text();
  } catch (error) {
    throw new Error(`Failed to fetch ${url}: ${error.message}`);
  }
}

/**
 * Parse CSV text into array of objects
 */
function parseCSV(text) {
  const lines = text.trim().split('\n').filter(line => line.trim());
  if (lines.length < 2) return [];

  const headers = lines[0].split(',').map(h => h.trim());
  const result = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    // Simple CSV parsing - handles quoted fields
    const values = [];
    let current = '';
    let inQuotes = false;

    for (let char of line) {
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === ',' && !inQuotes) {
        values.push(current.trim().replace(/^"|"$/g, ''));
        current = '';
      } else {
        current += char;
      }
    }
    values.push(current.trim().replace(/^"|"$/g, ''));

    if (values.length !== headers.length) {
      console.warn(`⚠ Row ${i + 1}: expected ${headers.length} columns, got ${values.length}`);
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
 * Derive canonical position from player row
 * Tries detailed_position first, then role, then position
 */
function derivePosition(player) {
  // Try detailed_position first (most specific)
  const detailedPos = player.detailed_position || player.detailedPosition;
  if (detailedPos) {
    const canonical = toCanonical(detailedPos);
    if (canonical) return canonical;
  }

  // Try role second
  const role = player.role;
  if (role) {
    const canonical = toCanonical(role);
    if (canonical) return canonical;
  }

  // Try position last (most generic)
  const pos = player.position;
  if (pos) {
    const canonical = toCanonical(pos);
    if (canonical) return canonical;
  }

  return null;
}

/**
 * Main function
 */
async function main() {
  try {
    console.log('🔄 Fetching players data...');
    const csvText = await fetchText(PLAYERS_CSV_URL);

    console.log('📊 Parsing CSV...');
    const players = parseCSV(csvText);
    console.log(`   Found ${players.length} players`);

    console.log('🗺️  Mapping positions...');
    const overrides = [];
    let mapped = 0;
    let skipped = 0;

    for (const player of players) {
      const playerId = player.id || player.player_id;
      if (!playerId) {
        skipped++;
        continue;
      }

      const canonicalPos = derivePosition(player);
      if (canonicalPos) {
        overrides.push([playerId, canonicalPos]);
        mapped++;
      } else {
        skipped++;
      }
    }

    console.log(`   ✓ Mapped ${mapped} positions`);
    if (skipped > 0) {
      console.log(`   ⚠ Skipped ${skipped} players without position data`);
    }

    // Write CSV
    console.log(`📝 Writing ${OUTPUT_PATH}...`);
    const csvContent = ['player_id,actual_position', ...overrides.map(([id, pos]) => `${id},${pos}`)].join('\n');
    await fs.writeFile(OUTPUT_PATH, csvContent, 'utf8');

    console.log(`✅ Successfully wrote ${overrides.length} position overrides`);
    process.exit(0);
  } catch (error) {
    console.error(`❌ Error: ${error.message}`);
    process.exit(1);
  }
}

main();
