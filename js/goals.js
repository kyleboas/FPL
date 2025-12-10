/**
 * FPL Goals Statistics
 * Team-level goals analysis using ES6 modules
 */

import {
    CONFIG,
    getVal,
    roundToTwo,
    parseExcludedGWs,
    loadAllData,
    buildFixturesLookup,
    buildGWList,
    processGoalsData,
    calculateCumulativeGoals,
    getGoalsColor
} from './modules/index.js';

// Application State
const STATE = {
    data: {
        players: [],
        teams: [],
        stats: [],
        fixtures: []
    },
    lookups: {
        playersById: {},
        teamsById: {},
        teamsByCode: {},
        fixturesByTeam: {},
        teamGoals: {},
        positionGoalsRaw: {}  // teamCode -> gw -> { ALL:{for,against}, DEF:{...}, MID:{...}, FWD:{...} }
    },
    ui: {
        statType: 'for',
        venueFilter: 'homeaway',
        formFilter: 8,
        startGW: 1,
        endGW: 6,
        excludedGWs: [],
        sortMode: {
            type: 'avg',      // now using Highest Average as default
            direction: 'desc',
            gw: null
        },
        positionFilter: 'ALL'  // 'ALL' | 'DEF' | 'MID' | 'FWD'
    },
    latestGW: 0
};

// ==========================================
// HELPER FUNCTIONS
// ==========================================

// Map player object to a simple position key: 'GK' | 'DEF' | 'MID' | 'FWD'
function getPlayerPositionKey(player) {
    if (!player) return 'UNK';

    // common FPL / custom fields
    const rawPos = getVal(player, 'actual_position', 'position', 'pos', 'element_type', 'position_short', 'primary_position');
    if (typeof rawPos === 'number') {
        // FPL convention: 1=GK,2=DEF,3=MID,4=FWD
        if (rawPos === 1) return 'GK';
        if (rawPos === 2) return 'DEF';
        if (rawPos === 3) return 'MID';
        if (rawPos === 4) return 'FWD';
    } else if (typeof rawPos === 'string') {
        const p = rawPos.trim().toUpperCase();
        if (p.startsWith('G')) return 'GK';
        if (p.startsWith('D')) return 'DEF';
        if (p.startsWith('M')) return 'MID';
        if (p.startsWith('F')) return 'FWD';
    }

    return 'UNK';
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

    STATE.lookups.fixturesByTeam = buildFixturesLookup({
        fixtures: STATE.data.fixtures,
        teams: STATE.data.teams
    });

    const goalsResult = processGoalsData({
        fixtures: STATE.data.fixtures,
        teams: STATE.data.teams,
        fixturesByTeam: STATE.lookups.fixturesByTeam,
        stats: STATE.data.stats,
        playersById: STATE.lookups.playersById,
        teamsById: STATE.lookups.teamsById
    });

    STATE.lookups.teamGoals = goalsResult.teamGoals;
    STATE.lookups.positionGoalsRaw = goalsResult.positionGoalsRaw;
    STATE.latestGW = goalsResult.latestGW;

    const debugEl = document.getElementById('status-bar');
    if (debugEl) {
        debugEl.textContent =
            `Data Ready: ${STATE.data.teams.length} Teams, ` +
            `${STATE.data.fixtures.length} Fixtures processed.`;
    }
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
        mode.direction = STATE.ui.statType === 'for' ? 'asc' : 'desc';
    }
    renderTable();
}

function updateFormFilterDisplay(value) {
    const displayEl = document.getElementById('form-filter-value');
    if (!displayEl) return;

    if (value === 0) {
        displayEl.textContent = 'All Time';
    } else {
        displayEl.textContent = `Last ${value} GW${value > 1 ? 's' : ''}`;
    }
}

function renderTable() {
    const { statType, venueFilter, sortMode, formFilter, positionFilter } = STATE.ui;
    const startGW = parseInt(STATE.ui.startGW, 10);
    const endGW = parseInt(STATE.ui.endGW, 10);

    const gwList = buildGWList(startGW, endGW, STATE.ui.excludedGWs);

    const { teams } = STATE.data;
    const { fixturesByTeam, teamsByCode } = STATE.lookups;

    // Calculate cumulative goals
    const cumulativeGoalsByTeam = calculateCumulativeGoals({
        teams,
        fixturesByTeam,
        latestGW: STATE.latestGW,
        formFilter,
        maxGW: CONFIG.UI.MAX_GW,
        positionFilter,
        positionGoalsRaw: STATE.lookups.positionGoalsRaw
    });

    const thead = document.getElementById('fixture-header');
    const tbody = document.getElementById('fixture-body');

    thead.innerHTML = '';
    const headerRow = document.createElement('tr');

    const thTeam = document.createElement('th');
    thTeam.textContent = 'Team';
    headerRow.appendChild(thTeam);

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

    let rowData = teams.map(team => {
        const teamCode = team.code;
        const fixtures = [];
        const gwValueMap = {};
        let metrics = [];

        gwList.forEach(gw => {
            const fix = fixturesByTeam[teamCode] ? fixturesByTeam[teamCode][gw] : null;

            if (!fix) {
                fixtures.push({ type: 'BLANK', cumulativeValue: null });
                gwValueMap[gw] = null;
                return;
            }

            const opponentCode = fix.opponentCode;
            const isHome = fix.wasHome;
            const oppTeam = teamsByCode[opponentCode];
            const oppName = oppTeam ? oppTeam.short_name : 'UNK';

            let oppVenue = 'combined';
            if (venueFilter === 'homeaway') {
                oppVenue = isHome ? 'away' : 'home';
            }

            const oppCumulative = cumulativeGoalsByTeam[opponentCode]
                ? cumulativeGoalsByTeam[opponentCode][oppVenue][gw]
                : null;

            if (!oppCumulative) {
                fixtures.push({ type: 'BLANK', cumulativeValue: null });
                gwValueMap[gw] = null;
                return;
            }

            const oppCumulativeValue = statType === 'for'
                ? oppCumulative.for
                : oppCumulative.against;

            const value = oppCumulativeValue;

            fixtures.push({
                type: fix.finished ? 'MATCH' : 'FUTURE',
                opponent: oppName,
                venue: isHome ? '(H)' : '(A)',
                value: value,
                isFinished: fix.finished
            });
            metrics.push(value);
            gwValueMap[gw] = value;
        });

        const validMetrics = metrics.filter(m => m !== null);
        const maxVal = validMetrics.length ? Math.max(...validMetrics) : 0;
        const avgVal = validMetrics.length ? roundToTwo(validMetrics.reduce((a, b) => a + b, 0) / validMetrics.length) : 0;
        const totalVal = roundToTwo(validMetrics.reduce((a, b) => a + b, 0));

        return {
            teamName: team.short_name || team.name,
            fixtures,
            gwValueMap,
            maxVal,
            avgVal,
            totalVal
        };
    });

    // Sorting
    const sortMultiplier = statType === 'for' ? 1 : -1;

    if (sortMode.type === 'max') {
        rowData.sort((a, b) => sortMultiplier * (a.maxVal - b.maxVal));
    } else if (sortMode.type === 'avg') {
        rowData.sort((a, b) => sortMultiplier * (a.avgVal - b.avgVal));
    } else if (sortMode.type === 'total') {
        rowData.sort((a, b) => sortMultiplier * (a.totalVal - b.totalVal));
    } else if (sortMode.type === 'column' && sortMode.gw != null) {
        const dir = sortMode.direction === 'asc' ? 1 : -1;
        const gw = sortMode.gw;
        rowData.sort((a, b) => {
            const va = a.gwValueMap[gw] ?? -1;
            const vb = b.gwValueMap[gw] ?? -1;
            return dir * (va - vb);
        });
    }

    // Calculate global max for color scaling
    let globalMaxValue = 0;
    rowData.forEach(row => {
        row.fixtures.forEach(cell => {
            if ((cell.type === 'MATCH' || cell.type === 'FUTURE') && cell.value != null) {
                globalMaxValue = Math.max(globalMaxValue, cell.value);
            }
        });
    });

    tbody.innerHTML = '';
    rowData.forEach(row => {
        const tr = document.createElement('tr');

        const tdName = document.createElement('td');
        tdName.textContent = row.teamName;
        tdName.style.fontWeight = '600';
        tr.appendChild(tdName);

        row.fixtures.forEach(cell => {
            const td = document.createElement('td');

            if (cell.type === 'BLANK' || cell.type === 'FILTERED') {
                td.textContent = '-';
                td.style.backgroundColor = '#e2e8f0'; // soft slate gray
                td.style.color = '#94a3b8';          // muted text
            } else if (cell.type === 'MATCH' || cell.type === 'FUTURE') {
                const wrapper = document.createElement('div');
                wrapper.className = 'match-cell';

                const divOpp = document.createElement('div');
                divOpp.className = 'match-opp';
                divOpp.textContent = `${cell.opponent} ${cell.venue}`;

                const divValue = document.createElement('div');
                divValue.className = 'match-value';
                divValue.textContent = roundToTwo(cell.value);

                wrapper.appendChild(divOpp);
                wrapper.appendChild(divValue);
                td.appendChild(wrapper);

                td.style.backgroundColor = getGoalsColor(cell.value, statType, globalMaxValue);

                // Adjust text color for readability
                if (cell.value <= 0.8) {
                    divOpp.style.color = '#000';
                    divValue.style.color = '#000';
                } else {
                    divOpp.style.color = '#fff';
                    divValue.style.color = '#fff';
                }

                // Style future fixtures slightly differently
                if (cell.type === 'FUTURE') {
                    td.style.opacity = '0.9';
                    td.style.fontStyle = 'italic';
                }
            }
            tr.appendChild(td);
        });

        tbody.appendChild(tr);
    });
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
    // Stat type toggle (Goals For / Goals Against)
    const statToggle = document.getElementById('stat-type-toggle');
    statToggle.querySelectorAll('.toggle-option').forEach(option => {
        option.addEventListener('click', (e) => {
            const value = e.currentTarget.dataset.value; // 'for' or 'against'
            STATE.ui.statType = value;

            // Update active state
            statToggle.querySelectorAll('.toggle-option').forEach(opt => {
                opt.classList.remove('active');
            });
            e.currentTarget.classList.add('active');

            // Reset sort defaults when switching stat type
            STATE.ui.sortMode.type = 'avg';
            STATE.ui.sortMode.gw = null;
            STATE.ui.sortMode.direction = value === 'for' ? 'asc' : 'desc';

            renderTable();
        });
    });

    const venueToggle = document.getElementById('venue-toggle');
    venueToggle.querySelectorAll('.toggle-option').forEach(option => {
        option.addEventListener('click', (e) => {
            const value = e.target.dataset.value;
            STATE.ui.venueFilter = value;

            // Update active state
            venueToggle.querySelectorAll('.toggle-option').forEach(opt => {
                opt.classList.remove('active');
            });
            e.target.classList.add('active');

            renderTable();
        });
    });

    // Position toggle (All / DEF / MID / FWD)
    const positionToggle = document.getElementById('position-toggle');
    if (positionToggle) {
        positionToggle.querySelectorAll('.toggle-option').forEach(option => {
            option.addEventListener('click', (e) => {
                const value = e.target.dataset.value; // 'ALL', 'DEF', 'MID', 'FWD'
                STATE.ui.positionFilter = value || 'ALL';

                positionToggle.querySelectorAll('.toggle-option').forEach(opt => {
                    opt.classList.remove('active');
                });
                e.target.classList.add('active');

                renderTable();
            });
        });
    }

    const formFilterSlider = document.getElementById('form-filter');

    // Ensure slider + label match default state (8)
    formFilterSlider.value = STATE.ui.formFilter; // STATE.ui.formFilter is 8 from the STATE object
    updateFormFilterDisplay(STATE.ui.formFilter);

    formFilterSlider.addEventListener('input', (e) => {
        const value = parseInt(e.target.value, 10);
        STATE.ui.formFilter = value;
        updateFormFilterDisplay(value);
        renderTable();
    });

    const startInput = document.getElementById('gw-start');
    const endInput = document.getElementById('gw-end');
    const excludeInput = document.getElementById('gw-exclude');

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

    excludeInput.addEventListener('input', (e) => {
        STATE.ui.excludedGWs = parseExcludedGWs(e.target.value, CONFIG.UI.MAX_GW);
        renderTable();
    });

    document.getElementById('sort-by').addEventListener('change', (e) => {
        const val = e.target.value;
        STATE.ui.sortMode.type = val;
        STATE.ui.sortMode.gw = null;
        STATE.ui.sortMode.direction = 'desc';
        renderTable();
    });
}

// ==========================================
// INITIALIZATION
// ==========================================

async function init() {
    const loadingEl = document.getElementById('loading');
    const mainEl = document.getElementById('main-content');
    const errorEl = document.getElementById('error');

    try {
        const rawData = await loadAllData(false);
        STATE.data = rawData;
        processData();

        window.STATE = STATE;

        loadingEl.style.display = 'none';
        mainEl.style.display = 'block';

        applyDefaultGWWindow();
        setupEventListeners();
        renderTable();

    } catch (err) {
        console.error("Initialization Error:", err);
        loadingEl.style.display = 'none';
        errorEl.style.display = 'block';
        errorEl.textContent = `Error: ${err.message}. Check console for details.`;
    }
}

document.addEventListener('DOMContentLoaded', init);
