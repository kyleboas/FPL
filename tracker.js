/**
 * FPL Team Tracker
 * Track your FPL players with DEFCON and Goals analysis
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
        TEAMS: 'https://raw.githubusercontent.com/olbauday/FPL-Elo-Insights/main/data/2025-2026/teams.csv',
        FPL_API_BASE: 'https://fantasy.premierleague.com/api',
        FPL_API_PROXIES: [
            'https://corsproxy.io/?',
            'https://api.allorigins.win/raw?url='
        ],
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
        fixtures: [],
        myPlayers: [] // User's FPL team players
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
        }
    },
    fplTeamId: null
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

async function fetchFPL(path) {
    const targetBase = CONFIG.URLS.FPL_API_BASE;
    const proxies = CONFIG.URLS.FPL_API_PROXIES;
    const targetUrl = `${targetBase}${path}`;

    const errors = [];

    for (const proxyBase of proxies) {
        const finalUrl = `${proxyBase}${encodeURIComponent(targetUrl)}`;

        try {
            const res = await fetch(finalUrl);

            if (!res.ok) {
                errors.push(`Proxy ${proxyBase} returned ${res.status}`);
                continue;
            }

            const text = await res.text();

            if (!text || text.trim() === '') {
                errors.push(`Proxy ${proxyBase} returned empty response`);
                continue;
            }

            try {
                return JSON.parse(text);
            } catch (parseErr) {
                errors.push(`Proxy ${proxyBase} returned invalid JSON`);
                continue;
            }
        } catch (fetchErr) {
            const errMsg = fetchErr.message || fetchErr.name || 'Network error';
            errors.push(`Proxy ${proxyBase} failed: ${errMsg}`);
            continue;
        }
    }

    throw new Error(`All proxies failed: ${errors.join('; ')}`);
}

async function fetchFPLTeam(teamId) {
    try {
        // Fetch current or next GW from bootstrap-static
        const bootstrap = await fetchFPL('/bootstrap-static/');

        const currentEvent =
            bootstrap.events.find(e => e.is_current) ||
            bootstrap.events.find(e => e.is_next);

        const eventId = currentEvent ? currentEvent.id : 1;

        // Fetch team picks for that event
        const picksData = await fetchFPL(`/entry/${teamId}/event/${eventId}/picks/`);

        const playerIds = (picksData.picks || []).map(pick => pick.element);

        return { playerIds, eventId };
    } catch (error) {
        console.error('Error fetching FPL team:', error);
        throw error;
    }
}

// ==========================================
// CORE LOGIC
// ==========================================

function deriveArchetype(player) {
    if (!player) return null;

    const pid = getVal(player, 'player_id', 'id');
    if (pid != null && STATE.lookups.positionOverrides[pid]) {
        const override = STATE.lookups.positionOverrides[pid];
        if (['LB', 'RB'].includes(override)) return override;
        if (override === 'CDM') return 'MID';
        if (override === 'CB') return 'CB';
        if (override === 'MID') return 'MID';
        if (override === 'FWD') return 'FWD';
    }

    const specific = player.detailed_position || player.role;
    if (specific) {
        if (['CB', 'LB', 'RB'].includes(specific)) return specific;
        if (['CDM', 'CAM', 'RM', 'LM', 'RW', 'LW'].includes(specific)) return 'MID';
        if (['ST', 'CF'].includes(specific)) return 'FWD';
    }

    const posRaw = (player.position || '').toString().toLowerCase();

    if (posRaw.startsWith('goal')) return 'GKP';
    if (posRaw.startsWith('def')) return 'CB';
    if (posRaw.startsWith('mid')) return 'MID';
    if (posRaw.startsWith('for')) return 'FWD';

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

function processProbabilities() {
    const { stats } = STATE.data;
    const { playersById, fixturesByTeam, teamsById, teamsByCode } = STATE.lookups;

    const opponentAgg = {};
    const initAgg = () => ({ hits: 0, trials: 0 });
    const archetypes = ['CB', 'LB', 'RB', 'MID', 'FWD'];

    stats.forEach(statRecord => {
        const minutes = getVal(statRecord, 'minutes', 'minutes_played', 'minutes_x');
        if ((minutes || 0) <= 0) return;

        const pID = getVal(statRecord, 'player_id', 'element', 'id');
        const player = playersById[pID];
        if (!player) return;

        const archetype = deriveArchetype(player);
        if (!archetype || archetype === 'GKP') return;

        const gw = getVal(statRecord, 'gw', 'gameweek', 'event', 'round');
        if (!gw) return;

        const teamRef = getVal(player, 'team', 'team_id', 'teamid', 'team_code');
        let teamCode;
        if (teamsByCode[teamRef]) {
            teamCode = teamRef;
        } else if (teamsById[teamRef]) {
            teamCode = teamsById[teamRef].code;
        } else {
            return;
        }

        const fixture = fixturesByTeam[teamCode] && fixturesByTeam[teamCode][gw];
        if (!fixture) return;

        const opponentCode = fixture.opponentCode;
        const venueKey = fixture.wasHome ? 'home' : 'away';

        if (!opponentAgg[opponentCode]) {
            opponentAgg[opponentCode] = {};
        }
        if (!opponentAgg[opponentCode][venueKey]) {
            opponentAgg[opponentCode][venueKey] = {};
        }
        archetypes.forEach(arch => {
            if (!opponentAgg[opponentCode][venueKey][arch]) {
                opponentAgg[opponentCode][venueKey][arch] = initAgg();
            }
        });

        const agg = opponentAgg[opponentCode][venueKey][archetype];
        agg.trials++;
        if (checkDefconHit(statRecord, archetype)) {
            agg.hits++;
        }
    });

    STATE.lookups.probabilities = {};
    Object.keys(opponentAgg).forEach(opp => {
        STATE.lookups.probabilities[opp] = {};
        Object.keys(opponentAgg[opp]).forEach(venue => {
            STATE.lookups.probabilities[opp][venue] = {};
            archetypes.forEach(arch => {
                const data = opponentAgg[opp][venue][arch];
                const prob = data.trials > 0 ? data.hits / data.trials : 0;
                STATE.lookups.probabilities[opp][venue][arch] = {
                    probability: prob,
                    hits: data.hits,
                    trials: data.trials
                };
            });
        });
    });

    console.log('=== DEFCON Probabilities Processed ===');
}

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

    fixtures.forEach(fix => {
        const hCode = getVal(fix, 'home_team', 'team_h', 'home_team_id');
        const aCode = getVal(fix, 'away_team', 'team_a', 'away_team_id');
        const hGoals = getVal(fix, 'team_h_score', 'home_score', 'home_goals') || 0;
        const aGoals = getVal(fix, 'team_a_score', 'away_score', 'away_goals') || 0;
        const isFin = String(getVal(fix, 'finished')).toLowerCase() === 'true';
        const gw = getVal(fix, 'gw', 'event', 'gameweek');

        if (isFin && hCode != null && STATE.lookups.teamGoals[hCode]) {
            STATE.lookups.teamGoals[hCode]['combined'][gw] = { for: hGoals, against: aGoals };
            STATE.lookups.teamGoals[hCode]['home'][gw] = { for: hGoals, against: aGoals };
        }

        if (isFin && aCode != null && STATE.lookups.teamGoals[aCode]) {
            STATE.lookups.teamGoals[aCode]['combined'][gw] = { for: aGoals, against: hGoals };
            STATE.lookups.teamGoals[aCode]['away'][gw] = { for: aGoals, against: hGoals };
        }
    });

    console.log('=== Goals Data Processed ===');
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

    // Process position overrides
    STATE.lookups.positionOverrides = {};
    STATE.data.positionOverrides?.forEach(row => {
        const pid = getVal(row, 'player_id', 'id');
        const pos = getVal(row, 'actual_position', 'position');
        if (pid != null && pos) {
            STATE.lookups.positionOverrides[pid] = pos;
        }
    });

    // Build fixtures lookup
    STATE.lookups.fixturesByTeam = {};
    STATE.data.teams.forEach(t => {
        STATE.lookups.fixturesByTeam[t.code] = {};
    });

    STATE.data.fixtures.forEach(fix => {
        const hCode = getVal(fix, 'home_team', 'team_h', 'home_team_id');
        const aCode = getVal(fix, 'away_team', 'team_a', 'away_team_id');
        const isFin = String(getVal(fix, 'finished')).toLowerCase() === 'true';
        const gw = getVal(fix, 'gw', 'event', 'gameweek');

        if (hCode != null && STATE.lookups.fixturesByTeam[hCode]) {
            STATE.lookups.fixturesByTeam[hCode][gw] = {
                opponentCode: aCode,
                wasHome: true,
                finished: isFin
            };
        }

        if (aCode != null && STATE.lookups.fixturesByTeam[aCode]) {
            STATE.lookups.fixturesByTeam[aCode][gw] = {
                opponentCode: hCode,
                wasHome: false,
                finished: isFin
            };
        }
    });

    // Build player stats by GW
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

    processProbabilities();
    processGoalsData();

    console.log('=== Data Processing Complete ===');
}

// ==========================================
// RENDERING
// ==========================================

function getColorForValue(value, max, isInverted = false) {
    if (max === 0) return 'rgba(200, 200, 200, 0.1)';

    let normalized = value / max;
    if (isInverted) {
        normalized = 1 - normalized;
    }

    const intensity = normalized * 0.8;
    const red = Math.round(255 * intensity);
    return `rgba(${red}, ${Math.round(50 * intensity)}, ${Math.round(50 * intensity)}, ${intensity})`;
}

function getTextColor(bgColor) {
    const match = bgColor.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (!match) return '#000';

    const [_, r, g, b] = match.map(Number);
    const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;

    return luminance > 0.5 ? '#000' : '#fff';
}

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
    const { myPlayers } = STATE.data;
    const { playersById, fixturesByTeam, teamsById, teamsByCode, probabilities, teamGoals } = STATE.lookups;
    const { startGW, endGW, excludedGWs, sortMode } = STATE.ui;

    if (myPlayers.length === 0) {
        document.getElementById('status-bar').textContent = 'No players loaded. Enter your FPL Team ID and click "Load My Team".';
        return;
    }

    const gameweeks = [];
    for (let gw = startGW; gw <= endGW; gw++) {
        if (!excludedGWs.includes(gw)) {
            gameweeks.push(gw);
        }
    }

    // Build player rows
    const playerRows = myPlayers.map(playerId => {
        const player = playersById[playerId];
        if (!player) return null;

        const playerName = getVal(player, 'name', 'web_name', 'full_name') || 'Unknown';
        const teamRef = getVal(player, 'team', 'team_id', 'teamid', 'team_code');

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

        const archetype = deriveArchetype(player);
        const { totalPoints, pointsPer90 } = calculatePlayerStats(player);

        // Calculate averages for sorting
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

            // DEFCON probability
            let defconProb = 0;
            if (archetype && probabilities[oppCode]?.[venueKey]?.[archetype]) {
                defconProb = probabilities[oppCode][venueKey][archetype].probability * 100;
                defconSum += defconProb;
                defconCount++;
            }

            // Opponent goals
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
            avgGoalsAgainst: goalsCount > 0 ? goalsAgainstSum / goalsCount : 0
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
        } else { // name
            return a.playerName.localeCompare(b.playerName);
        }

        return sortMode.direction === 'desc' ? bVal - aVal : aVal - bVal;
    });

    // Find max values for coloring
    const maxDefcon = Math.max(...playerRows.flatMap(r => r.gwData.map(g => g.defconProb || 0)), 1);
    const maxGoalsFor = Math.max(...playerRows.flatMap(r => r.gwData.map(g => g.goalsFor || 0)), 1);
    const maxGoalsAgainst = Math.max(...playerRows.flatMap(r => r.gwData.map(g => g.goalsAgainst || 0)), 1);

    // Render header
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

    // Render body
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

        return `
            <tr>
                <td>
                    <div class="player-info">
                        <div class="player-name">${row.playerName}</div>
                        <div class="player-meta">${row.teamName} | ID: ${row.playerId}</div>
                        <div class="player-stats">Pts: ${row.totalPoints} | Pts/90: ${row.pointsPer90}</div>
                    </div>
                </td>
                ${cells}
            </tr>
        `;
    }).join('');

    document.getElementById('fixture-header').innerHTML = headerHTML;
    document.getElementById('fixture-body').innerHTML = bodyHTML;

    // Update status
    document.getElementById('status-bar').textContent =
        `Showing ${playerRows.length} players for GW${startGW}-${endGW}`;

    // Add column header click handlers
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
    STATE.ui.excludedGWs = parseExcludedGWs(document.getElementById('gw-exclude').value);

    const sortBy = document.getElementById('sort-by').value;
    STATE.ui.sortMode.type = sortBy;
    STATE.ui.sortMode.direction = 'desc';
    STATE.ui.sortMode.gw = null;

    renderTable();
}

function setupEventListeners() {
    document.getElementById('load-team').addEventListener('click', handleLoadTeam);

    document.getElementById('gw-start').addEventListener('change', handleFilterChange);
    document.getElementById('gw-end').addEventListener('change', handleFilterChange);
    document.getElementById('gw-exclude').addEventListener('input', handleFilterChange);
    document.getElementById('sort-by').addEventListener('change', handleFilterChange);
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
// INITIALIZATION
// ==========================================

async function init() {
    try {
        const data = await loadData();
        STATE.data.players = data.players;
        STATE.data.teams = data.teams;
        STATE.data.stats = data.stats;
        STATE.data.fixtures = data.fixtures;
        STATE.data.positionOverrides = data.positionOverrides || [];

        processData();

        document.getElementById('loading').style.display = 'none';
        document.getElementById('main-content').style.display = 'block';

        setupEventListeners();

        console.log('=== Tracker Initialized ===');
    } catch (error) {
        console.error('Initialization error:', error);
        showError(`Failed to load data: ${error.message}`);
    }
}

document.addEventListener('DOMContentLoaded', init);
