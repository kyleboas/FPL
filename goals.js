/**
 * FPL Goals Statistics
 */

// ==========================================
// CONFIGURATION & CONSTANTS
// ==========================================

const CONFIG = {
    PATHS: {
        SEASON_BASE: 'https://raw.githubusercontent.com/olbauday/FPL-Elo-Insights/main/data/2025-2026',
        PL_TOURNAMENT_BASE: 'https://raw.githubusercontent.com/olbauday/FPL-Elo-Insights/main/data/2025-2026/By%20Tournament/Premier%20League'
    },
    URLS: {
        PLAYERS: 'https://raw.githubusercontent.com/olbauday/FPL-Elo-Insights/main/data/2025-2026/players.csv',
        TEAMS:   'https://raw.githubusercontent.com/olbauday/FPL-Elo-Insights/main/data/2025-2026/teams.csv'
    },
    UI: {
        MAX_GW: 38
    }
};

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
        fixturesByTeam: {}, // teamCode -> { gw -> { opponentCode, wasHome, finished, goalsFor, goalsAgainst } }
        teamGoals: {} // teamCode -> { venueKey -> { gw -> { for, against } } }
    },
    ui: {
        statType: 'for', // 'for' or 'against'
        venueFilter: 'combined', // 'combined', 'home', 'away'
        startGW: 1,
        endGW: 6,
        excludedGWs: [],
        sortMode: {
            type: 'max',      // 'max' | 'avg' | 'total' | 'column'
            direction: 'desc',
            gw: null
        }
    }
};

// ==========================================
// UTILITIES & PARSING
// ==========================================

const CSVParser = {
    parse: (text) => {
        if (!text) return [];
        const lines = text.trim().split('\n');
        if (lines.length < 2) return [];

        const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
        const result = [];

        for (let i = 1; i < lines.length; i++) {
            if (!lines[i].trim()) continue;

            const row = {};
            let currentLine = lines[i];

            let values = currentLine.split(',');
            if (values.length > headers.length) {
                values = [];
                let inQuote = false;
                let buffer = '';
                for (let char of currentLine) {
                    if (char === '"') {
                        inQuote = !inQuote;
                    } else if (char === ',' && !inQuote) {
                        values.push(buffer);
                        buffer = '';
                    } else {
                        buffer += char;
                    }
                }
                values.push(buffer);
            }

            if (values.length < headers.length) continue;

            headers.forEach((header, index) => {
                let val = values[index] ? values[index].trim() : '';
                if (val.startsWith('"') && val.endsWith('"')) {
                    val = val.slice(1, -1);
                }

                if (!isNaN(val) && val !== '') {
                    val = Number(val);
                } else if (val.toLowerCase() === 'true') {
                    val = true;
                } else if (val.toLowerCase() === 'false') {
                    val = false;
                }
                row[header] = val;
            });
            result.push(row);
        }
        return result;
    }
};

const getVal = (obj, ...keys) => {
    for (let k of keys) {
        if (obj[k] !== undefined) return obj[k];
    }
    return undefined;
};

// Parse excluded GWs from input string
function parseExcludedGWs(inputValue) {
    if (!inputValue) return [];
    return inputValue
        .split(',')
        .map(s => parseInt(s.trim(), 10))
        .filter(n => !isNaN(n) && n >= 1 && n <= CONFIG.UI.MAX_GW);
}

// ==========================================
// DATA LOADING
// ==========================================

async function loadData() {
    const updateStatus = (msg) => {
        const el = document.getElementById('loading');
        if (el) el.textContent = msg;
        console.log(`[System]: ${msg}`);
    };

    const fetchCSV = async (url) => {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Failed to load ${url} (${res.status})`);
        const text = await res.text();
        return CSVParser.parse(text);
    };

    const fetchCSVOptional = async (url) => {
        try {
            const res = await fetch(url);
            if (!res.ok) return [];
            const text = await res.text();
            return CSVParser.parse(text);
        } catch (e) {
            return [];
        }
    };

    updateStatus("Fetching Season Metadata...");

    const [players, teams] = await Promise.all([
        fetchCSV(CONFIG.URLS.PLAYERS),
        fetchCSV(CONFIG.URLS.TEAMS)
    ]);

    updateStatus(`Loaded ${players.length} Players and ${teams.length} Teams. Fetching GW Data...`);

    const allStats = [];
    const allFixtures = [];

    const batchSize = 5;
    for (let gw = 1; gw <= CONFIG.UI.MAX_GW; gw += batchSize) {
        const promises = [];
        for (let j = 0; j < batchSize; j++) {
            const currentGW = gw + j;
            if (currentGW > CONFIG.UI.MAX_GW) break;

            const gwPath = `${CONFIG.PATHS.PL_TOURNAMENT_BASE}/GW${currentGW}`;
            const statsUrl = `${gwPath}/player_gameweek_stats.csv`;
            const fixturesUrl = `${gwPath}/fixtures.csv`;

            promises.push(
                Promise.all([
                    fetchCSVOptional(statsUrl),
                    fetchCSVOptional(fixturesUrl),
                    currentGW
                ])
            );
        }

        const results = await Promise.all(promises);

        results.forEach(([gwStats, gwFixtures, gNum]) => {
            gwStats.forEach(row => row.gw = row.gw || row.gameweek || gNum);
            gwFixtures.forEach(row => row.gw = row.gw || row.gameweek || gNum);

            allStats.push(...gwStats);
            allFixtures.push(...gwFixtures);
        });

        updateStatus(`Fetching Data... processed up to GW${Math.min(gw+batchSize, CONFIG.UI.MAX_GW)}`);
    }

    return { players, teams, stats: allStats, fixtures: allFixtures };
}

// ==========================================
// CORE LOGIC
// ==========================================

function processGoalsData() {
    const { fixtures, teams } = STATE.data;
    const { teamsById, teamsByCode } = STATE.lookups;

    // Initialize fixture lookup and goals tracking
    STATE.lookups.fixturesByTeam = {};
    STATE.lookups.teamGoals = {};

    teams.forEach(t => {
        STATE.lookups.fixturesByTeam[t.code] = {};
        STATE.lookups.teamGoals[t.code] = {
            'combined': {},
            'home': {},
            'away': {}
        };
    });

    // Process fixtures to extract goals data
    fixtures.forEach(fix => {
        const hCode = getVal(fix, 'home_team', 'team_h', 'home_team_id');
        const aCode = getVal(fix, 'away_team', 'team_a', 'away_team_id');
        const hGoals = getVal(fix, 'team_h_score', 'home_score', 'home_goals') || 0;
        const aGoals = getVal(fix, 'team_a_score', 'away_score', 'away_goals') || 0;
        const isFin = String(getVal(fix, 'finished')).toLowerCase() === 'true';
        const gw = getVal(fix, 'gw', 'event', 'gameweek');

        if (!isFin) return; // Only process finished fixtures

        // Home team
        if (hCode != null && STATE.lookups.fixturesByTeam[hCode]) {
            STATE.lookups.fixturesByTeam[hCode][gw] = {
                opponentCode: aCode,
                wasHome: true,
                finished: isFin,
                goalsFor: hGoals,
                goalsAgainst: aGoals
            };

            // Track goals
            STATE.lookups.teamGoals[hCode]['combined'][gw] = { for: hGoals, against: aGoals };
            STATE.lookups.teamGoals[hCode]['home'][gw] = { for: hGoals, against: aGoals };
        }

        // Away team
        if (aCode != null && STATE.lookups.fixturesByTeam[aCode]) {
            STATE.lookups.fixturesByTeam[aCode][gw] = {
                opponentCode: hCode,
                wasHome: false,
                finished: isFin,
                goalsFor: aGoals,
                goalsAgainst: hGoals
            };

            // Track goals
            STATE.lookups.teamGoals[aCode]['combined'][gw] = { for: aGoals, against: hGoals };
            STATE.lookups.teamGoals[aCode]['away'][gw] = { for: aGoals, against: hGoals };
        }
    });

    console.log('=== Goals Data Processed ===');
    console.log('Fixtures processed:', fixtures.length);
    console.log('Teams tracked:', Object.keys(STATE.lookups.teamGoals).length);
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

    processGoalsData();

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

function getGoalsColor(value, statType) {
    // Color scheme:
    // For goals FOR: more is better (green)
    // For goals AGAINST: less is better (green for low, red for high)

    if (statType === 'for') {
        // Goals for: 0-1 (white) to 4+ (green)
        const intensity = Math.min(1, value / 4);
        const r = Math.floor(255 * (1 - intensity));
        const g = 255;
        const b = Math.floor(255 * (1 - intensity));
        return `rgb(${r}, ${g}, ${b})`;
    } else {
        // Goals against: 0 (green) to 4+ (red)
        const intensity = Math.min(1, value / 4);
        const g = Math.floor(255 * (1 - intensity));
        const b = Math.floor(255 * (1 - intensity));
        return `rgb(255, ${g}, ${b})`;
    }
}

// Handle clicking on a GW header to sort by that column
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
    const { statType, venueFilter, sortMode } = STATE.ui;
    const startGW = parseInt(STATE.ui.startGW, 10);
    const endGW   = parseInt(STATE.ui.endGW, 10);
    const excludedSet = new Set(STATE.ui.excludedGWs || []);

    // Build GW list respecting range + exclusions
    const gwList = [];
    for (let gw = startGW; gw <= endGW; gw++) {
        if (!excludedSet.has(gw)) {
            gwList.push(gw);
        }
    }

    const { teams } = STATE.data;
    const { fixturesByTeam, teamGoals, teamsByCode } = STATE.lookups;

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
            // Check if this fixture matches the venue filter
            const fix = fixturesByTeam[teamCode] ? fixturesByTeam[teamCode][gw] : null;

            // Apply venue filter
            if (venueFilter === 'home' && fix && !fix.wasHome) {
                fixtures.push({ type: 'FILTERED' });
                gwValueMap[gw] = null;
                return;
            }
            if (venueFilter === 'away' && fix && fix.wasHome) {
                fixtures.push({ type: 'FILTERED' });
                gwValueMap[gw] = null;
                return;
            }

            if (!fix || !fix.finished) {
                fixtures.push({ type: 'BLANK' });
                gwValueMap[gw] = null;
                return;
            }

            const opponentCode = fix.opponentCode;
            const isHome = fix.wasHome;
            const goalsFor = fix.goalsFor || 0;
            const goalsAgainst = fix.goalsAgainst || 0;
            const value = statType === 'for' ? goalsFor : goalsAgainst;

            const oppTeam = teamsByCode[opponentCode];
            const oppName = oppTeam ? oppTeam.short_name : 'UNK';

            fixtures.push({
                type: 'MATCH',
                opponent: oppName,
                venue: isHome ? '(H)' : '(A)',
                goalsFor: goalsFor,
                goalsAgainst: goalsAgainst,
                value: value
            });
            metrics.push(value);
            gwValueMap[gw] = value;
        });

        const validMetrics = metrics.filter(m => m !== null);
        const maxVal = validMetrics.length ? Math.max(...validMetrics) : 0;
        const avgVal = validMetrics.length ? (validMetrics.reduce((a,b)=>a+b,0) / validMetrics.length) : 0;
        const totalVal = validMetrics.reduce((a,b)=>a+b,0);

        return {
            teamName: team.name,
            fixtures,
            gwValueMap,
            maxVal,
            avgVal,
            totalVal
        };
    });

    // Sorting
    if (sortMode.type === 'max') {
        rowData.sort((a, b) => b.maxVal - a.maxVal);
    } else if (sortMode.type === 'avg') {
        rowData.sort((a, b) => b.avgVal - a.avgVal);
    } else if (sortMode.type === 'total') {
        rowData.sort((a, b) => b.totalVal - a.totalVal);
    } else if (sortMode.type === 'column' && sortMode.gw != null) {
        const dir = sortMode.direction === 'asc' ? 1 : -1;
        const gw = sortMode.gw;
        rowData.sort((a, b) => {
            const va = a.gwValueMap[gw] ?? -1;
            const vb = b.gwValueMap[gw] ?? -1;
            return dir * (va - vb);
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

            if (cell.type === 'BLANK' || cell.type === 'FILTERED') {
                td.textContent = '-';
                td.style.backgroundColor = '#f4f4f4';
            } else {
                const wrapper = document.createElement('div');
                wrapper.className = 'match-cell';

                const divOpp = document.createElement('div');
                divOpp.className = 'match-opp';
                divOpp.textContent = `${cell.opponent} ${cell.venue}`;

                const divValue = document.createElement('div');
                divValue.className = 'match-value';
                divValue.textContent = cell.value;

                wrapper.appendChild(divOpp);
                wrapper.appendChild(divValue);
                td.appendChild(wrapper);

                td.style.backgroundColor = getGoalsColor(cell.value, statType);

                // Adjust text color for readability
                const needsWhiteText =
                    (statType === 'for' && cell.value >= 3) ||
                    (statType === 'against' && cell.value >= 3);
                td.style.color = needsWhiteText ? 'white' : '#222';
            }
            tr.appendChild(td);
        });

        tbody.appendChild(tr);
    });
}

// ==========================================
// INITIALIZATION
// ==========================================

function setupEventListeners() {
    // Stat type selector
    document.getElementById('stat-type').addEventListener('change', (e) => {
        STATE.ui.statType = e.target.value;
        renderTable();
    });

    // Venue toggle
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

    const startInput = document.getElementById('gw-start');
    const endInput = document.getElementById('gw-end');
    const excludeInput = document.getElementById('gw-exclude');

    STATE.ui.startGW = parseInt(startInput.value, 10) || 1;
    STATE.ui.endGW = parseInt(endInput.value, 10) || Math.min(STATE.ui.startGW + 5, CONFIG.UI.MAX_GW);
    STATE.ui.excludedGWs = parseExcludedGWs(excludeInput.value);

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
        if (isNaN(val)) val = CONFIG.UI.MAX_GW;
        if (val < 1) val = 1;
        if (val > CONFIG.UI.MAX_GW) val = CONFIG.UI.MAX_GW;

        if (val < STATE.ui.startGW) {
            val = STATE.ui.startGW;
            e.target.value = String(val);
        }

        STATE.ui.endGW = val;
        renderTable();
    });

    excludeInput.addEventListener('input', (e) => {
        STATE.ui.excludedGWs = parseExcludedGWs(e.target.value);
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

async function init() {
    const loadingEl = document.getElementById('loading');
    const mainEl = document.getElementById('main-content');
    const errorEl = document.getElementById('error');

    try {
        const rawData = await loadData();
        STATE.data = rawData;
        processData();

        window.STATE = STATE;

        loadingEl.style.display = 'none';
        mainEl.style.display = 'block';

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
