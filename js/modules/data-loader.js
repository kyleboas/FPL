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
        fetchCSV(CONFIG.URLS.TEAMS)
    ];

    if (includePositionOverrides) {
        promises.push(fetchCSVOptional(CONFIG.URLS.POSITION_OVERRIDES));
    }

    const results = await Promise.all(promises);

    const data = {
        players: results[0],
        teams: results[1]
    };

    if (includePositionOverrides) {
        data.positionOverrides = results[2] || [];
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
