/**
 * Data Loader Module
 * Functions for loading CSV data from remote sources
 */

import { CSVParser } from './csv-parser.js';
import { CONFIG } from './config.js';

/**
 * Fetch and parse a CSV file (required - throws on error)
 * @param {string} url - The URL to fetch
 * @returns {Promise<Array>} Parsed CSV data
 */
export const fetchCSV = async (url) => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to load ${url} (${res.status})`);
    const text = await res.text();
    return CSVParser.parse(text);
};

/**
 * Fetch and parse a CSV file (optional - returns empty array on error)
 * @param {string} url - The URL to fetch
 * @returns {Promise<Array>} Parsed CSV data or empty array
 */
export const fetchCSVOptional = async (url) => {
    try {
        const res = await fetch(url);
        if (!res.ok) return [];
        const text = await res.text();
        return CSVParser.parse(text);
    } catch (e) {
        return [];
    }
};

/**
 * Load the sanitized server-generated preseason dataset. The raw API-Football
 * cache is never requested by the browser.
 * @param {string} url - Public normalized dataset URL
 * @returns {Promise<Object>} Dataset or an empty, explicitly incomplete dataset
 */
export const loadPreseasonData = async (url = CONFIG.URLS.PRESEASON_DATA) => {
    const empty = {
        schema_version: 1,
        source: 'API-Football',
        records: [],
        coverage: {
            current_fpl_teams: 0,
            matched_fpl_teams: 0,
            completed_fixtures: 0,
            mapped_players: 0,
            mapped_player_records: 0,
            unmapped_players: 0,
            mapping_complete: false
        }
    };

    try {
        const res = await fetch(url);
        if (!res.ok) return empty;
        const data = await res.json();
        if (!data || data.source !== 'API-Football' || !Array.isArray(data.records)) return empty;
        return { ...empty, ...data, coverage: { ...empty.coverage, ...(data.coverage || {}) } };
    } catch (e) {
        return empty;
    }
};

/**
 * Join normalized preseason records onto FPL player rows.
 * @param {Array} players - Current/base FPL player rows
 * @param {Object} preseason - Sanitized preseason dataset
 * @returns {Array} Player rows with a preseason summary
 */
export const augmentPlayersWithPreseason = (players, preseason) => {
    const byPlayer = {};
    (preseason?.records || []).forEach(record => {
        const playerId = String(record.fpl_player_id);
        if (!byPlayer[playerId]) byPlayer[playerId] = [];
        byPlayer[playerId].push(record);
    });

    return players.map(player => {
        const playerId = player.player_id ?? player.id;
        const records = byPlayer[String(playerId)] || [];
        const summary = records.length > 0 ? {
            records,
            fixture_count: new Set(records.map(record => record.source_fixture_id)).size,
            appearances: records.length,
            starts: records.filter(record => record.started).length,
            minutes: records.reduce((sum, record) => sum + Number(record.minutes || 0), 0),
            goals: records.reduce((sum, record) => sum + Number(record.goals || 0), 0),
            assists: records.reduce((sum, record) => sum + Number(record.assists || 0), 0),
            source_updated_at: records.map(record => record.source_updated_at).filter(Boolean).sort().at(-1) || null
        } : null;
        return { ...player, preseason: summary };
    });
};

/**
 * Return a UI-safe freshness and mapping summary, optionally for selected IDs.
 */
export const getPreseasonStatus = ({ preseason, players = [], selectedPlayerIds = [] } = {}) => {
    const coverage = preseason?.coverage || {};
    const selected = new Set(selectedPlayerIds.map(id => String(id)));
    const mappedSelected = players.filter(player => selected.has(String(player.player_id ?? player.id)) && player.preseason?.records?.length).length;
    return {
        source: preseason?.source || 'API-Football',
        sourceUpdatedAt: preseason?.source_updated_at || null,
        generatedAt: preseason?.generated_at || null,
        mappedPlayers: Number(coverage.mapped_players || 0),
        completedFixtures: Number(coverage.completed_fixtures || 0),
        mappedRecords: Number(coverage.mapped_player_records || 0),
        unmappedPlayers: Number(coverage.unmapped_players || 0),
        selectedPlayers: selected.size,
        mappedSelectedPlayers: mappedSelected,
        selectedComplete: selected.size > 0 && mappedSelected === selected.size,
        mappingComplete: coverage.mapping_complete === true,
        available: Array.isArray(preseason?.records) && preseason.records.length > 0
    };
};

/**
 * Update loading status in the UI
 * @param {string} msg - Status message to display
 */
export const updateStatus = (msg) => {
    const el = document.getElementById('loading');
    if (el) el.textContent = msg;
    console.log(`[System]: ${msg}`);
};

/**
 * Load all gameweek data (stats and fixtures) for a season
 * @param {number} maxGW - Maximum gameweek number
 * @param {number} batchSize - Number of GWs to fetch in parallel
 * @returns {Promise<{stats: Array, fixtures: Array}>} All stats and fixtures
 */
export const loadGameweekData = async (maxGW = CONFIG.UI.MAX_GW, batchSize = 5) => {
    const allStats = [];
    const allFixtures = [];

    for (let gw = 1; gw <= maxGW; gw += batchSize) {
        const promises = [];
        for (let j = 0; j < batchSize; j++) {
            const currentGW = gw + j;
            if (currentGW > maxGW) break;

            const gwPath = `${CONFIG.PATHS.PL_TOURNAMENT_BASE}/GW${currentGW}`;
            const statsUrl = `${gwPath}/player_gameweek_stats.csv`;
            const fixturesUrl = `${gwPath}/fixtures.csv`;

            promises.push(
                Promise.all([
                    fetchCSVOptional(statsUrl),
                    fetchCSVOptional(fixturesUrl),
                    currentGW
                ])
            );
        }

        const results = await Promise.all(promises);

        results.forEach(([gwStats, gwFixtures, gNum]) => {
            gwStats.forEach(row => row.gw = row.gw || row.gameweek || gNum);
            gwFixtures.forEach(row => row.gw = row.gw || row.gameweek || gNum);

            allStats.push(...gwStats);
            allFixtures.push(...gwFixtures);
        });

        updateStatus(`Fetching Data... processed up to GW${Math.min(gw + batchSize, maxGW)}`);
    }

    return { stats: allStats, fixtures: allFixtures };
};

/**
 * Load base data (players, teams, optional position overrides)
 * @param {boolean} includePositionOverrides - Whether to load position overrides
 * @returns {Promise<{players: Array, teams: Array, positionOverrides?: Array}>}
 */
export const loadBaseData = async (includePositionOverrides = false) => {
    updateStatus("Fetching Season Metadata...");

    const promises = [
        fetchCSV(CONFIG.URLS.PLAYERS),
        fetchCSV(CONFIG.URLS.TEAMS),
        loadPreseasonData()
    ];

    if (includePositionOverrides) {
        promises.push(fetchCSVOptional(CONFIG.URLS.POSITION_OVERRIDES));
    }

    const results = await Promise.all(promises);

    const data = {
        players: augmentPlayersWithPreseason(results[0], results[2]),
        teams: results[1],
        preseason: results[2]
    };

    if (includePositionOverrides) {
        data.positionOverrides = results[3] || [];
    }

    updateStatus(`Loaded ${data.players.length} Players and ${data.teams.length} Teams. Fetching GW Data...`);

    return data;
};

/**
 * Load all data needed for most pages
 * @param {boolean} includePositionOverrides - Whether to load position overrides
 * @returns {Promise<Object>} Complete data object
 */
export const loadAllData = async (includePositionOverrides = false) => {
    const baseData = await loadBaseData(includePositionOverrides);
    const gwData = await loadGameweekData();

    return {
        ...baseData,
        stats: gwData.stats,
        fixtures: gwData.fixtures
    };
};
