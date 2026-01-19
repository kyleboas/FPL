/**
 * FPL Chip Strategy Planner
 * Analyzes your team and recommends optimal chip usage timing
 */

import {
    CONFIG,
    getVal,
    loadAllData,
    deriveArchetype,
    processProbabilities,
    processGoalsData,
    buildFixturesLookup,
    getColorForValue,
    getTextColor,
    fetchFPLTeam
} from './modules/index.js';

import {
    analyzeChipStrategy,
    calculateFixtureDifficulty,
    analyzeTeamCoverage,
    findWeakCoverage
} from './modules/chip-planner.js';

// Application State
const STATE = {
    data: {
        players: [],
        teams: [],
        stats: [],
        fixtures: [],
        myPlayers: [],
        positionOverrides: []
    },
    lookups: {
        playersById: {},
        teamsById: {},
        teamsByCode: {},
        fixturesByTeam: {},
        probabilities: {},
        playerStatsByGW: {},
        positionOverrides: {},
        teamGoals: {}
    },
    ui: {
        analysisWeeks: 10,
        formWindow: 6
    },
    fplTeamId: null,
    latestGW: 0,
    analysis: null
};

// ==========================================
// DATA PROCESSING
// ==========================================

function processData() {
    STATE.lookups.playersById = {};
    STATE.data.players.forEach(p => {
        const pid = getVal(p, 'player_id', 'id');
        if (pid != null) {
            STATE.lookups.playersById[pid] = p;
        }
    });

    STATE.lookups.teamsById = {};
    STATE.data.teams.forEach(t => STATE.lookups.teamsById[t.id] = t);

    STATE.lookups.teamsByCode = {};
    STATE.data.teams.forEach(t => STATE.lookups.teamsByCode[t.code] = t);

    STATE.lookups.positionOverrides = {};
    STATE.data.positionOverrides?.forEach(row => {
        const pid = getVal(row, 'player_id', 'id');
        const pos = getVal(row, 'actual_position', 'position');
        if (pid != null && pos) {
            STATE.lookups.positionOverrides[pid] = pos;
        }
    });

    STATE.lookups.fixturesByTeam = buildFixturesLookup({
        fixtures: STATE.data.fixtures,
        teams: STATE.data.teams
    });

    STATE.lookups.playerStatsByGW = {};
    STATE.data.stats.forEach(s => {
        const pid = getVal(s, 'player_id', 'element', 'id');
        const gw = getVal(s, 'gw', 'gameweek', 'event');
        if (pid != null && gw != null) {
            if (!STATE.lookups.playerStatsByGW[pid]) {
                STATE.lookups.playerStatsByGW[pid] = {};
            }
            STATE.lookups.playerStatsByGW[pid][gw] = s;
        }
    });

    STATE.lookups.probabilities = processProbabilities({
        stats: STATE.data.stats,
        teams: STATE.data.teams,
        playersById: STATE.lookups.playersById,
        fixturesByTeam: STATE.lookups.fixturesByTeam,
        teamsById: STATE.lookups.teamsById,
        teamsByCode: STATE.lookups.teamsByCode,
        positionOverrides: STATE.lookups.positionOverrides
    });

    const goalsResult = processGoalsData({
        fixtures: STATE.data.fixtures,
        teams: STATE.data.teams,
        fixturesByTeam: STATE.lookups.fixturesByTeam
    });
    STATE.lookups.teamGoals = goalsResult.teamGoals;
    STATE.latestGW = goalsResult.latestGW;

    console.log('=== Data Processing Complete ===');
}

// ==========================================
// CHIP ANALYSIS
// ==========================================

function performChipAnalysis() {
    const { myPlayers } = STATE.data;
    const { playersById, fixturesByTeam, teamsById, teamsByCode, teamGoals } = STATE.lookups;
    const { analysisWeeks, formWindow } = STATE.ui;

    if (myPlayers.length === 0) {
        return null;
    }

    const startGW = STATE.latestGW + 1;
    const endGW = Math.min(startGW + analysisWeeks - 1, 38);

    // Get team codes from my players
    const myTeamCodes = new Set();
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
        if (teamCode) {
            myTeamCodes.add(teamCode);
        }
    });

    // Calculate fixture difficulty
    const fixtureDifficulty = calculateFixtureDifficulty({
        teamGoals,
        fixturesByTeam,
        teamsByCode,
        startGW,
        endGW
    });

    // Analyze team coverage
    const coverage = analyzeTeamCoverage({
        myPlayers,
        playersById,
        teamsById,
        teamsByCode,
        fixtureDifficulty,
        startGW,
        endGW
    });

    // Find weak coverage
    const weaknesses = findWeakCoverage({
        coverage,
        fixtureDifficulty,
        myTeamCodes: Array.from(myTeamCodes),
        startGW,
        endGW
    });

    // Analyze chip strategy
    const chipRecommendations = analyzeChipStrategy({
        fixtureDifficulty,
        coverage,
        weaknesses,
        myTeamCodes: Array.from(myTeamCodes),
        startGW,
        endGW,
        latestGW: STATE.latestGW
    });

    return {
        fixtureDifficulty,
        coverage,
        weaknesses,
        chipRecommendations,
        startGW,
        endGW
    };
}

// ==========================================
// RENDERING
// ==========================================

function renderTeamCoverage() {
    const analysis = STATE.analysis;
    if (!analysis) return;

    const container = document.getElementById('team-coverage-content');
    const { coverage } = analysis;

    let html = '<div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 16px;">';

    Object.entries(coverage).forEach(([teamCode, data]) => {
        const team = STATE.lookups.teamsByCode[teamCode];
        const teamName = team?.short_name || team?.name || teamCode;

        html += `
            <div style="padding: 12px; background: #2a2a2a; border-radius: 8px;">
                <div style="font-weight: bold; margin-bottom: 8px;">${teamName}</div>
                <div style="font-size: 0.9em; color: #888;">
                    Players: ${data.playerCount}<br>
                    Avg FDR: ${data.avgDifficulty.toFixed(2)}
                </div>
            </div>
        `;
    });

    html += '</div>';
    container.innerHTML = html;
    document.getElementById('team-summary').style.display = 'block';
}

function renderChipRecommendations() {
    const analysis = STATE.analysis;
    if (!analysis) return;

    const container = document.getElementById('chip-cards-container');
    const { chipRecommendations } = analysis;

    const chips = [
        { key: 'freeHit', name: 'Free Hit', emoji: '🎯', color: '#4CAF50' },
        { key: 'wildcard', name: 'Wildcard', emoji: '🃏', color: '#2196F3' },
        { key: 'benchBoost', name: 'Bench Boost', emoji: '⚡', color: '#FF9800' }
    ];

    let html = '<div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 20px;">';

    chips.forEach(chip => {
        const rec = chipRecommendations[chip.key];
        if (!rec) return;

        const confidenceColor = rec.confidence > 0.7 ? '#4CAF50' : rec.confidence > 0.4 ? '#FF9800' : '#f44336';

        html += `
            <div style="padding: 20px; background: #2a2a2a; border-radius: 12px; border-top: 4px solid ${chip.color};">
                <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 16px;">
                    <span style="font-size: 2em;">${chip.emoji}</span>
                    <div>
                        <div style="font-size: 1.2em; font-weight: bold;">${chip.name}</div>
                        <div style="font-size: 0.9em; color: ${confidenceColor};">
                            Confidence: ${(rec.confidence * 100).toFixed(0)}%
                        </div>
                    </div>
                </div>
                <div style="font-size: 1.1em; margin-bottom: 12px;">
                    <strong>Best Gameweek: ${rec.bestGameweek}</strong>
                </div>
                <div style="font-size: 0.9em; color: #ccc; line-height: 1.6;">
                    ${rec.reasoning}
                </div>
            </div>
        `;
    });

    html += '</div>';
    container.innerHTML = html;
    document.getElementById('chip-recommendations').style.display = 'block';
}

function renderFixtureDifficultyTable() {
    const analysis = STATE.analysis;
    if (!analysis) return;

    const { fixtureDifficulty, startGW, endGW } = analysis;
    const { playersById, teamsByCode } = STATE.lookups;
    const { myPlayers } = STATE.data;

    // Get unique team codes from my players
    const myTeamCodes = new Set();
    myPlayers.forEach(playerId => {
        const player = playersById[playerId];
        if (!player) return;

        const teamRef = getVal(player, 'team', 'team_id', 'teamid', 'team_code');
        let teamCode;
        if (teamsByCode[teamRef]) {
            teamCode = teamRef;
        } else if (STATE.lookups.teamsById[teamRef]) {
            teamCode = STATE.lookups.teamsById[teamRef].code;
        }
        if (teamCode) {
            myTeamCodes.add(teamCode);
        }
    });

    const gameweeks = [];
    for (let gw = startGW; gw <= endGW; gw++) {
        gameweeks.push(gw);
    }

    // Header
    let headerHtml = '<tr><th>Team</th>';
    gameweeks.forEach(gw => {
        headerHtml += `<th>GW${gw}</th>`;
    });
    headerHtml += '<th>Avg FDR</th></tr>';

    // Body
    let bodyHtml = '';

    // Sort teams - my teams first, then by average difficulty
    const sortedTeams = Object.entries(fixtureDifficulty).sort((a, b) => {
        const aInTeam = myTeamCodes.has(a[0]);
        const bInTeam = myTeamCodes.has(b[0]);

        if (aInTeam && !bInTeam) return -1;
        if (!aInTeam && bInTeam) return 1;

        return a[1].avgDifficulty - b[1].avgDifficulty;
    });

    sortedTeams.forEach(([teamCode, data]) => {
        const team = teamsByCode[teamCode];
        const teamName = team?.short_name || team?.name || teamCode;
        const inMyTeam = myTeamCodes.has(teamCode);

        bodyHtml += `<tr style="${inMyTeam ? 'background: rgba(76, 175, 80, 0.1);' : ''}">`;
        bodyHtml += `<td style="font-weight: ${inMyTeam ? 'bold' : 'normal'};">${teamName}${inMyTeam ? ' ✓' : ''}</td>`;

        gameweeks.forEach(gw => {
            const fixture = data.fixtures[gw];
            if (!fixture) {
                bodyHtml += '<td style="background: #333;">-</td>';
            } else {
                const color = getColorForValue(fixture.difficulty, 2, 4, true); // Inverted: lower is better
                const textColor = getTextColor(color);
                const oppTeam = teamsByCode[fixture.opponent];
                const oppName = oppTeam?.short_name || oppTeam?.name || fixture.opponent;

                bodyHtml += `<td style="background: ${color}; color: ${textColor};" title="${oppName} (${fixture.venue}), FDR: ${fixture.difficulty.toFixed(2)}">`;
                bodyHtml += `${oppName.substring(0, 3)}(${fixture.venue})`;
                bodyHtml += '</td>';
            }
        });

        const avgColor = getColorForValue(data.avgDifficulty, 2, 4, true);
        const avgTextColor = getTextColor(avgColor);
        bodyHtml += `<td style="background: ${avgColor}; color: ${avgTextColor}; font-weight: bold;">${data.avgDifficulty.toFixed(2)}</td>`;
        bodyHtml += '</tr>';
    });

    document.getElementById('fixture-header').innerHTML = headerHtml;
    document.getElementById('fixture-body').innerHTML = bodyHtml;
    document.getElementById('fixture-difficulty').style.display = 'block';
}

function renderWeaknessAnalysis() {
    const analysis = STATE.analysis;
    if (!analysis) return;

    const container = document.getElementById('weakness-content');
    const { weaknesses } = analysis;

    if (weaknesses.length === 0) {
        container.innerHTML = '<p style="color: #4CAF50;">Your team has good coverage across all fixtures!</p>';
    } else {
        let html = '<div style="line-height: 1.8;">';
        html += '<p style="margin-bottom: 16px; color: #888;">Teams with easy fixtures that you don\'t have players from:</p>';

        weaknesses.forEach(weakness => {
            const team = STATE.lookups.teamsByCode[weakness.teamCode];
            const teamName = team?.short_name || team?.name || weakness.teamCode;

            html += `
                <div style="padding: 12px; background: #2a2a2a; border-radius: 8px; margin-bottom: 8px; border-left: 4px solid #FF9800;">
                    <strong>${teamName}</strong> - FDR: ${weakness.avgDifficulty.toFixed(2)} (GW${weakness.gameweeks.join(', GW')})
                    <br>
                    <span style="color: #888; font-size: 0.9em;">${weakness.reason}</span>
                </div>
            `;
        });

        html += '</div>';
        container.innerHTML = html;
    }

    document.getElementById('weakness-analysis').style.display = 'block';
}

function renderAllAnalysis() {
    renderTeamCoverage();
    renderChipRecommendations();
    renderFixtureDifficultyTable();
    renderWeaknessAnalysis();
}

// ==========================================
// EVENT HANDLERS
// ==========================================

async function handleLoadTeam() {
    const teamIdInput = document.getElementById('team-id');
    const loadBtn = document.getElementById('load-team');
    const teamId = teamIdInput.value.trim();

    if (!teamId) {
        alert('Please enter your FPL Team ID');
        return;
    }

    loadBtn.disabled = true;
    loadBtn.textContent = 'Analyzing...';

    try {
        const { playerIds, eventId } = await fetchFPLTeam(teamId);
        STATE.fplTeamId = teamId;
        STATE.data.myPlayers = playerIds;

        document.getElementById('status-bar').textContent =
            `Analyzing ${playerIds.length} players from Team ${teamId} (GW${eventId})`;

        // Perform analysis
        STATE.analysis = performChipAnalysis();

        if (STATE.analysis) {
            renderAllAnalysis();
            document.getElementById('status-bar').textContent =
                `Analysis complete! Showing recommendations for GW${STATE.analysis.startGW}-${STATE.analysis.endGW}`;
        } else {
            document.getElementById('status-bar').textContent = 'Unable to generate analysis. Please try again.';
        }
    } catch (error) {
        console.error('Load team error:', error);
        const errMsg = error.message || error.toString() || 'Unknown error';
        document.getElementById('status-bar').textContent = `Error: ${errMsg}`;
    } finally {
        loadBtn.disabled = false;
        loadBtn.textContent = 'Analyze My Team';
    }
}

function handleAnalysisWeeksChange() {
    const value = parseInt(document.getElementById('analysis-weeks').value);
    if (!isNaN(value) && value >= 5 && value <= 15) {
        STATE.ui.analysisWeeks = value;
        if (STATE.data.myPlayers.length > 0) {
            STATE.analysis = performChipAnalysis();
            renderAllAnalysis();
        }
    }
}

function handleFormWindowChange() {
    const value = parseInt(document.getElementById('form-window').value);
    if (!isNaN(value) && value >= 3 && value <= 10) {
        STATE.ui.formWindow = value;
        if (STATE.data.myPlayers.length > 0) {
            STATE.analysis = performChipAnalysis();
            renderAllAnalysis();
        }
    }
}

// ==========================================
// INITIALIZATION
// ==========================================

async function init() {
    const loadingDiv = document.getElementById('loading');
    const errorDiv = document.getElementById('error');
    const mainDiv = document.getElementById('main-content');

    try {
        loadingDiv.style.display = 'block';

        const allData = await loadAllData();
        STATE.data = allData;

        processData();

        loadingDiv.style.display = 'none';
        mainDiv.style.display = 'block';

        // Setup event listeners
        document.getElementById('load-team').addEventListener('click', handleLoadTeam);
        document.getElementById('analysis-weeks').addEventListener('change', handleAnalysisWeeksChange);
        document.getElementById('form-window').addEventListener('change', handleFormWindowChange);

        // Check for saved team ID
        const savedTeamId = localStorage.getItem('fpl-team-id');
        if (savedTeamId) {
            document.getElementById('team-id').value = savedTeamId;
        }

        // Save team ID on input
        document.getElementById('team-id').addEventListener('input', (e) => {
            if (e.target.value.trim()) {
                localStorage.setItem('fpl-team-id', e.target.value.trim());
            }
        });

        console.log('=== Chip Strategy Planner Initialized ===');
    } catch (error) {
        console.error('Initialization error:', error);
        loadingDiv.style.display = 'none';
        errorDiv.textContent = `Error: ${error.message || error.toString()}`;
        errorDiv.style.display = 'block';
    }
}

init();
