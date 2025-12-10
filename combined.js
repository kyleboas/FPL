/**
 * FPL Combined DEFCON & Goals View
 * Combines defensive action probabilities with goals statistics
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
        TEAMS:   'https://raw.githubusercontent.com/olbauday/FPL-Elo-Insights/main/data/2025-2026/teams.csv',
        POSITION_OVERRIDES: './data/player_position_overrides.csv'
    },
    THRESHOLDS: {
        DEF: 10,
        MID_FWD: 12
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
        fixturesByTeam: {},   // teamCode -> { gw -> { opponentCode, wasHome, finished, goalsFor, goalsAgainst } }
        probabilities: {},    // opponentCode -> { 'true'/'false' -> { archetype -> prob } }
        teamGoals: {},        // teamCode -> { venueKey -> { gw -> { for, against } } }
        positionOverrides: {} // player_id -> actual_position (LB, RB, CDM)
    },
    ui: {
        position: 'CB',          // DEFCON position filter
        venueFilter: 'combined', // Goals venue: 'combined' or 'homeaway'
        goalsType: 'for',        // 'for' or 'against'
        formFilter: 0,           // 0 = all time, 1-12 = last N GWs
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

const roundToTwo = (num) => {
    return Math.round(num * 100) / 100;
};

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

    const [players, teams, positionOverrides] = await Promise.all([
        fetchCSV(CONFIG.URLS.PLAYERS),
        fetchCSV(CONFIG.URLS.TEAMS),
        fetchCSVOptional(CONFIG.URLS.POSITION_OVERRIDES)
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

    return { players, teams, stats: allStats, fixtures: allFixtures, positionOverrides };
}

// ==========================================
// CORE LOGIC - DEFCON
// ==========================================

function deriveArchetype(player) {
    if (!player) return null;

    // Check position overrides first
    const pid = getVal(player, 'player_id', 'id');
    if (pid != null && STATE.lookups.positionOverrides[pid]) {
        const override = STATE.lookups.positionOverrides[pid];
        // LB and RB return as-is, CDM maps to MID
        if (['LB', 'RB'].includes(override)) return override;
        if (override === 'CDM') return 'MID';
    }

    // If you ever add detailed_position / role later, this still works
    const specific = player.detailed_position || player.role;
    if (specific) {
        if (['CB', 'LB', 'RB'].includes(specific)) return specific;
        if (['CDM', 'CAM', 'RM', 'LM', 'RW', 'LW'].includes(specific)) return 'MID';
        if (['ST', 'CF'].includes(specific)) return 'FWD';
    }

    // FPL-Elo players.csv: position = "Defender", "Midfielder", "Forward", "Goalkeeper"
    const posRaw = (player.position || '').toString().toLowerCase();

    if (posRaw.startsWith('goal')) return 'GKP';
    if (posRaw.startsWith('def'))  return 'CB';   // treat generic defender as CB archetype
    if (posRaw.startsWith('mid'))  return 'MID';
    if (posRaw.startsWith('for'))  return 'FWD';

    return null;
}

function checkDefconHit(stats, archetype) {
    const clr = getVal(stats, 'clearances', 'clearances_blocks_interceptions') || 0;
    const int = getVal(stats, 'interceptions') || 0;
    const tck = getVal(stats, 'tackles') || 0;
    const rec = getVal(stats, 'recoveries') || 0;

    if (['CB', 'LB', 'RB'].includes(archetype)) {
        return (clr + int + tck) >= CONFIG.THRESHOLDS.DEF;
    } else if (['MID', 'FWD'].includes(archetype)) {
        return (clr + int + tck + rec) >= CONFIG.THRESHOLDS.MID_FWD;
    }
    return false;
}

function processDefconData() {
    const { stats, players, teams } = STATE.data;
    const { playersById, teamsByCode, teamsById, fixturesByTeam } = STATE.lookups;

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

        const archetype = deriveArchetype(player);
        if (!archetype || archetype === 'GKP') return;

        const minutes = getVal(stat, 'minutes', 'minutes_played', 'minutes_x') || 0;
        if (minutes <= 0) return;

        const gw = getVal(stat, 'gw', 'gameweek', 'event', 'round');
        if (!gw) return;

        // Handle team reference - could be ID or code
        const teamRef = getVal(player, 'team', 'team_id', 'teamid', 'team_code');
        let teamCode = null;

        if (teamsByCode[teamRef]) {
            teamCode = teamRef;                 // already a code
        } else if (teamsById[teamRef]) {
            teamCode = teamsById[teamRef].code; // convert id → code
        }

        if (teamCode == null || !fixturesByTeam[teamCode]) return;

        const fixture = fixturesByTeam[teamCode][gw];
        if (!fixture) return;

        const opponentCode = fixture.opponentCode;
        const wasHome = !!fixture.wasHome;
        const venueKey = String(wasHome);

        if (!opponentCode) return;

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

    console.log('=== DEFCON Opponent Aggregates ===');
    Object.entries(STATE.lookups.probabilities).forEach(([oppCode, byVenue]) => {
        const team = teamsByCode[oppCode];
        const name = team ? team.short_name : oppCode;
        console.log(`Opponent ${name} (${oppCode})`, byVenue);
    });
}

// ==========================================
// CORE LOGIC - GOALS
// ==========================================

function processGoalsData() {
    const { fixtures, teams } = STATE.data;

    STATE.lookups.teamGoals = {};

    teams.forEach(t => {
        STATE.lookups.teamGoals[t.code] = {
            'combined': {},
            'home': {},
            'away': {}
        };
    });

    let latestCompletedGW = 0;

    fixtures.forEach(fix => {
        const hCode = getVal(fix, 'home_team', 'team_h', 'home_team_id');
        const aCode = getVal(fix, 'away_team', 'team_a', 'away_team_id');
        const hGoals = getVal(fix, 'team_h_score', 'home_score', 'home_goals') || 0;
        const aGoals = getVal(fix, 'team_a_score', 'away_score', 'away_goals') || 0;
        const isFin = String(getVal(fix, 'finished')).toLowerCase() === 'true';
        const gw = getVal(fix, 'gw', 'event', 'gameweek');

        if (isFin && gw > latestCompletedGW) {
            latestCompletedGW = gw;
        }

        // Home team
        if (hCode != null && STATE.lookups.fixturesByTeam[hCode]) {
            STATE.lookups.fixturesByTeam[hCode][gw].goalsFor = hGoals;
            STATE.lookups.fixturesByTeam[hCode][gw].goalsAgainst = aGoals;

            if (isFin) {
                STATE.lookups.teamGoals[hCode]['combined'][gw] = { for: hGoals, against: aGoals };
                STATE.lookups.teamGoals[hCode]['home'][gw] = { for: hGoals, against: aGoals };
            }
        }

        // Away team
        if (aCode != null && STATE.lookups.fixturesByTeam[aCode]) {
            STATE.lookups.fixturesByTeam[aCode][gw].goalsFor = aGoals;
            STATE.lookups.fixturesByTeam[aCode][gw].goalsAgainst = hGoals;

            if (isFin) {
                STATE.lookups.teamGoals[aCode]['combined'][gw] = { for: aGoals, against: hGoals };
                STATE.lookups.teamGoals[aCode]['away'][gw] = { for: aGoals, against: hGoals };
            }
        }
    });

    STATE.latestGW = latestCompletedGW;

    console.log('=== Goals Data Processed ===');
    console.log('Latest completed GW:', STATE.latestGW);
}

function processFixtures() {
    const { fixtures, teams } = STATE.data;
    const { teamsByCode } = STATE.lookups;

    STATE.lookups.fixturesByTeam = {};

    teams.forEach(t => {
        STATE.lookups.fixturesByTeam[t.code] = {};
    });

    fixtures.forEach(fix => {
        const hCode = getVal(fix, 'home_team', 'team_h', 'home_team_id');
        const aCode = getVal(fix, 'away_team', 'team_a', 'away_team_id');
        const isFin = String(getVal(fix, 'finished')).toLowerCase() === 'true';
        const gw = getVal(fix, 'gw', 'event', 'gameweek');

        // Home team
        if (hCode != null && STATE.lookups.fixturesByTeam[hCode]) {
            STATE.lookups.fixturesByTeam[hCode][gw] = {
                opponentCode: aCode,
                wasHome: true,
                finished: isFin
            };
        }

        // Away team
        if (aCode != null && STATE.lookups.fixturesByTeam[aCode]) {
            STATE.lookups.fixturesByTeam[aCode][gw] = {
                opponentCode: hCode,
                wasHome: false,
                finished: isFin
            };
        }
    });
}

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

    processFixtures();
    processGoalsData();
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

function getCombinedColor(defconProb, goalsValue, maxGoals) {
    // Create a gradient based on both values
    // Normalize both to 0-1 range
    const defconNorm = Math.min(1, Math.max(0, defconProb));
    const goalsNorm = Math.min(1, Math.max(0, goalsValue / Math.max(1, maxGoals)));

    // Average the two values for color intensity
    const intensity = (defconNorm + goalsNorm) / 2;

    const g = Math.floor(255 * (1 - intensity));
    const b = Math.floor(255 * (1 - intensity));
    return `rgb(255, ${g}, ${b})`;
}

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
    const excludedSet = new Set(STATE.ui.excludedGWs || []);

    const gwList = [];
    for (let gw = startGW; gw <= endGW; gw++) {
        if (!excludedSet.has(gw)) {
            gwList.push(gw);
        }
    }

    const { teams } = STATE.data;
    const { fixturesByTeam, probabilities, teamsByCode } = STATE.lookups;

    // Calculate cumulative goals per-match averages
    const cumulativeGoalsByTeam = {};
    const latestCompletedGW = STATE.latestGW || 0;

    teams.forEach(team => {
        const teamCode = team.code;
        cumulativeGoalsByTeam[teamCode] = {
            combined: {},
            home: {},
            away: {}
        };

        const windowEnd = latestCompletedGW;

        if (windowEnd < 1) {
            for (let gw = 1; gw <= CONFIG.UI.MAX_GW; gw++) {
                cumulativeGoalsByTeam[teamCode].combined[gw] = { for: 0, against: 0 };
                cumulativeGoalsByTeam[teamCode].home[gw] = { for: 0, against: 0 };
                cumulativeGoalsByTeam[teamCode].away[gw] = { for: 0, against: 0 };
            }
            return;
        }

        let windowStart;
        if (formFilter === 0) {
            windowStart = 1;
        } else {
            windowStart = Math.max(1, windowEnd - formFilter + 1);
        }

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

        const combinedForPer = combinedMatches > 0 ? roundToTwo(combinedFor / combinedMatches) : 0;
        const combinedAgainstPer = combinedMatches > 0 ? roundToTwo(combinedAgainst / combinedMatches) : 0;

        const homeForPer = homeMatches > 0 ? roundToTwo(homeFor / homeMatches) : combinedForPer;
        const homeAgainstPer = homeMatches > 0 ? roundToTwo(homeAgainst / homeMatches) : combinedAgainstPer;

        const awayForPer = awayMatches > 0 ? roundToTwo(awayFor / awayMatches) : combinedForPer;
        const awayAgainstPer = awayMatches > 0 ? roundToTwo(awayAgainst / awayMatches) : combinedAgainstPer;

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

            // Get DEFCON probability
            const defconProb = probabilities[oppCode]?.[venueKey]?.[position] || 0;

            // Get Goals value (opponent's goals based on our perspective)
            let goalsValue = 0;
            // When 'homeaway' is selected, show opponent's stats for their actual venue
            // (when we're home, opponent is away, and vice versa)
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
    } else if (sortMode.type === 'defcon-avg') {
        tableData.sort((a, b) => {
            let sumA = 0, countA = 0, sumB = 0, countB = 0;
            gwList.forEach(gw => {
                const fixA = a.fixtures[gw];
                const fixB = b.fixtures[gw];
                if (fixA) {
                    sumA += fixA.defconProb;
                    countA++;
                }
                if (fixB) {
                    sumB += fixB.defconProb;
                    countB++;
                }
            });
            const avgA = countA > 0 ? sumA / countA : 0;
            const avgB = countB > 0 ? sumB / countB : 0;
            return sortMode.direction === 'desc' ? avgB - avgA : avgA - avgB;
        });
    } else if (sortMode.type === 'goals-avg') {
        tableData.sort((a, b) => {
            let sumA = 0, countA = 0, sumB = 0, countB = 0;
            gwList.forEach(gw => {
                const fixA = a.fixtures[gw];
                const fixB = b.fixtures[gw];
                if (fixA) {
                    sumA += fixA.goalsValue;
                    countA++;
                }
                if (fixB) {
                    sumB += fixB.goalsValue;
                    countB++;
                }
            });
            const avgA = countA > 0 ? sumA / countA : 0;
            const avgB = countB > 0 ? sumB / countB : 0;
            return sortMode.direction === 'desc' ? avgB - avgA : avgA - avgB;
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
// UI CONTROLS & EVENT HANDLERS
// ==========================================

function setupControls() {
    // Position filter
    const positionSelect = document.getElementById('position-filter');
    positionSelect.addEventListener('change', (e) => {
        STATE.ui.position = e.target.value;
        renderTable();
    });

    // Venue toggle
    const venueToggle = document.getElementById('venue-toggle');
    venueToggle.querySelectorAll('.toggle-option').forEach(opt => {
        opt.addEventListener('click', (e) => {
            venueToggle.querySelectorAll('.toggle-option').forEach(o => o.classList.remove('active'));
            e.target.classList.add('active');
            STATE.ui.venueFilter = e.target.dataset.value;
            renderTable();
        });
    });

    // Goals type toggle
    const goalsTypeToggle = document.getElementById('goals-type-toggle');
    goalsTypeToggle.querySelectorAll('.toggle-option').forEach(opt => {
        opt.addEventListener('click', (e) => {
            goalsTypeToggle.querySelectorAll('.toggle-option').forEach(o => o.classList.remove('active'));
            e.target.classList.add('active');
            STATE.ui.goalsType = e.target.dataset.value;
            renderTable();
        });
    });

    // Form filter slider
    const formSlider = document.getElementById('form-filter');
    const formValue = document.getElementById('form-filter-value');
    formSlider.addEventListener('input', (e) => {
        const val = parseInt(e.target.value, 10);
        STATE.ui.formFilter = val;
        formValue.textContent = val === 0 ? 'All Time' : `Last ${val} GW${val > 1 ? 's' : ''}`;
        renderTable();
    });

    // GW range
    const gwStart = document.getElementById('gw-start');
    const gwEnd = document.getElementById('gw-end');
    const gwExclude = document.getElementById('gw-exclude');

    // Default window: first unplayed GW (latest completed + 1) to 5 GWs after
    const nextUnplayedGW = Math.min((STATE.latestGW || 0) + 1, CONFIG.UI.MAX_GW);
    const defaultEndGW   = Math.min(nextUnplayedGW + 5, CONFIG.UI.MAX_GW);

    STATE.ui.startGW = nextUnplayedGW;
    STATE.ui.endGW   = defaultEndGW;
    STATE.ui.excludedGWs = parseExcludedGWs(gwExclude.value);

    // Reflect defaults in the inputs
    gwStart.value = String(nextUnplayedGW);
    gwEnd.value   = String(defaultEndGW);

    gwStart.addEventListener('change', (e) => {
        STATE.ui.startGW = parseInt(e.target.value, 10);
        renderTable();
    });
    gwEnd.addEventListener('change', (e) => {
        STATE.ui.endGW = parseInt(e.target.value, 10);
        renderTable();
    });

    // Excluded GWs
    gwExclude.addEventListener('input', (e) => {
        STATE.ui.excludedGWs = parseExcludedGWs(e.target.value);
        renderTable();
    });

    // Sort order
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
        const data = await loadData();
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

// Start when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
