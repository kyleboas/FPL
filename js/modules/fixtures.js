/**
 * Fixtures Logic Module
 * Functions for processing fixture data
 */

import { getVal } from './utils.js';

/**
 * Build fixtures lookup by team
 * @param {Object} params - Processing parameters
 * @param {Array} params.fixtures - All fixtures
 * @param {Array} params.teams - All teams
 * @returns {Object} Fixtures lookup { teamCode: { gw: fixtureData } }
 */
export const buildFixturesLookup = ({ fixtures, teams }) => {
    const fixturesByTeam = {};

    teams.forEach(t => {
        fixturesByTeam[t.code] = {};
    });

    fixtures.forEach(fix => {
        const hCode = getVal(fix, 'home_team', 'team_h', 'home_team_id');
        const aCode = getVal(fix, 'away_team', 'team_a', 'away_team_id');
        // Handle various boolean formats: true/false, "true"/"false", 1/0, "yes"/"no"
        const finVal = getVal(fix, 'finished', 'is_finished', 'completed');
        const isFin = finVal === true || finVal === 1 ||
            (typeof finVal === 'string' && ['true', 'yes', '1'].includes(finVal.toLowerCase()));
        const gw = getVal(fix, 'gw', 'event', 'gameweek');

        // Home team
        if (hCode != null && fixturesByTeam[hCode]) {
            fixturesByTeam[hCode][gw] = {
                opponentCode: aCode,
                wasHome: true,
                finished: isFin
            };
        }

        // Away team
        if (aCode != null && fixturesByTeam[aCode]) {
            fixturesByTeam[aCode][gw] = {
                opponentCode: hCode,
                wasHome: false,
                finished: isFin
            };
        }
    });

    return fixturesByTeam;
};

/**
 * Build GW list from range with exclusions
 * @param {number} startGW - Start gameweek
 * @param {number} endGW - End gameweek
 * @param {number[]} excludedGWs - Gameweeks to exclude
 * @returns {number[]} Array of gameweek numbers
 */
export const buildGWList = (startGW, endGW, excludedGWs = []) => {
    const excludedSet = new Set(excludedGWs);
    const gwList = [];
    for (let gw = startGW; gw <= endGW; gw++) {
        if (!excludedSet.has(gw)) {
            gwList.push(gw);
        }
    }
    return gwList;
};
