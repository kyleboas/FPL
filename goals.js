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
        venueFilter: 'combined', // 'combined' or 'homeaway'
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

// Round a number to 2 decimal places
const roundToTwo = (num) => {
    return Math.round(num * 100) / 100;
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
    const { statType, venueFilter, sortMode, formFilter } = STATE.ui;
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

    // Pre-calculate opponent goals metric over the active form window.
    // We store per-match averages (goals for/against per game) for each team,
    // split by venue (combined, home, away). This lets us answer:
    //   - statType === 'against' -> goals conceded per match (weak defenses).
    //   - statType === 'for'     -> goals scored per match (attack strength).
    const cumulativeGoalsByTeam = {};
    const latestCompletedGW = STATE.latestGW || 0;

    teams.forEach(team => {
        const teamCode = team.code;
        cumulativeGoalsByTeam[teamCode] = {
            combined: {},
            home: {},
            away: {}
        };

        // Use ONE form window for the whole table,
        // based on the latest completed GW and the formFilter.
        const windowEnd = latestCompletedGW;

        // If no completed fixtures yet, everything is 0 for all GWs
        if (windowEnd < 1) {
            for (let gw = 1; gw <= CONFIG.UI.MAX_GW; gw++) {
                cumulativeGoalsByTeam[teamCode].combined[gw] = { for: 0, against: 0 };
                cumulativeGoalsByTeam[teamCode].home[gw]     = { for: 0, against: 0 };
                cumulativeGoalsByTeam[teamCode].away[gw]     = { for: 0, against: 0 };
            }
            return;
        }

        let windowStart;
        if (formFilter === 0) {
            // All completed GWs up to latestCompletedGW
            windowStart = 1;
        } else {
            // Last N completed GWs up to latestCompletedGW
            windowStart = Math.max(1, windowEnd - formFilter + 1);
        }

        // Aggregate raw totals AND match counts in this SINGLE window
        let combinedFor = 0, combinedAgainst = 0, combinedMatches = 0;
        let homeFor = 0, homeAgainst = 0, homeMatches = 0;
        let awayFor = 0, awayAgainst = 0, awayMatches = 0;

        for (let w = windowStart; w <= windowEnd; w++) {
            const fix = fixturesByTeam[teamCode] ? fixturesByTeam[teamCode][w] : null;
            if (fix && fix.finished) {
                const goalsFor = fix.goalsFor || 0;
                const goalsAgainst = fix.goalsAgainst || 0;

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
        }

        // Convert to per-match averages (goals per game).
        // If a team has no matches in the window, keep 0 so they appear neutral rather than extreme.
        const combinedForPer     = combinedMatches > 0 ? roundToTwo(combinedFor / combinedMatches) : 0;
        const combinedAgainstPer = combinedMatches > 0 ? roundToTwo(combinedAgainst / combinedMatches) : 0;

        // For home/away, if sample size is 0, fall back to combined average
        const homeForPer     = homeMatches > 0 ? roundToTwo(homeFor / homeMatches) : combinedForPer;
        const homeAgainstPer = homeMatches > 0 ? roundToTwo(homeAgainst / homeMatches) : combinedAgainstPer;

        const awayForPer     = awayMatches > 0 ? roundToTwo(awayFor / awayMatches) : combinedForPer;
        const awayAgainstPer = awayMatches > 0 ? roundToTwo(awayAgainst / awayMatches) : combinedAgainstPer;

        // Write the SAME per-match averages into every GW column for this team
        for (let gw = 1; gw <= CONFIG.UI.MAX_GW; gw++) {
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
            // Combined: use opponent's total goals regardless of venue
            // Home/Away: use venue-specific (if we're home, opponent is away; if we're away, opponent is home)
            let oppVenue = 'combined';
            if (venueFilter === 'homeaway') {
                oppVenue = isHome ? 'away' : 'home';
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

            // The value to display depends on what we're tracking.
            // We now use PER-MATCH averages from cumulativeGoalsByTeam:
            //   - statType === 'for'     -> opponent goals FOR per match (attack strength).
            //   - statType === 'against' -> opponent goals AGAINST per match (defensive weakness).
            // Lower "for" = weaker attack (better defensive fixture).
            // Higher "against" = leakier defense (better attacking fixture).
            const oppCumulativeValue = statType === 'for'
                ? oppCumulative.for
                : oppCumulative.against;

            // For metrics, use the opponent's per-match value at this GW
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
        const avgVal = validMetrics.length ? roundToTwo(validMetrics.reduce((a,b)=>a+b,0) / validMetrics.length) : 0;
        const totalVal = roundToTwo(validMetrics.reduce((a,b)=>a+b,0));

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
    // We sort on the per-match metric:
    //   - statType === 'against' -> higher goals conceded per match is better (weaker defenses).
    //   - statType === 'for'     -> lower goals scored per match is better (weaker attacks).
    const sortMultiplier = statType === 'for' ? 1 : -1;

    if (sortMode.type === 'max') {
        // Best single fixture in the window
        rowData.sort((a, b) => sortMultiplier * (a.maxVal - b.maxVal));
    } else if (sortMode.type === 'avg') {
        // Average fixture difficulty across the window
        rowData.sort((a, b) => sortMultiplier * (a.avgVal - b.avgVal));
    } else if (sortMode.type === 'total') {
        // Sum across GWs of the per-match metric
        rowData.sort((a, b) => sortMultiplier * (a.totalVal - b.totalVal));
    } else if (sortMode.type === 'column' && sortMode.gw != null) {
        // Column mode uses the raw per-match metric in the chosen direction:
        //   - 'asc'  = lowest metric first
        //   - 'desc' = highest metric first
        // Default direction (set in handleGwHeaderClick):
        //   - statType === 'for'     -> 'asc' (weakest attacks at the top)
        //   - statType === 'against' -> 'desc' (worst defenses at the top)
        const dir = sortMode.direction === 'asc' ? 1 : -1;
        const gw = sortMode.gw;
        rowData.sort((a, b) => {
            const va = a.gwValueMap[gw] ?? -1;
            const vb = b.gwValueMap[gw] ?? -1;
            return dir * (va - vb);
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
                divValue.textContent = roundToTwo(cell.value);

                wrapper.appendChild(divOpp);
                wrapper.appendChild(divValue);
                td.appendChild(wrapper);

                td.style.backgroundColor = getGoalsColor(cell.value, statType, globalMaxValue);

                // Adjust text color for readability
                if (cell.value < 0.85) {
                    // Always black when value is below 1
                    td.style.color = 'black';
                } else {
                    const textThreshold = globalMaxValue * 0.75;
                    const needsWhiteText = cell.value >= textThreshold;
                    td.style.color = needsWhiteText ? 'white' : 'black';
                }

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

function updateFormFilterDisplay(value) {
    const displayEl = document.getElementById('form-filter-value');
    if (!displayEl) return;

    if (value === 0) {
        displayEl.textContent = 'All Time';
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
        renderTable();
    });

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
        // Only update state if value is valid, but don't enforce startGW constraint during typing
        if (!isNaN(val) && val >= 1 && val <= CONFIG.UI.MAX_GW) {
            STATE.ui.endGW = val;
            renderTable();
        }
    });

    // Validate and correct end GW when user finishes typing
    endInput.addEventListener('blur', (e) => {
        let val = parseInt(e.target.value, 10);
        if (isNaN(val)) val = CONFIG.UI.MAX_GW;
        if (val < 1) val = 1;
        if (val > CONFIG.UI.MAX_GW) val = CONFIG.UI.MAX_GW;

        // Ensure endGW >= startGW
        if (val < STATE.ui.startGW) {
            val = STATE.ui.startGW;
        }

        e.target.value = String(val);
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
