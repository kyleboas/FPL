/**
 * Player DEFCON Statistics
 * Individual player DEFCON analysis using ES6 modules
 */

import {
    CONFIG,
    getVal,
    parseExcludedGWs,
    loadAllData,
    deriveArchetype,
    getPositionGroup,
    checkDefconHit,
    processProbabilities,
    buildFixturesLookup,
    buildGWList,
    getProbabilityColor,
    shouldUseWhiteText
} from './modules/index.js';

// Application State
const STATE = {
    data: {
        players: [],
        teams: [],
        stats: [],
        fixtures: [],
        positionOverrides: []
    },
    lookups: {
        playersById: {},
        teamsById: {},
        teamsByCode: {},
        fixturesByTeam: {},
        probabilities: {},
        playerStatsByGW: {},
        positionOverrides: {}
    },
    ui: {
        positionFilter: 'DEF',
        teamFilter: 'ALL',
        startGW: 1,
        endGW: 6,
        excludedGWs: [],
        minMinutes: 90,
        sortMode: {
            type: 'defcon90',
            direction: 'desc',
            gw: null
        }
    },
    latestGW: 0
};

// User-defined position overrides
const USER_OVERRIDES = new Map();

// ==========================================
// POSITION OVERRIDE HELPERS
// ==========================================

function createPositionSelect(playerId, currentArchetype) {
    const select = document.createElement('select');
    select.className = 'position-select';
    select.dataset.playerId = playerId;

    const positions = [
        { value: '', label: `Auto (${currentArchetype})` },
        { value: 'CB', label: 'CB - Center Back' },
        { value: 'LB', label: 'LB - Left Back' },
        { value: 'RB', label: 'RB - Right Back' },
        { value: 'CDM', label: 'CDM - Defensive Mid' },
        { value: 'MID', label: 'MID - Midfielder' },
        { value: 'FWD', label: 'FWD - Forward' }
    ];

    positions.forEach(pos => {
        const option = document.createElement('option');
        option.value = pos.value;
        option.textContent = pos.label;
        select.appendChild(option);
    });

    const existingOverride = STATE.lookups.positionOverrides[playerId] || USER_OVERRIDES.get(playerId);
    if (existingOverride) {
        select.value = existingOverride;
        select.classList.add('has-override');
    }

    select.addEventListener('change', (e) => {
        const position = e.target.value;
        if (position) {
            USER_OVERRIDES.set(playerId, position);
            select.classList.add('has-override');
        } else {
            USER_OVERRIDES.delete(playerId);
            select.classList.remove('has-override');
        }
        updateOverrideCount();
    });

    return select;
}

function updateOverrideCount() {
    const count = USER_OVERRIDES.size;
    const countEl = document.getElementById('override-count');
    if (countEl) {
        countEl.textContent = `${count} override${count !== 1 ? 's' : ''} set`;
    }
}

function exportOverrides() {
    if (USER_OVERRIDES.size === 0) {
        alert('No position overrides set. Use the dropdowns in the Position column to set player positions first.');
        return;
    }

    let csvContent = 'player_id,actual_position\n';
    const sortedEntries = Array.from(USER_OVERRIDES.entries()).sort((a, b) => a[0] - b[0]);

    sortedEntries.forEach(([playerId, position]) => {
        csvContent += `${playerId},${position}\n`;
    });

    const modal = document.getElementById('csv-modal');
    const textarea = document.getElementById('csv-output');
    textarea.value = csvContent;
    modal.style.display = 'block';

    setTimeout(() => {
        textarea.select();
    }, 100);
}

function closeModal() {
    const modal = document.getElementById('csv-modal');
    modal.style.display = 'none';
}

function copyToClipboard() {
    const textarea = document.getElementById('csv-output');
    const copyBtn = document.getElementById('copy-csv');

    textarea.select();

    try {
        document.execCommand('copy');
        copyBtn.textContent = 'Copied!';
        copyBtn.classList.add('copied');

        setTimeout(() => {
            copyBtn.textContent = 'Copy to Clipboard';
            copyBtn.classList.remove('copied');
        }, 2000);
    } catch (err) {
        alert('Failed to copy. Please manually select and copy the text.');
    }
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

    STATE.lookups.positionOverrides = {};
    if (STATE.data.positionOverrides && STATE.data.positionOverrides.length > 0) {
        STATE.data.positionOverrides.forEach(override => {
            const pid = getVal(override, 'player_id', 'id');
            const position = override.actual_position;
            if (pid != null && position) {
                STATE.lookups.positionOverrides[pid] = position;
            }
        });
    }

    STATE.lookups.teamsById = {};
    STATE.data.teams.forEach(t => STATE.lookups.teamsById[t.id] = t);

    STATE.lookups.teamsByCode = {};
    STATE.data.teams.forEach(t => STATE.lookups.teamsByCode[t.code] = t);

    // Track latest completed gameweek
    let latestCompletedGW = 0;
    STATE.data.fixtures.forEach(fix => {
        const isFin = String(getVal(fix, 'finished')).toLowerCase() === 'true';
        const gw = getVal(fix, 'gw', 'event', 'gameweek');
        if (isFin && gw > latestCompletedGW) {
            latestCompletedGW = gw;
        }
    });
    STATE.latestGW = latestCompletedGW;

    STATE.lookups.fixturesByTeam = buildFixturesLookup({
        fixtures: STATE.data.fixtures,
        teams: STATE.data.teams
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
}

// ==========================================
// RENDERING
// ==========================================

function handleGwHeaderClick(gw) {
    const mode = STATE.ui.sortMode;
    if (mode.type === 'column' && mode.gw === gw) {
        mode.direction = mode.direction === 'desc' ? 'asc' : 'desc';
    } else {
        mode.type = 'column';
        mode.gw = gw;
        mode.direction = 'desc';
    }
    renderTable();
}

function renderTable() {
    const { positionFilter, teamFilter, sortMode, minMinutes } = STATE.ui;
    const startGW = parseInt(STATE.ui.startGW, 10);
    const endGW = parseInt(STATE.ui.endGW, 10);

    const gwList = buildGWList(startGW, endGW, STATE.ui.excludedGWs);

    const { players, stats } = STATE.data;
    const { playersById, fixturesByTeam, probabilities, teamsByCode, teamsById } = STATE.lookups;

    const thead = document.getElementById('fixture-header');
    const tbody = document.getElementById('fixture-body');

    thead.innerHTML = '';
    const headerRow = document.createElement('tr');

    const thPlayer = document.createElement('th');
    thPlayer.textContent = 'Player';
    headerRow.appendChild(thPlayer);

    const thPosition = document.createElement('th');
    thPosition.textContent = 'Position';
    thPosition.style.minWidth = '120px';
    headerRow.appendChild(thPosition);

    gwList.forEach(gw => {
        const th = document.createElement('th');
        th.textContent = `GW ${gw}`;
        th.dataset.gw = gw;
        th.classList.add('gw-header');

        if (sortMode.type === 'column' && sortMode.gw === gw) {
            th.classList.add(sortMode.direction === 'desc' ? 'sorted-desc' : 'sorted-asc');
        }

        th.addEventListener('click', () => handleGwHeaderClick(gw));
        headerRow.appendChild(th);
    });

    thead.appendChild(headerRow);

    let rowData = players.map(player => {
        const pid = getVal(player, 'player_id', 'id');
        if (!pid) return null;

        const archetype = deriveArchetype(player, STATE.lookups.positionOverrides);
        if (!archetype) return null;

        const posGroup = getPositionGroup(archetype);
        if (positionFilter !== 'ALL' && posGroup !== positionFilter) {
            return null;
        }

        const teamRef = getVal(player, 'team', 'team_id', 'teamid', 'team_code');
        let teamCode = null;
        if (STATE.lookups.teamsByCode[teamRef]) {
            teamCode = teamRef;
        } else if (teamsById[teamRef]) {
            teamCode = teamsById[teamRef].code;
        }

        if (teamFilter !== 'ALL' && teamCode !== teamFilter) {
            return null;
        }

        const teamName = teamCode ? (teamsByCode[teamCode]?.short_name || teamCode) : 'Unknown';
        const playerName = getVal(player, 'name', 'web_name', 'player_name') || 'Unknown';

        let totalMinutes = 0;
        let totalDefconHits = 0;
        const fixtures = [];
        const gwProbMap = {};
        let metrics = [];

        gwList.forEach(gw => {
            const statRecord = stats.find(s => {
                const sID = getVal(s, 'player_id', 'element', 'id');
                const sGW = getVal(s, 'gw', 'gameweek', 'event', 'round');
                return sID === pid && sGW === gw;
            });

            const fix = teamCode && fixturesByTeam[teamCode] ? fixturesByTeam[teamCode][gw] : null;

            if (!fix) {
                fixtures.push({ type: 'BLANK' });
                metrics.push(0);
                gwProbMap[gw] = 0;
                return;
            }

            const opponentCode = fix.opponentCode;
            const isHome = fix.wasHome;
            const finished = fix.finished;
            const venueKey = String(isHome);

            let prob = CONFIG.MODEL.MIN_PROB;
            if (probabilities[opponentCode] &&
                probabilities[opponentCode][venueKey] &&
                probabilities[opponentCode][venueKey][archetype]) {
                prob = probabilities[opponentCode][venueKey][archetype];
            }

            const oppTeam = teamsByCode[opponentCode];
            const oppName = oppTeam ? oppTeam.short_name : 'UNK';

            let minutes = 0;
            let defconHit = false;

            if (statRecord) {
                minutes = getVal(statRecord, 'minutes', 'minutes_played', 'minutes_x') || 0;
                totalMinutes += minutes;
                defconHit = checkDefconHit(statRecord, archetype);
                if (defconHit) {
                    totalDefconHits++;
                }
            }

            fixtures.push({
                type: 'MATCH',
                opponent: oppName,
                venue: isHome ? '(H)' : '(A)',
                prob: prob,
                minutes: minutes,
                defconHit: defconHit,
                finished: finished
            });

            metrics.push(prob);
            gwProbMap[gw] = prob;
        });

        if (totalMinutes < minMinutes) {
            return null;
        }

        const defconPer90 = totalMinutes > 0 ? (totalDefconHits / totalMinutes) * 90 : 0;
        const validMetrics = metrics.filter(m => m > 0);
        const maxVal = validMetrics.length ? Math.max(...validMetrics) : 0;
        const avgVal = validMetrics.length ? (validMetrics.reduce((a, b) => a + b, 0) / validMetrics.length) : 0;

        return {
            playerId: pid,
            playerName,
            teamName,
            archetype,
            fixtures,
            gwProbMap,
            totalMinutes,
            totalDefconHits,
            defconPer90,
            maxVal,
            avgVal
        };
    }).filter(row => row !== null);

    // Sorting
    if (sortMode.type === 'defcon90') {
        rowData.sort((a, b) => b.defconPer90 - a.defconPer90);
    } else if (sortMode.type === 'max') {
        rowData.sort((a, b) => b.maxVal - a.maxVal);
    } else if (sortMode.type === 'avg') {
        rowData.sort((a, b) => b.avgVal - a.avgVal);
    } else if (sortMode.type === 'column' && sortMode.gw != null) {
        const dir = sortMode.direction === 'asc' ? 1 : -1;
        const gw = sortMode.gw;
        rowData.sort((a, b) => {
            const pa = a.gwProbMap[gw] ?? 0;
            const pb = b.gwProbMap[gw] ?? 0;
            return dir * (pa - pb);
        });
    }

    tbody.innerHTML = '';
    rowData.forEach(row => {
        const tr = document.createElement('tr');

        const tdName = document.createElement('td');
        const nameDiv = document.createElement('div');
        nameDiv.className = 'player-name';
        nameDiv.textContent = row.playerName;

        const teamDiv = document.createElement('div');
        teamDiv.className = 'player-team';
        teamDiv.textContent = row.teamName;

        const idDiv = document.createElement('div');
        idDiv.className = 'player-id';
        idDiv.textContent = `ID: ${row.playerId}`;
        idDiv.style.fontSize = '0.75em';
        idDiv.style.color = '#666';
        idDiv.style.marginTop = '2px';

        tdName.appendChild(nameDiv);
        tdName.appendChild(teamDiv);
        tdName.appendChild(idDiv);
        tr.appendChild(tdName);

        const tdPosition = document.createElement('td');
        const positionSelect = createPositionSelect(row.playerId, row.archetype);
        tdPosition.appendChild(positionSelect);
        tr.appendChild(tdPosition);

        row.fixtures.forEach(cell => {
            const td = document.createElement('td');

            if (cell.type === 'BLANK') {
                td.textContent = '-';
                td.style.backgroundColor = '#f4f4f4';
            } else {
                const wrapper = document.createElement('div');
                wrapper.className = 'match-cell';

                const divOpp = document.createElement('div');
                divOpp.className = 'match-opp';
                divOpp.textContent = `${cell.opponent} ${cell.venue}`;

                const divProb = document.createElement('div');
                divProb.className = 'match-prob';
                divProb.textContent = `${(cell.prob * 100).toFixed(0)}%`;

                wrapper.appendChild(divOpp);
                wrapper.appendChild(divProb);

                if (cell.finished && cell.minutes > 0) {
                    const divResult = document.createElement('div');
                    divResult.className = 'match-result';
                    if (cell.defconHit) {
                        divResult.textContent = '✓ HIT';
                        divResult.style.color = '#28a745';
                    } else {
                        divResult.textContent = '✗ MISS';
                        divResult.style.color = '#dc3545';
                    }
                    wrapper.appendChild(divResult);
                }

                td.appendChild(wrapper);
                td.style.backgroundColor = getProbabilityColor(cell.prob, row.archetype);
                td.style.color = shouldUseWhiteText(cell.prob, row.archetype) ? 'white' : '#fff';
            }
            tr.appendChild(td);
        });

        tbody.appendChild(tr);
    });

    const statusEl = document.getElementById('status-bar');
    if (statusEl) {
        statusEl.textContent = `Showing ${rowData.length} players`;
    }
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
    STATE.ui.excludedGWs = parseExcludedGWs(excludeInput.value);

    // Reflect defaults in the inputs
    startInput.value = String(nextUnplayedGW);
    endInput.value   = String(defaultEndGW);
}

// ==========================================
// EVENT LISTENERS
// ==========================================

function setupEventListeners() {
    document.getElementById('position-filter').addEventListener('change', (e) => {
        STATE.ui.positionFilter = e.target.value;
        renderTable();
    });

    document.getElementById('team-filter').addEventListener('change', (e) => {
        STATE.ui.teamFilter = e.target.value;
        renderTable();
    });

    const startInput = document.getElementById('gw-start');
    const endInput = document.getElementById('gw-end');

    startInput.addEventListener('input', (e) => {
        let val = parseInt(e.target.value, 10);
        if (isNaN(val)) val = 1;
        if (val < 1) val = 1;
        if (val > CONFIG.UI.MAX_GW) val = CONFIG.UI.MAX_GW;
        STATE.ui.startGW = val;

        if (STATE.ui.endGW < val) {
            STATE.ui.endGW = val;
            endInput.value = String(val);
        }

        renderTable();
    });

    endInput.addEventListener('input', (e) => {
        let val = parseInt(e.target.value, 10);
        if (!isNaN(val) && val >= 1 && val <= CONFIG.UI.MAX_GW) {
            STATE.ui.endGW = val;
            renderTable();
        }
    });

    endInput.addEventListener('blur', (e) => {
        let val = parseInt(e.target.value, 10);
        if (isNaN(val)) val = CONFIG.UI.MAX_GW;
        if (val < 1) val = 1;
        if (val > CONFIG.UI.MAX_GW) val = CONFIG.UI.MAX_GW;

        if (val < STATE.ui.startGW) {
            val = STATE.ui.startGW;
        }

        e.target.value = String(val);
        STATE.ui.endGW = val;
        renderTable();
    });

    document.getElementById('gw-exclude').addEventListener('change', (e) => {
        STATE.ui.excludedGWs = parseExcludedGWs(e.target.value, CONFIG.UI.MAX_GW);
        renderTable();
    });

    document.getElementById('min-minutes').addEventListener('change', (e) => {
        STATE.ui.minMinutes = parseInt(e.target.value, 10) || 0;
        renderTable();
    });

    document.getElementById('sort-by').addEventListener('change', (e) => {
        const value = e.target.value;
        STATE.ui.sortMode.type = value;
        STATE.ui.sortMode.direction = 'desc';
        STATE.ui.sortMode.gw = null;
        renderTable();
    });

    document.getElementById('export-overrides').addEventListener('click', exportOverrides);
    document.getElementById('close-modal').addEventListener('click', closeModal);
    document.getElementById('copy-csv').addEventListener('click', copyToClipboard);

    window.addEventListener('click', (e) => {
        const modal = document.getElementById('csv-modal');
        if (e.target === modal) {
            closeModal();
        }
    });
}

// ==========================================
// INITIALIZATION
// ==========================================

async function init() {
    try {
        const data = await loadAllData(true);
        STATE.data = data;

        processData();

        const teamSelect = document.getElementById('team-filter');
        STATE.data.teams.forEach(team => {
            const option = document.createElement('option');
            option.value = team.code;
            option.textContent = team.short_name || team.name;
            teamSelect.appendChild(option);
        });

        document.getElementById('loading').style.display = 'none';
        document.getElementById('main-content').style.display = 'block';

        applyDefaultGWWindow();
        setupEventListeners();
        renderTable();

    } catch (error) {
        console.error('Error loading data:', error);
        const errorEl = document.getElementById('error');
        errorEl.textContent = `Error: ${error.message}`;
        errorEl.style.display = 'block';
        document.getElementById('loading').style.display = 'none';
    }
}

init();
