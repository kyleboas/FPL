/**
 * FPL DEFCON PREDICTOR
 * Team-level DEFCON view using ES6 modules
 */

import {
    CONFIG,
    getVal,
    parseExcludedGWs,
    loadAllData,
    deriveArchetype,
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
        positionOverrides: {}
    },
    ui: {
        currentArchetype: 'CB',
        startGW: 1,
        endGW: 6,
        excludedGWs: [],
        sortMode: {
            type: 'avg',      // now using Highest Average as default
            direction: 'desc',
            gw: null
        },
        thresholdValue: 8    // threshold in PERCENT for DEFCON sorting
    },
    latestGW: 0
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

    // Build position overrides lookup
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

    const debugEl = document.getElementById('status-bar');
    if (debugEl) {
        debugEl.textContent =
            `Data Ready: ${STATE.data.players.length} Players, ` +
            `${STATE.data.teams.length} Teams, ` +
            `${STATE.data.stats.length} Stat Records, ` +
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
        mode.direction = 'desc';
    }
    renderTable();
}

function renderTable() {
    const { currentArchetype, sortMode } = STATE.ui;
    const thresholdPercent = STATE.ui.thresholdValue || 0; // e.g. 8 => 8%
    const startGW = parseInt(STATE.ui.startGW, 10);
    const endGW = parseInt(STATE.ui.endGW, 10);

    const gwList = buildGWList(startGW, endGW, STATE.ui.excludedGWs);

    const { teams } = STATE.data;
    const { fixturesByTeam, probabilities, teamsByCode } = STATE.lookups;

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
        const gwProbMap = {};
        let metrics = [];
        let countAboveThreshold = 0;

        gwList.forEach(gw => {
            const fix = fixturesByTeam[teamCode] ? fixturesByTeam[teamCode][gw] : null;

            if (!fix) {
                fixtures.push({ type: 'BLANK' });
                metrics.push(0);
                gwProbMap[gw] = 0;
                return;
            }

            const opponentCode = fix.opponentCode;
            const isHome = fix.wasHome;
            const venueKey = String(isHome);

            let prob = CONFIG.MODEL.MIN_PROB;
            if (probabilities[opponentCode] &&
                probabilities[opponentCode][venueKey] &&
                probabilities[opponentCode][venueKey][currentArchetype]) {
                prob = probabilities[opponentCode][venueKey][currentArchetype];
            }

            const oppTeam = teamsByCode[opponentCode];
            const oppName = oppTeam ? oppTeam.short_name : 'UNK';

            fixtures.push({
                type: 'MATCH',
                opponent: oppName,
                venue: isHome ? '(H)' : '(A)',
                prob: prob
            });
            metrics.push(prob);
            gwProbMap[gw] = prob;

            // --- NEW: count fixtures at or above thresholdPercent ---
            if ((prob * 100) >= thresholdPercent) {
                countAboveThreshold += 1;
            }
        });

        const validMetrics = metrics.filter(m => m > 0);
        const maxVal = validMetrics.length ? Math.max(...validMetrics) : 0;
        const avgVal = validMetrics.length
            ? (validMetrics.reduce((a, b) => a + b, 0) / validMetrics.length)
            : 0;

        return {
            teamName: team.name,
            fixtures,
            gwProbMap,
            maxVal,
            avgVal,
            countAboveThreshold   // --- NEW FIELD ---
        };
    });

    // Sorting
    if (sortMode.type === 'max') {
        rowData.sort((a, b) => b.maxVal - a.maxVal);
    } else if (sortMode.type === 'avg') {
        rowData.sort((a, b) => b.avgVal - a.avgVal);
    } else if (sortMode.type === 'threshold-count') {
        // Sort by number of games at or above threshold (desc)
        rowData.sort((a, b) => b.countAboveThreshold - a.countAboveThreshold);
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
        tdName.textContent = row.teamName;
        tdName.style.fontWeight = 'bold';
        tr.appendChild(tdName);

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
                td.appendChild(wrapper);

                td.style.backgroundColor = getProbabilityColor(cell.prob, STATE.ui.currentArchetype);
                td.style.color = shouldUseWhiteText(cell.prob, STATE.ui.currentArchetype) ? '#fff' : '#000';
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
    STATE.ui.excludedGWs = parseExcludedGWs(excludeInput.value, CONFIG.UI.MAX_GW);

    // Reflect defaults in the inputs
    startInput.value = String(nextUnplayedGW);
    endInput.value   = String(defaultEndGW);
}

// ==========================================
// EVENT LISTENERS
// ==========================================

function setupEventListeners() {
    document.getElementById('archetype-filter').addEventListener('change', (e) => {
        STATE.ui.currentArchetype = e.target.value;
        renderTable();
    });

    const startInput = document.getElementById('gw-start');
    const endInput = document.getElementById('gw-end');
    const excludeInput = document.getElementById('gw-exclude');

    // No initialisation here – applyDefaultGWWindow() already set STATE.ui and inputs

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

    const thresholdInput = document.getElementById('threshold-value');
    STATE.ui.thresholdValue = parseFloat(thresholdInput.value) || 0;

    thresholdInput.addEventListener('input', (e) => {
        let val = parseFloat(e.target.value);
        if (isNaN(val)) val = 0;
        if (val < 0) val = 0;
        if (val > 100) val = 100;

        STATE.ui.thresholdValue = val;

        // Re-render, especially if the threshold-count mode is active
        if (STATE.ui.sortMode.type === 'threshold-count') {
            renderTable();
        }
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
        const rawData = await loadAllData(true);
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
