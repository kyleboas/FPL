/**
 * FPL DEFCON PREDICTOR
 * Consolidated Single File Implementation
 */

// ==========================================
// 1. CONFIGURATION & CONSTANTS
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
    THRESHOLDS: {
        DEF: 10,
        MID_FWD: 12
    },
    MODEL: {
        K_FACTOR: 10,
        MIN_PROB: 0.05,
        MAX_PROB: 0.95
    },
    UI: {
        VISIBLE_GW_SPAN: 6,
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
        teamsById: {}, 
        playersById: {},
        fixturesByTeam: {}, 
        probabilities: {} 
    },
    ui: {
        currentArchetype: 'CB',
        startGW: 1,
        sortBy: 'max'
    }
};

// ==========================================
// 2. UTILITIES & PARSING
// ==========================================

const CSVParser = {
    // Improved Parser handles quoted strings correctly (e.g. "Fernandes, Bruno")
    parse: (text) => {
        if (!text) return [];
        const lines = text.trim().split('\n');
        if (lines.length < 2) return [];

        const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, '')); // Remove quotes from headers
        const result = [];

        // Regex to match CSV fields, respecting quotes
        // Matches: quoted string OR non-comma sequence
        const re = /(?:\"([^\"]*(?:\"\"[^\"]*)*)\")|([^\",]+)/g;

        for (let i = 1; i < lines.length; i++) {
            if (!lines[i].trim()) continue;

            const row = {};
            const matches = [];
            let match;
            // Simple split is risky, but for speed in browser JS on clean data:
            // Let's use a slightly robust split or fallback to standard split if no quotes found
            
            let currentLine = lines[i];
            
            // Basic comma split (Fallback for simple files)
            let values = currentLine.split(',');

            // If we have more commas than headers, likely have quoted strings. 
            // For this specific FPL data, names are often quoted.
            if (values.length > headers.length) {
                // Quick-fix parser for quoted CSVs
                values = [];
                let inQuote = false;
                let buffer = '';
                for(let char of currentLine) {
                    if(char === '"') {
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

            if (values.length < headers.length) continue; // Malformed row

            headers.forEach((header, index) => {
                let val = values[index] ? values[index].trim() : '';
                // Clean quotes
                if (val.startsWith('"') && val.endsWith('"')) {
                    val = val.slice(1, -1);
                }

                // Attempt numeric conversion
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

// Helper to handle header variations common in FPL data
const getVal = (obj, ...keys) => {
    for (let k of keys) {
        if (obj[k] !== undefined) return obj[k];
    }
    return undefined;
};

// ==========================================
// 3. DATA LOADING
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
    
    // 1) Season-level players / teams
    const [players, teams] = await Promise.all([
        fetchCSV(CONFIG.URLS.PLAYERS),
        fetchCSV(CONFIG.URLS.TEAMS)
    ]);

    updateStatus(`Loaded ${players.length} Players and ${teams.length} Teams. Fetching GW Data...`);

    // 2) GW-level stats + fixtures
    const allStats = [];
    const allFixtures = [];

    // Batch requests to avoid hitting browser connection limits instantly
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
            // Normalize GW property
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
// 4. CORE LOGIC
// ==========================================

function deriveArchetype(player) {
    if (!player) return null;
    const specific = player.detailed_position || player.role;
    if (specific) {
        if (['CB', 'LB', 'RB'].includes(specific)) return specific;
        if (['CDM', 'CAM', 'RM', 'LM', 'RW', 'LW'].includes(specific)) return 'MID';
        if (['ST', 'CF'].includes(specific)) return 'FWD';
    }
    const pos = player.position;
    if (pos === 'GKP') return 'GKP'; 
    if (pos === 'DEF') return 'CB'; // Default DEF to CB
    if (pos === 'MID') return 'MID';
    if (pos === 'FWD') return 'FWD';
    return null;
}

function checkDefconHit(stats, archetype) {
    // Handle variations in stat names (clearances vs clearances_blocks_interceptions etc)
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
    const { stats, players } = STATE.data;
    const { playersById } = STATE.lookups;

    const opponentAgg = {};
    const leagueAgg = { 'true': {}, 'false': {} };
    const initAgg = () => ({ hits: 0, trials: 0 });
    const archetypes = ['CB', 'LB', 'RB', 'MID', 'FWD'];

    archetypes.forEach(arch => {
        leagueAgg['true'][arch] = initAgg();
        leagueAgg['false'][arch] = initAgg();
    });

    stats.forEach(statRecord => {
        if ((statRecord.minutes || 0) <= 0) return;

        // Try to find player ID in common fields
        const pID = getVal(statRecord, 'player_id', 'element', 'id');
        const player = playersById[pID];
        
        if (!player) return;

        const archetype = deriveArchetype(player);
        if (!archetype || archetype === 'GKP') return;

        const isHit = checkDefconHit(statRecord, archetype);
        
        const wasHome = getVal(statRecord, 'was_home', 'identifier') === true || String(getVal(statRecord, 'was_home')) === 'true';
        const venueKey = String(wasHome); 
        const opponentId = getVal(statRecord, 'opponent_team_id', 'opponent_team');

        if (!opponentId) return;

        // League Baseline
        const leagueBin = leagueAgg[venueKey][archetype];
        leagueBin.trials++;
        if (isHit) leagueBin.hits++;

        // Opponent Specific
        if (!opponentAgg[opponentId]) opponentAgg[opponentId] = { 'true': {}, 'false': {} };
        if (!opponentAgg[opponentId][venueKey]) opponentAgg[opponentId][venueKey] = {};
        if (!opponentAgg[opponentId][venueKey][archetype]) opponentAgg[opponentId][venueKey][archetype] = initAgg();

        const oppBin = opponentAgg[opponentId][venueKey][archetype];
        oppBin.trials++;
        if (isHit) oppBin.hits++;
    });

    // Compute Probabilities
    STATE.lookups.probabilities = {};
    const { K_FACTOR, MIN_PROB, MAX_PROB } = CONFIG.MODEL;

    STATE.data.teams.forEach(team => {
        const teamId = team.id;
        STATE.lookups.probabilities[teamId] = { 'true': {}, 'false': {} };

        ['true', 'false'].forEach(venueKey => {
            archetypes.forEach(arch => {
                const lb = leagueAgg[venueKey][arch];
                const leagueProb = lb.trials > 0 ? (lb.hits / lb.trials) : 0;

                let hits = 0, trials = 0;
                if (opponentAgg[teamId] && opponentAgg[teamId][venueKey] && opponentAgg[teamId][venueKey][arch]) {
                    hits = opponentAgg[teamId][venueKey][arch].hits;
                    trials = opponentAgg[teamId][venueKey][arch].trials;
                }

                const smoothedProb = (hits + (K_FACTOR * leagueProb)) / (trials + K_FACTOR);
                const finalProb = Math.max(MIN_PROB, Math.min(MAX_PROB, smoothedProb));

                STATE.lookups.probabilities[teamId][venueKey][arch] = finalProb;
            });
        });
    });
}

function processData() {
    STATE.lookups.playersById = {};
    STATE.data.players.forEach(p => STATE.lookups.playersById[p.id] = p);

    STATE.lookups.teamsById = {};
    STATE.data.teams.forEach(t => STATE.lookups.teamsById[t.id] = t);

    STATE.lookups.fixturesByTeam = {};
    STATE.data.teams.forEach(t => STATE.lookups.fixturesByTeam[t.id] = {});

    STATE.data.fixtures.forEach(fix => {
        // Handle common fixture column variations
        const hID = getVal(fix, 'home_team_id', 'team_h');
        const aID = getVal(fix, 'away_team_id', 'team_a');
        const isFin = getVal(fix, 'finished') === true || String(getVal(fix, 'finished')) === 'true';
        const gw = getVal(fix, 'gw', 'event');

        if (STATE.lookups.fixturesByTeam[hID]) {
            STATE.lookups.fixturesByTeam[hID][gw] = {
                opponentId: aID,
                wasHome: true,
                finished: isFin
            };
        }
        if (STATE.lookups.fixturesByTeam[aID]) {
            STATE.lookups.fixturesByTeam[aID][gw] = {
                opponentId: hID,
                wasHome: false,
                finished: isFin
            };
        }
    });

    processProbabilities();
    
    // Update Debug Bar
    const debugEl = document.getElementById('status-bar');
    debugEl.textContent = `Data Ready: ${STATE.data.players.length} Players, ${STATE.data.teams.length} Teams, ${STATE.data.stats.length} Stat Records, ${STATE.data.fixtures.length} Fixtures processed.`;
}

// ==========================================
// 5. RENDERING
// ==========================================

function getProbabilityColor(prob) {
    // Heatmap Logic: Green (Low action) -> Yellow -> Red (High action)
    // Actually, usually in FPL: Red = Danger/Hard, Green = Easy.
    // For "Defensive Action Probability", HIGH prob means defenders are BUSY.
    // If you want defenders to get points (BPS/Saves), high action is often Good for GKP/Defenders, 
    // but implies the team is under pressure.
    // Let's use a standard heat scale. 
    // 0.05 (Low) -> White/Blue
    // 0.95 (High) -> Red
    
    const intensity = Math.min(1, Math.max(0, (prob - 0.2) / 0.6)); // Normalize roughly between 0.2 and 0.8
    // Interpolate white to red
    // Red: 255, 0, 0
    // White: 255, 255, 255
    const g = Math.floor(255 * (1 - intensity));
    const b = Math.floor(255 * (1 - intensity));
    return `rgb(255, ${g}, ${b})`; 
}

function renderTable() {
    const { currentArchetype, startGW, sortBy } = STATE.ui;
    const { teams, teamsById } = STATE.data;
    const { fixturesByTeam, probabilities } = STATE.lookups;
    const endGW = parseInt(startGW) + CONFIG.UI.VISIBLE_GW_SPAN - 1;

    const thead = document.getElementById('fixture-header');
    const tbody = document.getElementById('fixture-body');

    thead.innerHTML = '';
    const thTeam = document.createElement('th');
    thTeam.textContent = 'Team';
    thead.appendChild(thTeam);

    for (let gw = parseInt(startGW); gw <= endGW; gw++) {
        const th = document.createElement('th');
        th.textContent = `GW ${gw}`;
        thead.appendChild(th);
    }

    let rowData = teams.map(team => {
        const teamId = team.id;
        const fixtures = [];
        let metrics = [];

        for (let gw = parseInt(startGW); gw <= endGW; gw++) {
            const fix = fixturesByTeam[teamId] ? fixturesByTeam[teamId][gw] : null;
            
            if (!fix) {
                fixtures.push({ type: 'BLANK' });
                metrics.push(0); 
                continue;
            }

            const opponentId = fix.opponentId;
            const isHome = fix.wasHome;
            const venueKey = String(isHome); 

            let prob = CONFIG.MODEL.MIN_PROB;
            if (probabilities[opponentId] && 
                probabilities[opponentId][venueKey] && 
                probabilities[opponentId][venueKey][currentArchetype]) {
                prob = probabilities[opponentId][venueKey][currentArchetype];
            }

            const oppName = teamsById[opponentId] ? teamsById[opponentId].short_name : 'UNK';
            
            fixtures.push({
                type: 'MATCH',
                opponent: oppName,
                venue: isHome ? '(H)' : '(A)',
                prob: prob
            });
            metrics.push(prob);
        }

        const validMetrics = metrics.filter(m => m > 0);
        const maxVal = validMetrics.length ? Math.max(...validMetrics) : 0;
        const avgVal = validMetrics.length ? (validMetrics.reduce((a,b)=>a+b,0) / validMetrics.length) : 0;

        return {
            teamName: team.name,
            fixtures: fixtures,
            sortVal: sortBy === 'max' ? maxVal : avgVal
        };
    });

    rowData.sort((a, b) => b.sortVal - a.sortVal);

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
                td.classList.add('match-cell');
                const divOpp = document.createElement('div');
                divOpp.className = 'match-opp';
                divOpp.textContent = `${cell.opponent} ${cell.venue}`;
                
                const divProb = document.createElement('div');
                divProb.className = 'match-prob';
                divProb.textContent = `${(cell.prob * 100).toFixed(0)}%`;
                
                td.appendChild(divOpp);
                td.appendChild(divProb);
                
                td.style.backgroundColor = getProbabilityColor(cell.prob);
                if (cell.prob > 0.6) td.style.color = 'white';
                else td.style.color = '#222';
            }
            tr.appendChild(td);
        });

        tbody.appendChild(tr);
    });
}

// ==========================================
// 6. INITIALIZATION
// ==========================================

function setupEventListeners() {
    document.getElementById('archetype-filter').addEventListener('change', (e) => {
        STATE.ui.currentArchetype = e.target.value;
        renderTable();
    });

    const slider = document.getElementById('gw-slider');
    const gwLabel = document.getElementById('gw-label');
    STATE.ui.startGW = slider.value;

    slider.addEventListener('input', (e) => {
        const val = e.target.value;
        STATE.ui.startGW = val;
        gwLabel.textContent = `Start GW: ${val}`;
        renderTable();
    });

    document.getElementById('sort-by').addEventListener('change', (e) => {
        STATE.ui.sortBy = e.target.value;
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

