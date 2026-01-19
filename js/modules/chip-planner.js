/**
 * Chip Strategy Planning Module
 * Contains logic for analyzing fixtures, team coverage, and recommending chip usage
 */

import { getVal } from './utils.js';

/**
 * Calculate Fixture Difficulty Rating (FDR) for all teams
 * Lower FDR = easier fixture (good for attackers)
 * Higher FDR = harder fixture (bad for attackers, but good for defenders facing them)
 *
 * @param {Object} params
 * @returns {Object} - { [teamCode]: { fixtures: {}, avgDifficulty: number } }
 */
export function calculateFixtureDifficulty({
    teamGoals,
    fixturesByTeam,
    teamsByCode,
    startGW,
    endGW
}) {
    const result = {};

    Object.keys(fixturesByTeam).forEach(teamCode => {
        const teamFixtures = fixturesByTeam[teamCode];
        const fixtures = {};
        let totalDifficulty = 0;
        let count = 0;

        for (let gw = startGW; gw <= endGW; gw++) {
            const fixture = teamFixtures[gw];
            if (!fixture || fixture.finished) continue;

            const oppCode = fixture.opponentCode;
            const venue = fixture.wasHome ? 'H' : 'A';

            // Calculate difficulty based on opponent's defensive strength
            // and attacking threat
            const oppVenueKey = fixture.wasHome ? 'away' : 'home';
            const oppGoalsData = teamGoals[oppCode]?.[oppVenueKey] || {};
            const oppGoalsArr = Object.values(oppGoalsData);

            let difficulty = 3; // Default medium difficulty

            if (oppGoalsArr.length > 0) {
                // Opponent's goals against (lower = harder to score against them)
                const oppGoalsAgainst = oppGoalsArr.reduce((sum, g) => sum + (g.against || 0), 0) / oppGoalsArr.length;
                // Opponent's goals for (higher = more dangerous opponent)
                const oppGoalsFor = oppGoalsArr.reduce((sum, g) => sum + (g.for || 0), 0) / oppGoalsArr.length;

                // FDR calculation:
                // - If opponent concedes few goals, difficulty is higher
                // - If opponent scores many goals, difficulty is higher (for defenders)
                // Weight defensive strength more for attackers
                difficulty = (5 - oppGoalsAgainst) * 0.7 + (oppGoalsFor * 0.3);

                // Clamp between 1 and 5
                difficulty = Math.max(1, Math.min(5, difficulty));
            }

            fixtures[gw] = {
                opponent: oppCode,
                venue,
                difficulty,
                oppGoalsFor: oppGoalsArr.length > 0
                    ? oppGoalsArr.reduce((sum, g) => sum + (g.for || 0), 0) / oppGoalsArr.length
                    : 0,
                oppGoalsAgainst: oppGoalsArr.length > 0
                    ? oppGoalsArr.reduce((sum, g) => sum + (g.against || 0), 0) / oppGoalsArr.length
                    : 0
            };

            totalDifficulty += difficulty;
            count++;
        }

        result[teamCode] = {
            fixtures,
            avgDifficulty: count > 0 ? totalDifficulty / count : 3,
            fixtureCount: count
        };
    });

    return result;
}

/**
 * Analyze team coverage - which teams do you have players from
 *
 * @param {Object} params
 * @returns {Object} - { [teamCode]: { playerCount: number, players: [], avgDifficulty: number } }
 */
export function analyzeTeamCoverage({
    myPlayers,
    playersById,
    teamsById,
    teamsByCode,
    fixtureDifficulty,
    startGW,
    endGW
}) {
    const coverage = {};

    myPlayers.forEach(playerId => {
        const player = playersById[playerId];
        if (!player) return;

        const teamRef = getVal(player, 'team', 'team_id', 'teamid', 'team_code');
        let teamCode;

        if (teamsByCode[teamRef]) {
            teamCode = teamRef;
        } else if (teamsById[teamRef]) {
            teamCode = teamsById[teamRef].code;
        }

        if (!teamCode) return;

        if (!coverage[teamCode]) {
            coverage[teamCode] = {
                playerCount: 0,
                players: [],
                avgDifficulty: fixtureDifficulty[teamCode]?.avgDifficulty || 3
            };
        }

        coverage[teamCode].playerCount++;
        coverage[teamCode].players.push({
            id: playerId,
            name: getVal(player, 'name', 'web_name', 'full_name') || 'Unknown'
        });
    });

    return coverage;
}

/**
 * Find teams with good fixtures that you don't have coverage on
 *
 * @param {Object} params
 * @returns {Array} - Array of weakness objects
 */
export function findWeakCoverage({
    coverage,
    fixtureDifficulty,
    myTeamCodes,
    startGW,
    endGW
}) {
    const weaknesses = [];

    // Find teams with good fixtures (low FDR) that we don't have
    Object.entries(fixtureDifficulty).forEach(([teamCode, data]) => {
        // Skip teams we already have
        if (myTeamCodes.includes(teamCode)) return;

        // Only consider teams with good fixtures (FDR < 3)
        if (data.avgDifficulty >= 3) return;

        // Find specific good gameweeks
        const goodGameweeks = [];
        Object.entries(data.fixtures).forEach(([gw, fixture]) => {
            if (fixture.difficulty < 3) {
                goodGameweeks.push(parseInt(gw));
            }
        });

        if (goodGameweeks.length >= 2) {
            weaknesses.push({
                teamCode,
                avgDifficulty: data.avgDifficulty,
                gameweeks: goodGameweeks,
                reason: `${goodGameweeks.length} easy fixtures in your analysis window`
            });
        }
    });

    // Sort by difficulty (easiest first)
    weaknesses.sort((a, b) => a.avgDifficulty - b.avgDifficulty);

    return weaknesses.slice(0, 8); // Top 8 weaknesses
}

/**
 * Analyze chip strategy and recommend optimal timing
 *
 * @param {Object} params
 * @returns {Object} - Chip recommendations
 */
export function analyzeChipStrategy({
    fixtureDifficulty,
    coverage,
    weaknesses,
    myTeamCodes,
    startGW,
    endGW,
    latestGW
}) {
    // Find best gameweeks for each chip

    // 1. FREE HIT - Best used when:
    //    - Multiple good teams have great fixtures
    //    - You don't have players from those teams
    //    - Single gameweek with concentrated opportunity
    const freeHitAnalysis = analyzeFreeHit({
        fixtureDifficulty,
        myTeamCodes,
        weaknesses,
        startGW,
        endGW
    });

    // 2. WILDCARD - Best used when:
    //    - Multiple teams have sustained good fixtures
    //    - Need to restructure team for upcoming run
    //    - Before a good fixture swing
    const wildcardAnalysis = analyzeWildcard({
        fixtureDifficulty,
        coverage,
        weaknesses,
        startGW,
        endGW
    });

    // 3. BENCH BOOST - Best used when:
    //    - All teams (including bench) have good fixtures
    //    - Low blank/double gameweek risk
    //    - Your full squad has favorable matchups
    const benchBoostAnalysis = analyzeBenchBoost({
        fixtureDifficulty,
        coverage,
        myTeamCodes,
        startGW,
        endGW
    });

    return {
        freeHit: freeHitAnalysis,
        wildcard: wildcardAnalysis,
        benchBoost: benchBoostAnalysis
    };
}

/**
 * Analyze best gameweek for Free Hit
 */
function analyzeFreeHit({ fixtureDifficulty, myTeamCodes, weaknesses, startGW, endGW }) {
    const gwScores = {};

    // Score each gameweek based on opportunity
    for (let gw = startGW; gw <= endGW; gw++) {
        let easyFixtures = 0;
        let missedOpportunities = 0;

        Object.entries(fixtureDifficulty).forEach(([teamCode, data]) => {
            const fixture = data.fixtures[gw];
            if (!fixture) return;

            if (fixture.difficulty < 2.5) {
                easyFixtures++;
                if (!myTeamCodes.includes(teamCode)) {
                    missedOpportunities++;
                }
            }
        });

        // Score = number of easy fixtures you're missing
        gwScores[gw] = {
            score: missedOpportunities,
            easyFixtures,
            missedOpportunities
        };
    }

    // Find best gameweek
    let bestGW = startGW;
    let bestScore = 0;

    Object.entries(gwScores).forEach(([gw, data]) => {
        if (data.score > bestScore) {
            bestScore = data.score;
            bestGW = parseInt(gw);
        }
    });

    const confidence = Math.min(bestScore / 8, 1); // 8+ missed opportunities = 100% confidence

    return {
        bestGameweek: bestGW,
        confidence,
        reasoning: `GW${bestGW} has ${gwScores[bestGW].missedOpportunities} easy fixtures from teams you don't own, out of ${gwScores[bestGW].easyFixtures} total easy fixtures. This represents the best opportunity to bring in template players for a single gameweek.`
    };
}

/**
 * Analyze best gameweek for Wildcard
 */
function analyzeWildcard({ fixtureDifficulty, coverage, weaknesses, startGW, endGW }) {
    // Look for a gameweek before a good run of fixtures
    // Wildcard is best used to set up for 3-5 gameweek runs

    const gwScores = {};

    for (let gw = startGW; gw <= endGW - 3; gw++) {
        // Look at next 4 gameweeks after this one
        let avgDifficultyNext4 = 0;
        let teamsWithGoodRun = 0;

        Object.entries(fixtureDifficulty).forEach(([teamCode, data]) => {
            let teamDifficulty = 0;
            let count = 0;

            for (let futureGW = gw + 1; futureGW <= Math.min(gw + 4, endGW); futureGW++) {
                const fixture = data.fixtures[futureGW];
                if (fixture) {
                    teamDifficulty += fixture.difficulty;
                    count++;
                }
            }

            if (count > 0) {
                const avgTeamDiff = teamDifficulty / count;
                avgDifficultyNext4 += avgTeamDiff;
                if (avgTeamDiff < 2.8) {
                    teamsWithGoodRun++;
                }
            }
        });

        gwScores[gw] = {
            score: teamsWithGoodRun,
            avgDifficulty: avgDifficultyNext4 / Object.keys(fixtureDifficulty).length
        };
    }

    // Find best gameweek (most teams with good runs)
    let bestGW = startGW;
    let bestScore = 0;

    Object.entries(gwScores).forEach(([gw, data]) => {
        if (data.score > bestScore) {
            bestScore = data.score;
            bestGW = parseInt(gw);
        }
    });

    const confidence = Math.min(bestScore / 12, 1); // 12+ teams with good runs = 100% confidence

    return {
        bestGameweek: bestGW,
        confidence,
        reasoning: `Use Wildcard before GW${bestGW} to set up for a favorable run. ${gwScores[bestGW].score} teams have good fixtures in the following 4 gameweeks, allowing you to restructure your squad for sustained returns.`
    };
}

/**
 * Analyze best gameweek for Bench Boost
 */
function analyzeBenchBoost({ fixtureDifficulty, coverage, myTeamCodes, startGW, endGW }) {
    const gwScores = {};

    // Bench Boost works best when YOUR teams all have good fixtures
    for (let gw = startGW; gw <= endGW; gw++) {
        let totalDifficulty = 0;
        let count = 0;
        let goodFixtures = 0;

        myTeamCodes.forEach(teamCode => {
            const data = fixtureDifficulty[teamCode];
            if (!data) return;

            const fixture = data.fixtures[gw];
            if (fixture) {
                totalDifficulty += fixture.difficulty;
                count++;
                if (fixture.difficulty < 3) {
                    goodFixtures++;
                }
            }
        });

        const avgDifficulty = count > 0 ? totalDifficulty / count : 5;

        gwScores[gw] = {
            score: goodFixtures,
            avgDifficulty,
            fixtureCount: count
        };
    }

    // Find best gameweek (most of your teams have good fixtures)
    let bestGW = startGW;
    let bestScore = 0;
    let bestAvgDiff = 5;

    Object.entries(gwScores).forEach(([gw, data]) => {
        // Prefer more good fixtures, and lower average difficulty as tiebreaker
        if (data.score > bestScore || (data.score === bestScore && data.avgDifficulty < bestAvgDiff)) {
            bestScore = data.score;
            bestAvgDiff = data.avgDifficulty;
            bestGW = parseInt(gw);
        }
    });

    const confidence = Math.min(bestScore / myTeamCodes.length, 1);

    return {
        bestGameweek: bestGW,
        confidence,
        reasoning: `GW${bestGW} has the best fixture spread for your current team. ${bestScore} of your ${myTeamCodes.length} teams have favorable matchups (FDR < 3), with an average FDR of ${bestAvgDiff.toFixed(2)}. Your bench players should have good opportunities to return.`
    };
}
