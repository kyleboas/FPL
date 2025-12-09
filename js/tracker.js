/**
 * FPL Team Tracker
 * Track your FPL players with DEFCON and Goals analysis using ES6 modules
 */

import {
    CONFIG,
    getVal,
    parseExcludedGWs,
    loadAllData,
    deriveArchetype,
    processProbabilities,
    processGoalsData,
    buildFixturesLookup,
    getColorForValue,
    getTextColor,
    fetchFPLTeam
} from './modules/index.js';

// Application State
const STATE = {
    data: {
        players: [],
        teams: [],
        stats: [],
        fixtures: [],
        myPlayers: [],
        watchlist: [],
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
        startGW: 1,
        endGW: 6,
        excludedGWs: [],
        sortMode: {
            type: 'defcon',
            direction: 'desc',
            gw: null
        },
        viewMode: 'team'
    },
    fplTeamId: null,
    latestGW: 0
};

// ==========================================
// WATCHLIST MANAGEMENT
// ==========================================

const WATCHLIST_STORAGE_KEY = 'fpl-tracker-watchlist';

function loadWatchlist() {
    try {
        const stored = localStorage.getItem(WATCHLIST_STORAGE_KEY);
        if (stored) {
            const parsed = JSON.parse(stored);
            STATE.data.watchlist = Array.isArray(parsed) ? parsed : [];
        } else {
            STATE.data.watchlist = [];
        }
    } catch (e) {
        console.error('Error loading watchlist:', e);
        STATE.data.watchlist = [];
    }
}

function saveWatchlist() {
    try {
        localStorage.setItem(WATCHLIST_STORAGE_KEY, JSON.stringify(STATE.data.watchlist));
    } catch (e) {
        console.error('Error saving watchlist:', e);
    }
}

function addToWatchlist(playerId) {
    if (!STATE.data.watchlist.includes(playerId)) {
        STATE.data.watchlist.push(playerId);
        saveWatchlist();
        renderTable();
    }
}

function removeFromWatchlist(playerId) {
    const index = STATE.data.watchlist.indexOf(playerId);
    if (index > -1) {
        STATE.data.watchlist.splice(index, 1);
        saveWatchlist();
        renderTable();
    }
}

function clearWatchlist() {
    if (STATE.data.watchlist.length === 0) return;

    if (confirm(`Remove all ${STATE.data.watchlist.length} players from watchlist?`)) {
        STATE.data.watchlist = [];
        saveWatchlist();
        renderTable();
    }
}

function isInWatchlist(playerId) {
    return STATE.data.watchlist.includes(playerId);
}

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
// RENDERING
// ==========================================

function calculatePlayerStats(player) {
    const pid = getVal(player, 'player_id', 'id');
    const playerStats = STATE.lookups.playerStatsByGW[pid] || {};

    let totalPoints = 0;
    let totalMinutes = 0;

    Object.values(playerStats).forEach(stat => {
        totalPoints += getVal(stat, 'total_points', 'points') || 0;
        totalMinutes += getVal(stat, 'minutes', 'minutes_played') || 0;
    });

    const pointsPer90 = totalMinutes > 0 ? ((totalPoints / totalMinutes) * 90).toFixed(2) : '0.00';

    return { totalPoints, pointsPer90 };
}

function renderTable() {
    const { myPlayers, watchlist } = STATE.data;
    const { playersById, fixturesByTeam, teamsById, teamsByCode, probabilities, teamGoals } = STATE.lookups;
    const { startGW, endGW, excludedGWs, sortMode, viewMode } = STATE.ui;

    let displayPlayerIds = [];
    if (viewMode === 'team') {
        displayPlayerIds = myPlayers;
    } else if (viewMode === 'watchlist') {
        displayPlayerIds = watchlist;
    } else {
        displayPlayerIds = [...new Set([...myPlayers, ...watchlist])];
    }

    if (displayPlayerIds.length === 0) {
        let message = 'No players to display. ';
        if (viewMode === 'team') {
            message += 'Enter your FPL Team ID and click "Load My Team".';
        } else if (viewMode === 'watchlist') {
            message += 'Search for players to add to your watchlist.';
        } else {
            message += 'Load your team or add players to watchlist.';
        }
        document.getElementById('status-bar').textContent = message;
        document.getElementById('fixture-header').innerHTML = '';
        document.getElementById('fixture-body').innerHTML = '';
        return;
    }

    const gameweeks = [];
    for (let gw = startGW; gw <= endGW; gw++) {
        if (!excludedGWs.includes(gw)) {
            gameweeks.push(gw);
        }
    }

    const playerRows = displayPlayerIds.map(playerId => {
        const player = playersById[playerId];
        if (!player) return null;

        const playerName = getVal(player, 'name', 'web_name', 'full_name') || 'Unknown';
        const teamRef = getVal(player, 'team', 'team_id', 'teamid', 'team_code');
        const inTeam = myPlayers.includes(playerId);
        const inWatchlist = watchlist.includes(playerId);

        let teamCode, teamName;
        if (teamsByCode[teamRef]) {
            teamCode = teamRef;
            teamName = teamsByCode[teamRef].short_name || teamsByCode[teamRef].name;
        } else if (teamsById[teamRef]) {
            teamCode = teamsById[teamRef].code;
            teamName = teamsById[teamRef].short_name || teamsById[teamRef].name;
        } else {
            teamCode = null;
            teamName = 'Unknown';
        }

        const archetype = deriveArchetype(player, STATE.lookups.positionOverrides);
        const { totalPoints, pointsPer90 } = calculatePlayerStats(player);

        let defconSum = 0, defconCount = 0;
        let goalsForSum = 0, goalsAgainstSum = 0, goalsCount = 0;

        const gwData = gameweeks.map(gw => {
            const fixture = teamCode ? fixturesByTeam[teamCode]?.[gw] : null;
            if (!fixture) return { gw, hasFixture: false };

            const oppCode = fixture.opponentCode;
            const oppTeam = teamsByCode[oppCode];
            const oppShortName = oppTeam?.short_name || oppTeam?.name || 'UNK';
            const venueKey = fixture.wasHome ? 'home' : 'away';
            const venueLabel = fixture.wasHome ? 'H' : 'A';

            let defconProb = 0;
            if (archetype && probabilities[oppCode]?.[String(fixture.wasHome)]?.[archetype]) {
                defconProb = probabilities[oppCode][String(fixture.wasHome)][archetype] * 100;
                defconSum += defconProb;
                defconCount++;
            }

            const oppGoalsData = teamGoals[oppCode]?.[venueKey === 'home' ? 'away' : 'home'] || {};
            const oppGoalsArr = Object.values(oppGoalsData);
            const oppGoalsFor = oppGoalsArr.length > 0
                ? oppGoalsArr.reduce((sum, g) => sum + (g.for || 0), 0) / oppGoalsArr.length
                : 0;
            const oppGoalsAgainst = oppGoalsArr.length > 0
                ? oppGoalsArr.reduce((sum, g) => sum + (g.against || 0), 0) / oppGoalsArr.length
                : 0;

            if (oppGoalsArr.length > 0) {
                goalsForSum += oppGoalsFor;
                goalsAgainstSum += oppGoalsAgainst;
                goalsCount++;
            }

            return {
                gw,
                hasFixture: true,
                oppShortName,
                venueLabel,
                defconProb,
                goalsFor: oppGoalsFor,
                goalsAgainst: oppGoalsAgainst
            };
        });

        return {
            player,
            playerId,
            playerName,
            teamName,
            totalPoints,
            pointsPer90,
            archetype,
            gwData,
            avgDefcon: defconCount > 0 ? defconSum / defconCount : 0,
            avgGoalsFor: goalsCount > 0 ? goalsForSum / goalsCount : 0,
            avgGoalsAgainst: goalsCount > 0 ? goalsAgainstSum / goalsCount : 0,
            inTeam,
            inWatchlist
        };
    }).filter(row => row !== null);

    // Sort rows
    playerRows.sort((a, b) => {
        let aVal, bVal;

        if (sortMode.type === 'column' && sortMode.gw !== null) {
            const aGW = a.gwData.find(g => g.gw === sortMode.gw);
            const bGW = b.gwData.find(g => g.gw === sortMode.gw);
            aVal = aGW?.defconProb || 0;
            bVal = bGW?.defconProb || 0;
        } else if (sortMode.type === 'defcon') {
            aVal = a.avgDefcon;
            bVal = b.avgDefcon;
        } else if (sortMode.type === 'goals-for') {
            aVal = a.avgGoalsFor;
            bVal = b.avgGoalsFor;
        } else if (sortMode.type === 'goals-against') {
            aVal = a.avgGoalsAgainst;
            bVal = b.avgGoalsAgainst;
        } else {
            return a.playerName.localeCompare(b.playerName);
        }

        return sortMode.direction === 'desc' ? bVal - aVal : aVal - bVal;
    });

    const maxDefcon = Math.max(...playerRows.flatMap(r => r.gwData.map(g => g.defconProb || 0)), 1);

    const headerHTML = `
        <tr>
            <th>Player Info</th>
            ${gameweeks.map(gw => {
                const isSorted = sortMode.type === 'column' && sortMode.gw === gw;
                const sortClass = isSorted ? (sortMode.direction === 'desc' ? 'sorted-desc' : 'sorted-asc') : '';
                return `<th class="gw-header ${sortClass}" data-gw="${gw}">GW${gw}</th>`;
            }).join('')}
        </tr>
    `;

    const bodyHTML = playerRows.map(row => {
        const cells = row.gwData.map(gwInfo => {
            if (!gwInfo.hasFixture) {
                return '<td>-</td>';
            }

            const defconBg = getColorForValue(gwInfo.defconProb, maxDefcon);
            const defconColor = getTextColor(defconBg);

            return `
                <td style="background-color: ${defconBg}; color: ${defconColor};">
                    <div class="match-cell">
                        <div class="match-opp">${gwInfo.oppShortName} (${gwInfo.venueLabel})</div>
                        <div class="match-defcon">DEFCON: ${gwInfo.defconProb.toFixed(0)}%</div>
                        <div class="match-goals">GF: ${gwInfo.goalsFor.toFixed(1)} | GA: ${gwInfo.goalsAgainst.toFixed(1)}</div>
                    </div>
                </td>
            `;
        }).join('');

        let badges = '';
        if (row.inTeam) {
            badges += '<span class="player-type-badge badge-team">MY TEAM</span>';
        }
        if (row.inWatchlist) {
            badges += '<span class="player-type-badge badge-watchlist">WATCHLIST</span>';
        }

        let removeBtn = '';
        if (row.inWatchlist) {
            removeBtn = `<button class="remove" onclick="removeFromWatchlist(${row.playerId})">Remove from Watchlist</button>`;
        }

        return `
            <tr>
                <td>
                    <div class="player-info">
                        <div class="player-name">${row.playerName}${badges}</div>
                        <div class="player-meta">${row.teamName} | ID: ${row.playerId}</div>
                        <div class="player-stats">Pts: ${row.totalPoints} | Pts/90: ${row.pointsPer90}</div>
                        ${removeBtn}
                    </div>
                </td>
                ${cells}
            </tr>
        `;
    }).join('');

    document.getElementById('fixture-header').innerHTML = headerHTML;
    document.getElementById('fixture-body').innerHTML = bodyHTML;

    let statusText = `Showing ${playerRows.length} player${playerRows.length !== 1 ? 's' : ''} for GW${startGW}-${endGW}`;
    if (viewMode === 'both' && myPlayers.length > 0 && watchlist.length > 0) {
        statusText += ` (${myPlayers.length} in team, ${watchlist.length} in watchlist)`;
    } else if (viewMode === 'watchlist' && watchlist.length > 0) {
        statusText += ` in watchlist`;
    } else if (viewMode === 'team' && myPlayers.length > 0) {
        statusText += ` from your team`;
    }
    document.getElementById('status-bar').textContent = statusText;

    setupGWHeaderHandlers();
}

function setupGWHeaderHandlers() {
    document.querySelectorAll('.gw-header').forEach(header => {
        header.addEventListener('click', () => {
            const gw = parseInt(header.dataset.gw, 10);
            if (STATE.ui.sortMode.type === 'column' && STATE.ui.sortMode.gw === gw) {
                STATE.ui.sortMode.direction = STATE.ui.sortMode.direction === 'desc' ? 'asc' : 'desc';
            } else {
                STATE.ui.sortMode.type = 'column';
                STATE.ui.sortMode.gw = gw;
                STATE.ui.sortMode.direction = 'desc';
            }
            renderTable();
        });
    });
}

// ==========================================
// PLAYER SEARCH
// ==========================================

function searchPlayers(query) {
    if (!query || query.length < 2) return [];

    const lowerQuery = query.toLowerCase();
    const { playersById } = STATE.lookups;

    const results = Object.values(playersById).filter(player => {
        const name = (getVal(player, 'name', 'web_name', 'full_name') || '').toLowerCase();
        return name.includes(lowerQuery);
    });

    results.sort((a, b) => {
        const aName = (getVal(a, 'name', 'web_name', 'full_name') || '').toLowerCase();
        const bName = (getVal(b, 'name', 'web_name', 'full_name') || '').toLowerCase();

        const aStarts = aName.startsWith(lowerQuery);
        const bStarts = bName.startsWith(lowerQuery);

        if (aStarts && !bStarts) return -1;
        if (!aStarts && bStarts) return 1;
        return aName.localeCompare(bName);
    });

    return results.slice(0, 20);
}

function renderSearchResults(results) {
    const container = document.getElementById('player-search-results');

    if (results.length === 0) {
        container.style.display = 'none';
        return;
    }

    const { teamsById, teamsByCode } = STATE.lookups;

    const html = results.map(player => {
        const playerId = getVal(player, 'player_id', 'id');
        const playerName = getVal(player, 'name', 'web_name', 'full_name') || 'Unknown';
        const teamRef = getVal(player, 'team', 'team_id', 'teamid', 'team_code');

        let teamName = 'Unknown';
        if (teamsByCode[teamRef]) {
            teamName = teamsByCode[teamRef].short_name || teamsByCode[teamRef].name;
        } else if (teamsById[teamRef]) {
            teamName = teamsById[teamRef].short_name || teamsById[teamRef].name;
        }

        const archetype = deriveArchetype(player, STATE.lookups.positionOverrides) || 'N/A';
        const alreadyInWatchlist = isInWatchlist(playerId);
        const inTeam = STATE.data.myPlayers.includes(playerId);

        let badges = '';
        if (inTeam) badges += '<span class="player-type-badge badge-team" style="margin-left: 5px;">TEAM</span>';
        if (alreadyInWatchlist) badges += '<span class="player-type-badge badge-watchlist" style="margin-left: 5px;">WATCHLIST</span>';

        return `
            <div class="search-result-item" data-player-id="${playerId}">
                <div class="search-result-name">${playerName}${badges}</div>
                <div class="search-result-meta">${teamName} | ${archetype} | ID: ${playerId}</div>
            </div>
        `;
    }).join('');

    container.innerHTML = html;
    container.style.display = 'block';

    container.querySelectorAll('.search-result-item').forEach(item => {
        item.addEventListener('click', () => {
            const playerId = parseInt(item.dataset.playerId, 10);
            addToWatchlist(playerId);
            document.getElementById('player-search').value = '';
            container.style.display = 'none';
        });
    });
}

function handlePlayerSearch() {
    const query = document.getElementById('player-search').value;
    const results = searchPlayers(query);
    renderSearchResults(results);
}

// ==========================================
// EVENT HANDLERS
// ==========================================

async function handleLoadTeam() {
    const teamIdInput = document.getElementById('team-id');
    const teamId = teamIdInput.value.trim();

    if (!teamId || isNaN(teamId)) {
        showError('Please enter a valid FPL Team ID');
        return;
    }

    const loadBtn = document.getElementById('load-team');
    loadBtn.disabled = true;
    loadBtn.textContent = 'Loading...';

    try {
        const { playerIds, eventId } = await fetchFPLTeam(teamId);
        STATE.fplTeamId = teamId;
        STATE.data.myPlayers = playerIds;

        document.getElementById('status-bar').textContent =
            `Loaded ${playerIds.length} players from Team ${teamId} (GW${eventId})`;

        renderTable();
    } catch (error) {
        console.error('Load team error:', error);
        const errMsg = error.message || error.toString() || 'Unknown error';
        if (errMsg.includes('All proxies failed')) {
            showError('Failed to load team - FPL API unavailable. Please try again later.');
        } else {
            showError('Failed to load team', errMsg);
        }
    } finally {
        loadBtn.disabled = false;
        loadBtn.textContent = 'Load My Team';
    }
}

function handleFilterChange() {
    STATE.ui.startGW = parseInt(document.getElementById('gw-start').value, 10);
    STATE.ui.endGW = parseInt(document.getElementById('gw-end').value, 10);
    STATE.ui.excludedGWs = parseExcludedGWs(document.getElementById('gw-exclude').value, CONFIG.UI.MAX_GW);

    const sortBy = document.getElementById('sort-by').value;
    STATE.ui.sortMode.type = sortBy;
    STATE.ui.sortMode.direction = 'desc';
    STATE.ui.sortMode.gw = null;

    renderTable();
}

function updateViewToggleUI() {
    const buttons = {
        'team': document.getElementById('view-team'),
        'watchlist': document.getElementById('view-watchlist'),
        'both': document.getElementById('view-both')
    };

    Object.entries(buttons).forEach(([mode, btn]) => {
        if (mode === STATE.ui.viewMode) {
            btn.classList.add('active');
            btn.classList.remove('secondary');
        } else {
            btn.classList.remove('active');
            btn.classList.add('secondary');
        }
    });
}

function showError(message, details) {
    const errorEl = document.getElementById('error');
    errorEl.textContent = details ? `${message} (${details})` : message;
    errorEl.style.display = 'block';
    setTimeout(() => {
        errorEl.style.display = 'none';
    }, 5000);
}

// ==========================================
// DEFAULT GW WINDOW
// ==========================================

function applyDefaultGWWindow() {
    const startInput = document.getElementById('gw-start');
    const endInput = document.getElementById('gw-end');
    const excludeInput = document.getElementById('gw-exclude');

    // Default window: first unplayed GW (latest completed + 1) to 5 GWs after
    const nextUnplayedGW = Math.min((STATE.latestGW || 0) + 1, CONFIG.UI.MAX_GW);
    const defaultEndGW   = Math.min(nextUnplayedGW + 5, CONFIG.UI.MAX_GW);

    STATE.ui.startGW = nextUnplayedGW;
    STATE.ui.endGW   = defaultEndGW;
    STATE.ui.excludedGWs = parseExcludedGWs(excludeInput.value, CONFIG.UI.MAX_GW);

    // Reflect defaults in the inputs
    startInput.value = String(nextUnplayedGW);
    endInput.value   = String(defaultEndGW);
}

// ==========================================
// EVENT HANDLERS
// ==========================================

function setupEventListeners() {
    document.getElementById('load-team').addEventListener('click', handleLoadTeam);

    document.getElementById('gw-start').addEventListener('change', handleFilterChange);
    document.getElementById('gw-end').addEventListener('change', handleFilterChange);
    document.getElementById('gw-exclude').addEventListener('input', handleFilterChange);
    document.getElementById('sort-by').addEventListener('change', handleFilterChange);

    document.getElementById('player-search').addEventListener('input', handlePlayerSearch);

    document.getElementById('view-team').addEventListener('click', () => {
        STATE.ui.viewMode = 'team';
        updateViewToggleUI();
        renderTable();
    });

    document.getElementById('view-watchlist').addEventListener('click', () => {
        STATE.ui.viewMode = 'watchlist';
        updateViewToggleUI();
        renderTable();
    });

    document.getElementById('view-both').addEventListener('click', () => {
        STATE.ui.viewMode = 'both';
        updateViewToggleUI();
        renderTable();
    });

    document.getElementById('clear-watchlist').addEventListener('click', clearWatchlist);

    document.addEventListener('click', (e) => {
        const searchContainer = document.querySelector('.player-search-container');
        if (searchContainer && !searchContainer.contains(e.target)) {
            document.getElementById('player-search-results').style.display = 'none';
        }
    });
}

// ==========================================
// INITIALIZATION
// ==========================================

async function init() {
    try {
        const data = await loadAllData(true);
        STATE.data.players = data.players;
        STATE.data.teams = data.teams;
        STATE.data.stats = data.stats;
        STATE.data.fixtures = data.fixtures;
        STATE.data.positionOverrides = data.positionOverrides || [];

        processData();
        loadWatchlist();

        document.getElementById('loading').style.display = 'none';
        document.getElementById('main-content').style.display = 'block';

        applyDefaultGWWindow();
        setupEventListeners();

        if (STATE.data.watchlist.length > 0) {
            STATE.ui.viewMode = 'watchlist';
            updateViewToggleUI();
            renderTable();
        }

        console.log('=== Tracker Initialized ===');
    } catch (error) {
        console.error('Initialization error:', error);
        showError(`Failed to load data: ${error.message}`);
    }
}

// Expose functions globally for inline onclick handlers
window.removeFromWatchlist = removeFromWatchlist;

document.addEventListener('DOMContentLoaded', init);
