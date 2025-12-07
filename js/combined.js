/**
 * FPL Combined DEFCON & Goals View
 * Combines defensive action probabilities with goals statistics using ES6 modules
 */

import {
    CONFIG,
    getVal,
    roundToTwo,
    parseExcludedGWs,
    loadAllData,
    checkDefconHit,
    processProbabilities,
    processGoalsData,
    buildFixturesLookup,
    buildGWList,
    calculateCumulativeGoals,
    getCombinedColor
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
        probabilities: {},
        teamGoals: {}
    },
    ui: {
        position: 'CB',
        venueFilter: 'combined',
        goalsType: 'for',
        formFilter: 0,
        startGW: 1,
        endGW: 6,
        excludedGWs: [],
        sortMode: {
            type: 'max',
            direction: 'desc',
            gw: null
        }
    },
    latestGW: 0
};

// ==========================================
// DATA PROCESSING
// ==========================================

function getPlayerArchetype(player) {
    const detailedPos = (getVal(player, 'detailed_position', 'role') || '').toUpperCase();

    if (['CB'].includes(detailedPos)) return 'CB';
    if (['LB', 'LWB'].includes(detailedPos)) return 'LB';
    if (['RB', 'RWB'].includes(detailedPos)) return 'RB';

    const generalPos = (getVal(player, 'position') || '').toUpperCase();

    if (generalPos === 'DEF') return 'CB';
    if (generalPos === 'MID') return 'MID';
    if (generalPos === 'FWD') return 'FWD';

    return null;
}

function processDefconData() {
    const { stats, players, teams } = STATE.data;
    const { playersById, teamsByCode, fixturesByTeam, teamsById } = STATE.lookups;

    const archetypes = ['CB', 'LB', 'RB', 'MID', 'FWD'];

    const opponentAgg = {};
    teams.forEach(t => {
        opponentAgg[t.code] = {
            'true': {},
            'false': {}
        };
        ['true', 'false'].forEach(venueKey => {
            archetypes.forEach(arch => {
                opponentAgg[t.code][venueKey][arch] = { hits: 0, trials: 0 };
            });
        });
    });

    stats.forEach(stat => {
        const playerId = getVal(stat, 'player_id', 'element', 'id');
        const player = playersById[playerId];
        if (!player) return;

        const archetype = getPlayerArchetype(player);
        if (!archetype || archetype === 'GKP') return;

        const minutes = getVal(stat, 'minutes', 'minutes_played') || 0;
        if (minutes < 45) return;

        const teamId = getVal(player, 'team', 'team_id');
        const team = teamsById[teamId];
        if (!team) return;

        const gw = getVal(stat, 'gw', 'gameweek', 'event');
        const fixture = fixturesByTeam[team.code]?.[gw];
        if (!fixture || !fixture.finished) return;

        const opponentCode = fixture.opponentCode;
        const venueKey = String(fixture.wasHome);

        const isHit = checkDefconHit(stat, archetype);

        const bucket = opponentAgg[opponentCode][venueKey][archetype];
        bucket.trials++;
        if (isHit) bucket.hits++;
    });

    STATE.lookups.probabilities = {};

    teams.forEach(team => {
        const teamCode = team.code;
        STATE.lookups.probabilities[teamCode] = { 'true': {}, 'false': {} };

        ['true', 'false'].forEach(venueKey => {
            archetypes.forEach(arch => {
                let hits = 0;
                let trials = 0;

                if (opponentAgg[teamCode] && opponentAgg[teamCode][venueKey] && opponentAgg[teamCode][venueKey][arch]) {
                    hits = opponentAgg[teamCode][venueKey][arch].hits;
                    trials = opponentAgg[teamCode][venueKey][arch].trials;
                }

                const prob = trials > 0 ? (hits / trials) : 0;
                STATE.lookups.probabilities[teamCode][venueKey][arch] = prob;
            });
        });
    });

    console.log('=== DEFCON Probabilities Processed ===');
}

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
        fixturesByTeam: STATE.lookups.fixturesByTeam
    });
    STATE.lookups.teamGoals = goalsResult.teamGoals;
    STATE.latestGW = goalsResult.latestGW;

    processDefconData();

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
        mode.direction = 'desc';
    }
    renderTable();
}

function renderTable() {
    const { position, venueFilter, goalsType, formFilter } = STATE.ui;
    const startGW = parseInt(STATE.ui.startGW, 10);
    const endGW = parseInt(STATE.ui.endGW, 10);

    const gwList = buildGWList(startGW, endGW, STATE.ui.excludedGWs);

    const { teams } = STATE.data;
    const { fixturesByTeam, probabilities, teamsByCode } = STATE.lookups;

    // Calculate cumulative goals
    const cumulativeGoalsByTeam = calculateCumulativeGoals({
        teams,
        fixturesByTeam,
        latestGW: STATE.latestGW,
        formFilter,
        maxGW: CONFIG.UI.MAX_GW
    });

    // Build table data
    const tableData = teams.map(team => {
        const teamCode = team.code;
        const row = {
            teamCode,
            teamName: team.short_name || team.name,
            fixtures: {}
        };

        gwList.forEach(gw => {
            const fix = fixturesByTeam[teamCode]?.[gw];
            if (!fix) {
                row.fixtures[gw] = null;
                return;
            }

            const oppCode = fix.opponentCode;
            const opp = teamsByCode[oppCode];
            const venue = fix.wasHome ? 'H' : 'A';
            const venueKey = String(fix.wasHome);

            const defconProb = probabilities[oppCode]?.[venueKey]?.[position] || 0;

            let goalsValue = 0;
            const venueType = venueFilter === 'combined' ? 'combined' :
                             (fix.wasHome ? 'away' : 'home');

            const oppGoals = cumulativeGoalsByTeam[oppCode]?.[venueType]?.[gw];
            if (oppGoals) {
                goalsValue = goalsType === 'for' ? oppGoals.for : oppGoals.against;
            }

            row.fixtures[gw] = {
                opponent: opp ? opp.short_name : oppCode,
                venue,
                defconProb,
                goalsValue
            };
        });

        return row;
    });

    // Calculate max goals for color scaling
    let maxGoals = 1;
    tableData.forEach(row => {
        gwList.forEach(gw => {
            const fix = row.fixtures[gw];
            if (fix && fix.goalsValue > maxGoals) {
                maxGoals = fix.goalsValue;
            }
        });
    });

    // Sort table
    const sortMode = STATE.ui.sortMode;
    if (sortMode.type === 'max') {
        tableData.sort((a, b) => {
            let maxA = 0, maxB = 0;
            gwList.forEach(gw => {
                const fixA = a.fixtures[gw];
                const fixB = b.fixtures[gw];
                if (fixA) {
                    const combined = (fixA.defconProb + (fixA.goalsValue / maxGoals)) / 2;
                    maxA = Math.max(maxA, combined);
                }
                if (fixB) {
                    const combined = (fixB.defconProb + (fixB.goalsValue / maxGoals)) / 2;
                    maxB = Math.max(maxB, combined);
                }
            });
            return sortMode.direction === 'desc' ? maxB - maxA : maxA - maxB;
        });
    } else if (sortMode.type === 'avg') {
        tableData.sort((a, b) => {
            let sumA = 0, countA = 0, sumB = 0, countB = 0;
            gwList.forEach(gw => {
                const fixA = a.fixtures[gw];
                const fixB = b.fixtures[gw];
                if (fixA) {
                    sumA += (fixA.defconProb + (fixA.goalsValue / maxGoals)) / 2;
                    countA++;
                }
                if (fixB) {
                    sumB += (fixB.defconProb + (fixB.goalsValue / maxGoals)) / 2;
                    countB++;
                }
            });
            const avgA = countA > 0 ? sumA / countA : 0;
            const avgB = countB > 0 ? sumB / countB : 0;
            return sortMode.direction === 'desc' ? avgB - avgA : avgA - avgB;
        });
    } else if (sortMode.type === 'total') {
        tableData.sort((a, b) => {
            let sumA = 0, sumB = 0;
            gwList.forEach(gw => {
                const fixA = a.fixtures[gw];
                const fixB = b.fixtures[gw];
                if (fixA) sumA += (fixA.defconProb + (fixA.goalsValue / maxGoals)) / 2;
                if (fixB) sumB += (fixB.defconProb + (fixB.goalsValue / maxGoals)) / 2;
            });
            return sortMode.direction === 'desc' ? sumB - sumA : sumA - sumB;
        });
    } else if (sortMode.type === 'column' && sortMode.gw != null) {
        tableData.sort((a, b) => {
            const fixA = a.fixtures[sortMode.gw];
            const fixB = b.fixtures[sortMode.gw];
            const valA = fixA ? (fixA.defconProb + (fixA.goalsValue / maxGoals)) / 2 : 0;
            const valB = fixB ? (fixB.defconProb + (fixB.goalsValue / maxGoals)) / 2 : 0;
            return sortMode.direction === 'desc' ? valB - valA : valA - valB;
        });
    }

    // Render header
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

    // Render body
    tbody.innerHTML = '';
    tableData.forEach(row => {
        const tr = document.createElement('tr');

        const tdTeam = document.createElement('td');
        tdTeam.textContent = row.teamName;
        tr.appendChild(tdTeam);

        gwList.forEach(gw => {
            const td = document.createElement('td');
            const fix = row.fixtures[gw];

            if (!fix) {
                td.textContent = '-';
                td.style.backgroundColor = '#f9f9f9';
            } else {
                const cellDiv = document.createElement('div');
                cellDiv.className = 'combined-cell';

                const oppDiv = document.createElement('div');
                oppDiv.className = 'combined-opponent';
                oppDiv.textContent = `${fix.opponent} (${fix.venue})`;
                cellDiv.appendChild(oppDiv);

                const statsDiv = document.createElement('div');
                statsDiv.className = 'combined-stats';

                const defconSpan = document.createElement('span');
                defconSpan.className = 'stat-defcon';
                defconSpan.textContent = `${Math.round(fix.defconProb * 100)}%`;
                statsDiv.appendChild(defconSpan);

                const sepSpan = document.createElement('span');
                sepSpan.className = 'stat-separator';
                sepSpan.textContent = '|';
                statsDiv.appendChild(sepSpan);

                const goalsSpan = document.createElement('span');
                goalsSpan.className = 'stat-goals';
                goalsSpan.textContent = fix.goalsValue.toFixed(1);
                statsDiv.appendChild(goalsSpan);

                cellDiv.appendChild(statsDiv);
                td.appendChild(cellDiv);

                td.style.backgroundColor = getCombinedColor(fix.defconProb, fix.goalsValue, maxGoals);
            }

            tr.appendChild(td);
        });

        tbody.appendChild(tr);
    });
}

// ==========================================
// UI CONTROLS
// ==========================================

function setupControls() {
    const positionSelect = document.getElementById('position-filter');
    positionSelect.addEventListener('change', (e) => {
        STATE.ui.position = e.target.value;
        renderTable();
    });

    const venueToggle = document.getElementById('venue-toggle');
    venueToggle.querySelectorAll('.toggle-option').forEach(opt => {
        opt.addEventListener('click', (e) => {
            venueToggle.querySelectorAll('.toggle-option').forEach(o => o.classList.remove('active'));
            e.target.classList.add('active');
            STATE.ui.venueFilter = e.target.dataset.value;
            renderTable();
        });
    });

    const goalsTypeToggle = document.getElementById('goals-type-toggle');
    goalsTypeToggle.querySelectorAll('.toggle-option').forEach(opt => {
        opt.addEventListener('click', (e) => {
            goalsTypeToggle.querySelectorAll('.toggle-option').forEach(o => o.classList.remove('active'));
            e.target.classList.add('active');
            STATE.ui.goalsType = e.target.dataset.value;
            renderTable();
        });
    });

    const formSlider = document.getElementById('form-filter');
    const formValue = document.getElementById('form-filter-value');
    formSlider.addEventListener('input', (e) => {
        const val = parseInt(e.target.value, 10);
        STATE.ui.formFilter = val;
        formValue.textContent = val === 0 ? 'All Time' : `Last ${val} GW${val > 1 ? 's' : ''}`;
        renderTable();
    });

    const gwStart = document.getElementById('gw-start');
    const gwEnd = document.getElementById('gw-end');
    gwStart.addEventListener('change', (e) => {
        STATE.ui.startGW = parseInt(e.target.value, 10);
        renderTable();
    });
    gwEnd.addEventListener('change', (e) => {
        STATE.ui.endGW = parseInt(e.target.value, 10);
        renderTable();
    });

    const gwExclude = document.getElementById('gw-exclude');
    gwExclude.addEventListener('input', (e) => {
        STATE.ui.excludedGWs = parseExcludedGWs(e.target.value, CONFIG.UI.MAX_GW);
        renderTable();
    });

    const sortBy = document.getElementById('sort-by');
    sortBy.addEventListener('change', (e) => {
        STATE.ui.sortMode.type = e.target.value;
        STATE.ui.sortMode.gw = null;
        renderTable();
    });
}

// ==========================================
// INITIALIZATION
// ==========================================

async function init() {
    try {
        const data = await loadAllData(false);
        STATE.data = data;

        document.getElementById('loading').style.display = 'none';
        document.getElementById('main-content').style.display = 'block';

        processData();
        setupControls();
        renderTable();

    } catch (err) {
        console.error('Initialization failed:', err);
        const errorDiv = document.getElementById('error');
        errorDiv.textContent = `Error: ${err.message}`;
        errorDiv.style.display = 'block';
        document.getElementById('loading').style.display = 'none';
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
