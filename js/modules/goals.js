/**
 * Goals Logic Module
 * Functions for processing and calculating goal statistics
 */

import { getVal, roundToTwo } from './utils.js';
import { CONFIG } from './config.js';
import { deriveArchetype, getPositionGroup } from './defcon.js';

// Helper: Map player position to a key using position overrides
function getPlayerPositionKey(player, positionOverrides = {}) {
    if (!player) return 'UNK';

    // Use deriveArchetype which properly checks position overrides
    const archetype = deriveArchetype(player, positionOverrides);
    if (!archetype) return 'UNK';

    // Convert archetype to position group
    const positionGroup = getPositionGroup(archetype);
    if (!positionGroup) return 'UNK';

    return positionGroup;
}

/**
 * Process goals data from fixtures
 * @param {Object} params - Processing parameters
 * @param {Array} params.fixtures - All fixtures
 * @param {Array} params.teams - All teams
 * @param {Object} params.fixturesByTeam - Fixtures lookup to update with goals
 * @param {Array} params.stats - Player stats (optional, for position-based goals)
 * @param {Object} params.playersById - Players lookup (optional, for position-based goals)
 * @param {Object} params.teamsById - Teams lookup (optional, for position-based goals)
 * @param {Object} params.positionOverrides - Position overrides lookup (optional)
 * @returns {Object} { teamGoals, latestGW, positionGoalsRaw }
 */
export const processGoalsData = ({ fixtures, teams, fixturesByTeam, stats = [], playersById = {}, teamsById = {}, positionOverrides = {} }) => {
    const teamGoals = {};
    const positionGoalsRaw = {};

    teams.forEach(t => {
        teamGoals[t.code] = {
            'combined': {},
            'home': {},
            'away': {}
        };
        positionGoalsRaw[t.code] = {};
    });

    let latestCompletedGW = 0;

    // Helper for position goals
    function ensurePositionGw(teamCode, gw) {
        const teamMap = positionGoalsRaw[teamCode] || (positionGoalsRaw[teamCode] = {});
        const gwMap = teamMap[gw] || (teamMap[gw] = {});
        ['ALL', 'DEF', 'MID', 'FWD'].forEach(key => {
            if (!gwMap[key]) {
                gwMap[key] = { for: 0, against: 0 };
            }
        });
        return gwMap;
    }

    fixtures.forEach(fix => {
        const hCode = getVal(fix, 'home_team', 'team_h', 'home_team_id');
        const aCode = getVal(fix, 'away_team', 'team_a', 'away_team_id');
        const hGoals = getVal(fix, 'team_h_score', 'home_score', 'home_goals') || 0;
        const aGoals = getVal(fix, 'team_a_score', 'away_score', 'away_goals') || 0;
        // Handle various boolean formats: true/false, "true"/"false", 1/0, "yes"/"no"
        const finVal = getVal(fix, 'finished', 'is_finished', 'completed');
        const isFin = finVal === true || finVal === 1 ||
            (typeof finVal === 'string' && ['true', 'yes', '1'].includes(finVal.toLowerCase()));
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

    // Build per-position goals from player stats
    stats.forEach(stat => {
        const pid = getVal(stat, 'player_id', 'id', 'element');
        const player = playersById[pid];
        if (!player) return;

        const gw = getVal(stat, 'gw', 'gameweek', 'event', 'round');
        if (!gw) return;

        const goals = getVal(stat, 'goals_scored', 'goals', 'Gls', 'Goals', 'G');
        if (!goals || goals <= 0) return;

        // Which team scored? Get team_code from the player object
        const teamCode = getVal(player, 'team_code', 'teamCode', 'team');
        if (!teamCode || !positionGoalsRaw[teamCode]) return;

        // Find opponent using fixturesByTeam
        const fix = fixturesByTeam[teamCode] && fixturesByTeam[teamCode][gw]
            ? fixturesByTeam[teamCode][gw]
            : null;
        const opponentCode = fix ? fix.opponentCode : null;

        const posKey = getPlayerPositionKey(player, positionOverrides);

        // Scoring team
        const gwMapForTeam = ensurePositionGw(teamCode, gw);
        gwMapForTeam.ALL.for += goals;
        if (posKey === 'DEF' || posKey === 'MID' || posKey === 'FWD') {
            gwMapForTeam[posKey].for += goals;
        }

        // Conceding team
        if (opponentCode && positionGoalsRaw[opponentCode]) {
            const gwMapOpp = ensurePositionGw(opponentCode, gw);
            gwMapOpp.ALL.against += goals;
            if (posKey === 'DEF' || posKey === 'MID' || posKey === 'FWD') {
                gwMapOpp[posKey].against += goals;
            }
        }
    });

    return { teamGoals, latestGW: latestCompletedGW, positionGoalsRaw };
};

/**
 * Calculate cumulative goals per match for all teams
 * @param {Object} params - Calculation parameters
 * @param {Array} params.teams - All teams
 * @param {Object} params.fixturesByTeam - Fixtures lookup
 * @param {number} params.latestGW - Latest completed gameweek
 * @param {number} params.formFilter - Form window (0 = all time, 1-12 = last N GWs)
 * @param {number} params.maxGW - Maximum gameweek number
 * @param {string} params.positionFilter - Position filter ('ALL' | 'DEF' | 'MID' | 'FWD')
 * @param {Object} params.positionGoalsRaw - Raw position goals lookup (optional)
 * @returns {Object} Cumulative goals by team code
 */
export const calculateCumulativeGoals = ({
    teams,
    fixturesByTeam,
    latestGW,
    formFilter = 0,
    maxGW = CONFIG.UI.MAX_GW,
    positionFilter = 'ALL',
    positionGoalsRaw = {}
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
            if (!fix || !fix.finished) continue;

            // Pull goals from positionGoalsRaw if a position is selected
            let goalsFor = 0;
            let goalsAgainst = 0;

            if (!positionFilter || positionFilter === 'ALL') {
                // Original behaviour – all goals
                goalsFor = fix.goalsFor || 0;
                goalsAgainst = fix.goalsAgainst || 0;
            } else {
                const teamPosGw =
                    positionGoalsRaw[teamCode] &&
                    positionGoalsRaw[teamCode][w] &&
                    positionGoalsRaw[teamCode][w][positionFilter];

                if (teamPosGw) {
                    goalsFor = teamPosGw.for || 0;
                    goalsAgainst = teamPosGw.against || 0;
                } else {
                    goalsFor = 0;
                    goalsAgainst = 0;
                }
            }

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
