/**
 * Goals Logic Module
 * Functions for processing and calculating goal statistics
 */

import { getVal, roundToTwo } from './utils.js';
import { CONFIG } from './config.js';

/**
 * Process goals data from fixtures
 * @param {Object} params - Processing parameters
 * @param {Array} params.fixtures - All fixtures
 * @param {Array} params.teams - All teams
 * @param {Object} params.fixturesByTeam - Fixtures lookup to update with goals
 * @returns {Object} { teamGoals, latestGW }
 */
export const processGoalsData = ({ fixtures, teams, fixturesByTeam }) => {
    const teamGoals = {};

    teams.forEach(t => {
        teamGoals[t.code] = {
            'combined': {},
            'home': {},
            'away': {}
        };
    });

    let latestCompletedGW = 0;

    fixtures.forEach(fix => {
        const hCode = getVal(fix, 'home_team', 'team_h', 'home_team_id');
        const aCode = getVal(fix, 'away_team', 'team_a', 'away_team_id');
        const hGoals = getVal(fix, 'team_h_score', 'home_score', 'home_goals') || 0;
        const aGoals = getVal(fix, 'team_a_score', 'away_score', 'away_goals') || 0;
        const isFin = String(getVal(fix, 'finished')).toLowerCase() === 'true';
        const gw = getVal(fix, 'gw', 'event', 'gameweek');

        // Track latest completed gameweek
        if (isFin && gw > latestCompletedGW) {
            latestCompletedGW = gw;
        }

        // Home team
        if (hCode != null && fixturesByTeam[hCode] && fixturesByTeam[hCode][gw]) {
            fixturesByTeam[hCode][gw].goalsFor = hGoals;
            fixturesByTeam[hCode][gw].goalsAgainst = aGoals;

            if (isFin) {
                teamGoals[hCode]['combined'][gw] = { for: hGoals, against: aGoals };
                teamGoals[hCode]['home'][gw] = { for: hGoals, against: aGoals };
            }
        }

        // Away team
        if (aCode != null && fixturesByTeam[aCode] && fixturesByTeam[aCode][gw]) {
            fixturesByTeam[aCode][gw].goalsFor = aGoals;
            fixturesByTeam[aCode][gw].goalsAgainst = hGoals;

            if (isFin) {
                teamGoals[aCode]['combined'][gw] = { for: aGoals, against: hGoals };
                teamGoals[aCode]['away'][gw] = { for: aGoals, against: hGoals };
            }
        }
    });

    return { teamGoals, latestGW: latestCompletedGW };
};

/**
 * Calculate cumulative goals per match for all teams
 * @param {Object} params - Calculation parameters
 * @param {Array} params.teams - All teams
 * @param {Object} params.fixturesByTeam - Fixtures lookup
 * @param {number} params.latestGW - Latest completed gameweek
 * @param {number} params.formFilter - Form window (0 = all time, 1-12 = last N GWs)
 * @param {number} params.maxGW - Maximum gameweek number
 * @returns {Object} Cumulative goals by team code
 */
export const calculateCumulativeGoals = ({
    teams,
    fixturesByTeam,
    latestGW,
    formFilter = 0,
    maxGW = CONFIG.UI.MAX_GW
}) => {
    const cumulativeGoalsByTeam = {};

    teams.forEach(team => {
        const teamCode = team.code;
        cumulativeGoalsByTeam[teamCode] = {
            combined: {},
            home: {},
            away: {}
        };

        const windowEnd = latestGW;

        // If no completed fixtures yet, everything is 0 for all GWs
        if (windowEnd < 1) {
            for (let gw = 1; gw <= maxGW; gw++) {
                cumulativeGoalsByTeam[teamCode].combined[gw] = { for: 0, against: 0 };
                cumulativeGoalsByTeam[teamCode].home[gw] = { for: 0, against: 0 };
                cumulativeGoalsByTeam[teamCode].away[gw] = { for: 0, against: 0 };
            }
            return;
        }

        let windowStart;
        if (formFilter === 0) {
            windowStart = 1;
        } else {
            windowStart = Math.max(1, windowEnd - formFilter + 1);
        }

        // Aggregate raw totals AND match counts in this SINGLE window
        let combinedFor = 0, combinedAgainst = 0, combinedMatches = 0;
        let homeFor = 0, homeAgainst = 0, homeMatches = 0;
        let awayFor = 0, awayAgainst = 0, awayMatches = 0;

        for (let w = windowStart; w <= windowEnd; w++) {
            const fix = fixturesByTeam[teamCode] ? fixturesByTeam[teamCode][w] : null;
            if (fix && fix.finished) {
                const goalsFor = fix.goalsFor || 0;
                const goalsAgainst = fix.goalsAgainst || 0;

                combinedFor += goalsFor;
                combinedAgainst += goalsAgainst;
                combinedMatches += 1;

                if (fix.wasHome) {
                    homeFor += goalsFor;
                    homeAgainst += goalsAgainst;
                    homeMatches += 1;
                } else {
                    awayFor += goalsFor;
                    awayAgainst += goalsAgainst;
                    awayMatches += 1;
                }
            }
        }

        // Convert to per-match averages (goals per game)
        const combinedForPer = combinedMatches > 0 ? roundToTwo(combinedFor / combinedMatches) : 0;
        const combinedAgainstPer = combinedMatches > 0 ? roundToTwo(combinedAgainst / combinedMatches) : 0;

        // For home/away, if sample size is 0, fall back to combined average
        const homeForPer = homeMatches > 0 ? roundToTwo(homeFor / homeMatches) : combinedForPer;
        const homeAgainstPer = homeMatches > 0 ? roundToTwo(homeAgainst / homeMatches) : combinedAgainstPer;

        const awayForPer = awayMatches > 0 ? roundToTwo(awayFor / awayMatches) : combinedForPer;
        const awayAgainstPer = awayMatches > 0 ? roundToTwo(awayAgainst / awayMatches) : combinedAgainstPer;

        // Write the SAME per-match averages into every GW column for this team
        for (let gw = 1; gw <= maxGW; gw++) {
            cumulativeGoalsByTeam[teamCode].combined[gw] = {
                for: combinedForPer,
                against: combinedAgainstPer
            };
            cumulativeGoalsByTeam[teamCode].home[gw] = {
                for: homeForPer,
                against: homeAgainstPer
            };
            cumulativeGoalsByTeam[teamCode].away[gw] = {
                for: awayForPer,
                against: awayAgainstPer
            };
        }
    });

    return cumulativeGoalsByTeam;
};
