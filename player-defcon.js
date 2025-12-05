/**
 * Player DEFCON Statistics
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
    MODEL: {
        K_FACTOR: 0,
        MIN_PROB: 0.0,
        MAX_PROB: 1.0
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
        fixturesByTeam: {},
        probabilities: {},
        playerStatsByGW: {}, // playerId -> gw -> statRecord
        positionOverrides: {} // key: player_id -> actual_position (LB, RB, CDM)
    },
    ui: {
        positionFilter: 'DEF',
        teamFilter: 'ALL',
        startGW: 1,
        endGW: 6,
        excludedGWs: [],
        minMinutes: 90,
        sortMode: {
            type: 'defcon90', // 'defcon90' | 'max' | 'avg' | 'column'
            direction: 'desc',
            gw: null
        }
    }
};

// User-defined position overrides (separate from loaded overrides)
const USER_OVERRIDES = new Map(); // playerId -> position string

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

    // Check if there's an existing override (from file or user set)
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

    // Create CSV content
    let csvContent = 'player_id,actual_position\n';

    // Sort by player ID for consistency
    const sortedEntries = Array.from(USER_OVERRIDES.entries()).sort((a, b) => a[0] - b[0]);

    sortedEntries.forEach(([playerId, position]) => {
        csvContent += `${playerId},${position}\n`;
    });

    // Show modal with CSV content
    const modal = document.getElementById('csv-modal');
    const textarea = document.getElementById('csv-output');
    textarea.value = csvContent;
    modal.style.display = 'block';

    // Auto-select the text for easy copying
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
// CORE LOGIC
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

    const specific = player.detailed_position || player.role;
    if (specific) {
        if (['CB', 'LB', 'RB'].includes(specific)) return specific;
        if (['CDM', 'CAM', 'RM', 'LM', 'RW', 'LW'].includes(specific)) return 'MID';
        if (['ST', 'CF'].includes(specific)) return 'FWD';
    }

    const posRaw = (player.position || '').toString().toLowerCase();

    if (posRaw.startsWith('goal')) return 'GKP';
    if (posRaw.startsWith('def'))  return 'CB';
    if (posRaw.startsWith('mid'))  return 'MID';
    if (posRaw.startsWith('for'))  return 'FWD';

    return null;
}

function getPositionGroup(archetype) {
    if (archetype === 'GKP') return 'GKP';
    if (['CB', 'LB', 'RB'].includes(archetype)) return 'DEF';
    if (archetype === 'MID') return 'MID';
    if (archetype === 'FWD') return 'FWD';
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

function processProbabilities(startGW = 1, endGW = CONFIG.UI.MAX_GW, excludedGWs = []) {
    const { stats, teams } = STATE.data;
    const { playersById, fixturesByTeam, teamsById, teamsByCode } = STATE.lookups;

    const opponentAgg = {};
    const initAgg = () => ({ hits: 0, trials: 0 });
    const archetypes = ['CB', 'LB', 'RB', 'MID', 'FWD'];
    const excludedSet = new Set(excludedGWs);

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

        // Only include stats from the specified GW range (form window)
        if (gw < startGW || gw > endGW || excludedSet.has(gw)) return;

        const teamRef = getVal(player, 'team', 'team_id', 'teamid', 'team_code');
        let teamCode = null;

        if (STATE.lookups.teamsByCode[teamRef]) {
            teamCode = teamRef;
        } else if (teamsById[teamRef]) {
            teamCode = teamsById[teamRef].code;
        }

        if (teamCode == null || !fixturesByTeam[teamCode]) return;

        const fixture = fixturesByTeam[teamCode][gw];
        if (!fixture) return;

        const opponentCode = fixture.opponentCode;
        const wasHome = !!fixture.wasHome;
        const venueKey = String(wasHome);

        if (!opponentCode) return;

        const isHit = checkDefconHit(statRecord, archetype);

        if (!opponentAgg[opponentCode]) {
            opponentAgg[opponentCode] = { 'true': {}, 'false': {} };
        }
        if (!opponentAgg[opponentCode][venueKey][archetype]) {
            opponentAgg[opponentCode][venueKey][archetype] = initAgg();
        }

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

                if (opponentAgg[teamCode] &&
                    opponentAgg[teamCode][venueKey] &&
                    opponentAgg[teamCode][venueKey][arch]) {
                    hits   = opponentAgg[teamCode][venueKey][arch].hits;
                    trials = opponentAgg[teamCode][venueKey][arch].trials;
                }

                const prob = trials > 0 ? (hits / trials) : 0;

                STATE.lookups.probabilities[teamCode][venueKey][arch] = prob;
            });
        });
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

    STATE.lookups.fixturesByTeam = {};
    STATE.data.teams.forEach(t => STATE.lookups.fixturesByTeam[t.code] = {});

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

    processProbabilities();
}

// ==========================================
// UI RENDERING
// ==========================================

function getProbabilityColor(prob, archetype) {
    let start = 0.2;
    let span  = 0.6;

    if (archetype === 'MID') {
        start = 0.10;
        span  = 0.40;
    }

    const intensity = Math.min(1, Math.max(0, (prob - start) / span));
    const g = Math.floor(255 * (1 - intensity));
    const b = Math.floor(255 * (1 - intensity));
    return `rgb(255, ${g}, ${b})`;
}

// Parse excluded GWs from input string
function parseExcludedGWs(inputValue) {
    if (!inputValue) return [];
    return inputValue
        .split(',')
        .map(s => parseInt(s.trim(), 10))
        .filter(n => !isNaN(n) && n >= 1 && n <= CONFIG.UI.MAX_GW);
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
    const { positionFilter, teamFilter, sortMode, minMinutes } = STATE.ui;
    const startGW = parseInt(STATE.ui.startGW, 10);
    const endGW   = parseInt(STATE.ui.endGW, 10);
    const excludedSet = new Set(STATE.ui.excludedGWs || []);

    // Recalculate probabilities based on the selected form window (startGW to endGW)
    processProbabilities(startGW, endGW, STATE.ui.excludedGWs || []);

    // Build GW list to display - show upcoming fixtures starting from endGW + 1
    // This way the form window (startGW to endGW) defines the historical data used,
    // and we show the upcoming fixtures with those calculated probabilities
    const gwList = [];
    const displayStartGW = endGW + 1;
    const displayEndGW = Math.min(displayStartGW + 9, CONFIG.UI.MAX_GW); // Show next 10 GWs

    for (let gw = displayStartGW; gw <= displayEndGW; gw++) {
        gwList.push(gw);
    }

    const { players, stats } = STATE.data;
    const { playersById, fixturesByTeam, probabilities, teamsByCode, teamsById } = STATE.lookups;

    const thead = document.getElementById('fixture-header');
    const tbody = document.getElementById('fixture-body');

    // Render header
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

    // Build player data
    let rowData = players.map(player => {
        const pid = getVal(player, 'player_id', 'id');
        if (!pid) return null;

        const archetype = deriveArchetype(player);
        if (!archetype) return null;

        // Get position group for filtering
        const posGroup = getPositionGroup(archetype);
        if (positionFilter !== 'ALL' && posGroup !== positionFilter) {
            return null;
        }

        // Get team info
        const teamRef = getVal(player, 'team', 'team_id', 'teamid', 'team_code');
        let teamCode = null;
        if (STATE.lookups.teamsByCode[teamRef]) {
            teamCode = teamRef;
        } else if (teamsById[teamRef]) {
            teamCode = teamsById[teamRef].code;
        }

        // Filter by team
        if (teamFilter !== 'ALL' && teamCode !== teamFilter) {
            return null;
        }

        const teamName = teamCode ? (teamsByCode[teamCode]?.short_name || teamCode) : 'Unknown';
        const playerName = getVal(player, 'name', 'web_name', 'player_name') || 'Unknown';

        // Calculate total minutes and defcon hits from the FORM WINDOW (startGW to endGW)
        let totalMinutes = 0;
        let totalDefconHits = 0;

        for (let gw = startGW; gw <= endGW; gw++) {
            if (excludedSet.has(gw)) continue;

            const statRecord = stats.find(s => {
                const sID = getVal(s, 'player_id', 'element', 'id');
                const sGW = getVal(s, 'gw', 'gameweek', 'event', 'round');
                return sID === pid && sGW === gw;
            });

            if (statRecord) {
                const minutes = getVal(statRecord, 'minutes', 'minutes_played', 'minutes_x') || 0;
                totalMinutes += minutes;
                const defconHit = checkDefconHit(statRecord, archetype);
                if (defconHit) {
                    totalDefconHits++;
                }
            }
        }

        // Build fixtures array for DISPLAY (upcoming fixtures)
        const fixtures = [];
        const gwProbMap = {};
        let metrics = [];

        gwList.forEach(gw => {
            // Get fixture for this team in this GW
            const fix = teamCode && fixturesByTeam[teamCode] ? fixturesByTeam[teamCode][gw] : null;

            // If no fixture exists for this GW, mark as BLANK
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

            // Calculate probability using the form window data
            let prob = CONFIG.MODEL.MIN_PROB;
            if (probabilities[opponentCode] &&
                probabilities[opponentCode][venueKey] &&
                probabilities[opponentCode][venueKey][archetype]) {
                prob = probabilities[opponentCode][venueKey][archetype];
            }

            const oppTeam = teamsByCode[opponentCode];
            const oppName = oppTeam ? oppTeam.short_name : 'UNK';

            fixtures.push({
                type: 'MATCH',
                opponent: oppName,
                venue: isHome ? '(H)' : '(A)',
                prob: prob,
                finished: finished
            });

            metrics.push(prob);
            gwProbMap[gw] = prob;
        });

        // Apply minimum minutes filter
        if (totalMinutes < minMinutes) {
            return null;
        }

        const defconPer90 = totalMinutes > 0 ? (totalDefconHits / totalMinutes) * 90 : 0;
        const validMetrics = metrics.filter(m => m > 0);
        const maxVal = validMetrics.length ? Math.max(...validMetrics) : 0;
        const avgVal = validMetrics.length ? (validMetrics.reduce((a,b)=>a+b,0) / validMetrics.length) : 0;

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

    // Render body
    tbody.innerHTML = '';
    rowData.forEach(row => {
        const tr = document.createElement('tr');

        // Player name cell with team below
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

        // Position override cell
        const tdPosition = document.createElement('td');
        const positionSelect = createPositionSelect(row.playerId, row.archetype);
        tdPosition.appendChild(positionSelect);
        tr.appendChild(tdPosition);

        // Fixture cells
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
                td.style.backgroundColor = getProbabilityColor(cell.prob, row.archetype);

                const colorIntensityCutoff = 0.6;
                const whiteText =
                    (row.archetype === 'MID'  && cell.prob >= 0.45) ||
                    (row.archetype === 'FWD'  && cell.prob >= 0.50) ||
                    (['CB','LB','RB'].includes(row.archetype) && cell.prob >= 0.60);

                td.style.color = whiteText ? 'white' : '#222';
            }
            tr.appendChild(td);
        });

        tbody.appendChild(tr);
    });

    // Update status bar
    const statusEl = document.getElementById('status-bar');
    if (statusEl) {
        statusEl.textContent = `Showing ${rowData.length} players`;
    }
}

// ==========================================
// EVENT LISTENERS
// ==========================================

function setupEventListeners() {
    // Position filter
    document.getElementById('position-filter').addEventListener('change', (e) => {
        STATE.ui.positionFilter = e.target.value;
        renderTable();
    });

    // Team filter
    document.getElementById('team-filter').addEventListener('change', (e) => {
        STATE.ui.teamFilter = e.target.value;
        renderTable();
    });

    // GW range
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

    // Excluded GWs
    document.getElementById('gw-exclude').addEventListener('change', (e) => {
        STATE.ui.excludedGWs = parseExcludedGWs(e.target.value);
        renderTable();
    });

    // Min minutes
    document.getElementById('min-minutes').addEventListener('change', (e) => {
        STATE.ui.minMinutes = parseInt(e.target.value, 10) || 0;
        renderTable();
    });

    // Sort mode
    document.getElementById('sort-by').addEventListener('change', (e) => {
        const value = e.target.value;
        STATE.ui.sortMode.type = value;
        STATE.ui.sortMode.direction = 'desc';
        STATE.ui.sortMode.gw = null;
        renderTable();
    });

    // Export position overrides button
    document.getElementById('export-overrides').addEventListener('click', exportOverrides);

    // Modal close button
    document.getElementById('close-modal').addEventListener('click', closeModal);

    // Copy to clipboard button
    document.getElementById('copy-csv').addEventListener('click', copyToClipboard);

    // Close modal when clicking outside
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
        const data = await loadData();
        STATE.data = data;

        processData();

        // Populate team filter dropdown
        const teamSelect = document.getElementById('team-filter');
        STATE.data.teams.forEach(team => {
            const option = document.createElement('option');
            option.value = team.code;
            option.textContent = team.short_name || team.name;
            teamSelect.appendChild(option);
        });

        document.getElementById('loading').style.display = 'none';
        document.getElementById('main-content').style.display = 'block';

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

// Start the application
init();
