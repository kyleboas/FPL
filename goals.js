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
        formFilter: 0, // 0 = all gameweeks, 1-12 = last N gameweeks
        startGW: 1,
        endGW: 6,
        excludedGWs: [],
        sortMode: {
            type: 'max',      // 'max' | 'avg' | 'total' | 'column'
            direction: 'desc',
            gw: null
        }
    },
    latestGW: 0 // Track the latest completed gameweek
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

    // Track latest completed gameweek
    let latestCompletedGW = 0;

    // Process fixtures to extract goals data
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

        // Home team - always add fixture to lookup
        if (hCode != null && STATE.lookups.fixturesByTeam[hCode]) {
            STATE.lookups.fixturesByTeam[hCode][gw] = {
                opponentCode: aCode,
                wasHome: true,
                finished: isFin,
                goalsFor: hGoals,
                goalsAgainst: aGoals
            };

            // Only track goals for finished fixtures
            if (isFin) {
                STATE.lookups.teamGoals[hCode]['combined'][gw] = { for: hGoals, against: aGoals };
                STATE.lookups.teamGoals[hCode]['home'][gw] = { for: hGoals, against: aGoals };
            }
        }

        // Away team - always add fixture to lookup
        if (aCode != null && STATE.lookups.fixturesByTeam[aCode]) {
            STATE.lookups.fixturesByTeam[aCode][gw] = {
                opponentCode: hCode,
                wasHome: false,
                finished: isFin,
                goalsFor: aGoals,
                goalsAgainst: hGoals
            };

            // Only track goals for finished fixtures
            if (isFin) {
                STATE.lookups.teamGoals[aCode]['combined'][gw] = { for: aGoals, against: hGoals };
                STATE.lookups.teamGoals[aCode]['away'][gw] = { for: aGoals, against: hGoals };
            }
        }
    });

    // Save the latest completed gameweek
    STATE.latestGW = latestCompletedGW;

    console.log('=== Goals Data Processed ===');
    console.log('Fixtures processed:', fixtures.length);
    console.log('Teams tracked:', Object.keys(STATE.lookups.teamGoals).length);
    console.log('Latest completed GW:', STATE.latestGW);
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

function getGoalsColor(value, statType, maxValue) {
    // Color scheme: use red gradient for both
    // For cumulative goals, scale dynamically based on the maximum value shown

    // Use at least 1 to avoid division by zero
    const scale = Math.max(1, maxValue);

    if (statType === 'for') {
        // Goals for: 0 (white) to maxValue (dark red)
        const intensity = Math.min(1, value / scale);
        const g = Math.floor(255 * (1 - intensity));
        const b = Math.floor(255 * (1 - intensity));
        return `rgb(255, ${g}, ${b})`;
    } else {
        // Goals against: 0 (white) to maxValue (dark red)
        const intensity = Math.min(1, value / scale);
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
        // Default to showing "best" matchups first
        // For "goals for": 'asc' shows lowest values (weaker attacks)
        // For "goals against": 'desc' shows highest values (weaker defenses)
        mode.direction = STATE.ui.statType === 'for' ? 'asc' : 'desc';
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

    // Pre-calculate cumulative goals for all teams up to each GW
    // Track home, away, and combined separately so we can show the right stats
    const cumulativeGoalsByTeam = {};
    teams.forEach(team => {
        const teamCode = team.code;
        cumulativeGoalsByTeam[teamCode] = {
            combined: {},
            home: {},
            away: {}
        };

        let combinedFor = 0, combinedAgainst = 0;
        let homeFor = 0, homeAgainst = 0;
        let awayFor = 0, awayAgainst = 0;

        // Calculate cumulative for all GWs (not just the filtered gwList)
        for (let gw = 1; gw <= CONFIG.UI.MAX_GW; gw++) {
            const fix = fixturesByTeam[teamCode] ? fixturesByTeam[teamCode][gw] : null;

            if (fix && fix.finished) {
                const goalsFor = fix.goalsFor || 0;
                const goalsAgainst = fix.goalsAgainst || 0;

                // Always accumulate combined
                combinedFor += goalsFor;
                combinedAgainst += goalsAgainst;

                // Accumulate home or away based on fixture
                if (fix.wasHome) {
                    homeFor += goalsFor;
                    homeAgainst += goalsAgainst;
                } else {
                    awayFor += goalsFor;
                    awayAgainst += goalsAgainst;
                }
            }

            cumulativeGoalsByTeam[teamCode].combined[gw] = {
                for: combinedFor,
                against: combinedAgainst
            };
            cumulativeGoalsByTeam[teamCode].home[gw] = {
                for: homeFor,
                against: homeAgainst
            };
            cumulativeGoalsByTeam[teamCode].away[gw] = {
                for: awayFor,
                against: awayAgainst
            };
        }
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
            // Check if this fixture matches the venue filter
            const fix = fixturesByTeam[teamCode] ? fixturesByTeam[teamCode][gw] : null;

            // Apply venue filter
            if (venueFilter === 'home' && fix && !fix.wasHome) {
                fixtures.push({ type: 'FILTERED', cumulativeValue: null });
                gwValueMap[gw] = null;
                return;
            }
            if (venueFilter === 'away' && fix && fix.wasHome) {
                fixtures.push({ type: 'FILTERED', cumulativeValue: null });
                gwValueMap[gw] = null;
                return;
            }

            if (!fix) {
                // No fixture scheduled
                fixtures.push({ type: 'BLANK', cumulativeValue: null });
                gwValueMap[gw] = null;
                return;
            }

            const opponentCode = fix.opponentCode;
            const isHome = fix.wasHome;
            const oppTeam = teamsByCode[opponentCode];
            const oppName = oppTeam ? oppTeam.short_name : 'UNK';

            // Determine which venue stats to use for the opponent
            // If we're home, opponent is away (use their away stats)
            // If we're away, opponent is home (use their home stats)
            // If combined filter, use combined stats
            let oppVenue = 'combined';
            if (venueFilter === 'home') {
                oppVenue = 'away'; // We're home, so opponent is away
            } else if (venueFilter === 'away') {
                oppVenue = 'home'; // We're away, so opponent is home
            }

            // Get opponent's cumulative goals up to this GW for the appropriate venue
            const oppCumulative = cumulativeGoalsByTeam[opponentCode]
                ? cumulativeGoalsByTeam[opponentCode][oppVenue][gw]
                : null;

            if (!oppCumulative) {
                fixtures.push({ type: 'BLANK', cumulativeValue: null });
                gwValueMap[gw] = null;
                return;
            }

            // The value to display depends on what we're tracking
            // "for" means opponent's goals FOR (their attack strength)
            // "against" means opponent's goals AGAINST (their defense weakness)
            const oppCumulativeValue = statType === 'for' ? oppCumulative.for : oppCumulative.against;

            // For metrics, use the opponent's cumulative value at this GW
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
    // For "goals for": ascending (lower opponent goals is better - weaker attacks)
    // For "goals against": descending (higher opponent goals is better - weaker defenses)
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
            return dir * sortMultiplier * (va - vb);
        });
    }

    // Calculate the maximum value across all displayed cells for dynamic color scaling
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
        tdName.style.fontWeight = 'bold';
        tr.appendChild(tdName);

        row.fixtures.forEach(cell => {
            const td = document.createElement('td');

            if (cell.type === 'BLANK' || cell.type === 'FILTERED') {
                // No fixture or filtered out
                td.textContent = '-';
                td.style.backgroundColor = '#f4f4f4';
                td.style.color = '#999';
            } else if (cell.type === 'MATCH' || cell.type === 'FUTURE') {
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

                td.style.backgroundColor = getGoalsColor(cell.value, statType, globalMaxValue);

                // Adjust text color for readability - use 75% of max value as threshold
                const textThreshold = globalMaxValue * 0.75;
                const needsWhiteText = cell.value >= textThreshold;
                td.style.color = needsWhiteText ? 'white' : '#222';

                // Style future fixtures slightly differently
                if (cell.type === 'FUTURE') {
                    td.style.opacity = '0.8';
                    td.style.fontStyle = 'italic';
                }
            }
            tr.appendChild(td);
        });

        tbody.appendChild(tr);
    });
}

// ==========================================
// FORM FILTER LOGIC
// ==========================================

function applyFormFilter(formFilterValue) {
    const latestGW = STATE.latestGW || CONFIG.UI.MAX_GW;

    if (formFilterValue === 0) {
        // Show all gameweeks
        STATE.ui.startGW = 1;
        STATE.ui.endGW = latestGW;
    } else {
        // Show last N gameweeks
        STATE.ui.startGW = Math.max(1, latestGW - formFilterValue + 1);
        STATE.ui.endGW = latestGW;
    }

    // Update the input fields to reflect the change
    const startInput = document.getElementById('gw-start');
    const endInput = document.getElementById('gw-end');
    if (startInput) startInput.value = STATE.ui.startGW;
    if (endInput) endInput.value = STATE.ui.endGW;
}

function updateFormFilterDisplay(value) {
    const displayEl = document.getElementById('form-filter-value');
    if (!displayEl) return;

    if (value === 0) {
        displayEl.textContent = 'All Gameweeks';
    } else {
        displayEl.textContent = `Last ${value} GW${value > 1 ? 's' : ''}`;
    }
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

    // Form filter slider
    const formFilterSlider = document.getElementById('form-filter');
    formFilterSlider.addEventListener('input', (e) => {
        const value = parseInt(e.target.value, 10);
        STATE.ui.formFilter = value;
        updateFormFilterDisplay(value);
        applyFormFilter(value);
        renderTable();
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

        // Reset form filter when manual input is used
        STATE.ui.formFilter = 0;
        formFilterSlider.value = 0;
        updateFormFilterDisplay(0);

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

        // Reset form filter when manual input is used
        STATE.ui.formFilter = 0;
        formFilterSlider.value = 0;
        updateFormFilterDisplay(0);

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
