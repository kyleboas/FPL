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
        teamsByCode: {},   // key: team.code
        playersById: {},
        fixturesByTeam: {}, // key: team.code -> { gw -> { opponentCode, wasHome, finished } }
        probabilities: {}   // key: opponentCode -> { 'true'/'false' -> { archetype -> prob } }
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
    if (pos === 'DEF') return 'CB';
    if (pos === 'MID') return 'MID';
    if (pos === 'FWD') return 'FWD';
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

// probabilities keyed by opponentCode
function processProbabilities() {
    const { stats, teams } = STATE.data;
    const { playersById, fixturesByTeam, teamsById, teamsByCode } = STATE.lookups;

    const opponentAgg = {};
    const leagueAgg = { 'true': {}, 'false': {} };
    const initAgg = () => ({ hits: 0, trials: 0 });
    const archetypes = ['CB', 'LB', 'RB', 'MID', 'FWD'];

    archetypes.forEach(arch => {
        leagueAgg['true'][arch] = initAgg();
        leagueAgg['false'][arch] = initAgg();
    });

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

        // map player.team (id or code) → teamCode
        const teamRef = getVal(player, 'team', 'team_id', 'teamid', 'team_code');
        let teamCode = null;

        if (teamsByCode[teamRef]) {
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

        const isHit = checkDefconHit(statRecord, archetype);

        const leagueBin = leagueAgg[venueKey][archetype];
        leagueBin.trials++;
        if (isHit) leagueBin.hits++;

        if (!opponentCode) return;

        if (!opponentAgg[opponentCode]) {
            opponentAgg[opponentCode] = { 'true': {}, 'false': {} };
        }
        if (!opponentAgg[opponentCode][venueKey][archetype]) {
            opponentAgg[opponentCode][venueKey][archetype] = initAgg();
        }

        const oppBin = opponentAgg[opponentCode][venueKey][archetype];
        oppBin.trials++;
        if (isHit) oppBin.hits++;
    });

    STATE.lookups.probabilities = {};
    const { K_FACTOR, MIN_PROB, MAX_PROB } = CONFIG.MODEL;

    teams.forEach(team => {
        const teamCode = team.code;
        STATE.lookups.probabilities[teamCode] = { 'true': {}, 'false': {} };

        ['true', 'false'].forEach(venueKey => {
            archetypes.forEach(arch => {
                const lb = leagueAgg[venueKey][arch];
                const leagueProb = lb.trials > 0 ? (lb.hits / lb.trials) : 0;

                let hits = 0, trials = 0;
                if (opponentAgg[teamCode] &&
                    opponentAgg[teamCode][venueKey] &&
                    opponentAgg[teamCode][venueKey][arch]) {
                    hits = opponentAgg[teamCode][venueKey][arch].hits;
                    trials = opponentAgg[teamCode][venueKey][arch].trials;
                }

                const smoothedProb = (hits + (K_FACTOR * leagueProb)) / (trials + K_FACTOR);
                const finalProb = Math.max(MIN_PROB, Math.min(MAX_PROB, smoothedProb));

                STATE.lookups.probabilities[teamCode][venueKey][arch] = finalProb;
            });
        });
    });
}

function processData() {
    STATE.lookups.playersById = {};
    STATE.data.players.forEach(p => STATE.lookups.playersById[p.id] = p);

    STATE.lookups.teamsById = {};
    STATE.data.teams.forEach(t => STATE.lookups.teamsById[t.id] = t);

    STATE.lookups.teamsByCode = {};
    STATE.data.teams.forEach(t => STATE.lookups.teamsByCode[t.code] = t);

    STATE.lookups.fixturesByTeam = {};
    STATE.data.teams.forEach(t => STATE.lookups.fixturesByTeam[t.code] = {});

    // fixtures.csv uses team codes; keep everything in codes
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
// 5. RENDERING
// ==========================================

function getProbabilityColor(prob) {
    const intensity = Math.min(1, Math.max(0, (prob - 0.2) / 0.6));
    const g = Math.floor(255 * (1 - intensity));
    const b = Math.floor(255 * (1 - intensity));
    return `rgb(255, ${g}, ${b})`; 
}

function sanityCheck() {
    console.log('=== DEFCON Sanity Check ===');

    console.log('Players:', STATE.data.players.length);
    console.log('Teams:', STATE.data.teams.length);
    console.log('Raw fixtures rows:', STATE.data.fixtures.length);

    let mappedSlots = 0;
    for (const [, gwMap] of Object.entries(STATE.lookups.fixturesByTeam)) {
        mappedSlots += Object.keys(gwMap).length;
    }
    console.log('Mapped fixture slots in fixturesByTeam:', mappedSlots);
    console.log('Expected ~2x raw fixtures:', STATE.data.fixtures.length * 2);

    const arsenal = STATE.data.teams.find(t => t.short_name === 'ARS');
    if (!arsenal) {
        console.warn('No team with short_name "ARS" found');
        return;
    }

    console.log('Arsenal team object:', arsenal);
    const arsenalMap = STATE.lookups.fixturesByTeam[arsenal.code];
    console.log('Arsenal fixturesByTeam entry:', arsenalMap);

    [1, 2, 7].forEach(gw => {
        const f = arsenalMap ? arsenalMap[gw] : null;
        console.log(`GW${gw} fixture for ARS:`, f);

        if (f) {
            const opp = STATE.lookups.teamsByCode[f.opponentCode];
            const venueKey = String(f.wasHome);
            const probCB  = STATE.lookups.probabilities[f.opponentCode]?.[venueKey]?.CB;
            const probLB  = STATE.lookups.probabilities[f.opponentCode]?.[venueKey]?.LB;
            const probRB  = STATE.lookups.probabilities[f.opponentCode]?.[venueKey]?.RB;
            const probMID = STATE.lookups.probabilities[f.opponentCode]?.[venueKey]?.MID;

            console.log(
                `  Opponent: ${opp?.short_name} (${venueKey === 'true' ? 'H' : 'A'})`,
                '\n  CB:', probCB,
                'LB:', probLB,
                'RB:', probRB,
                'MID:', probMID
            );
        }
    });
}

function renderTable() {
    const { currentArchetype, startGW, sortBy } = STATE.ui;
    const { teams } = STATE.data;
    const { fixturesByTeam, probabilities, teamsByCode } = STATE.lookups;
    const endGW = parseInt(startGW) + CONFIG.UI.VISIBLE_GW_SPAN - 1;

    const thead = document.getElementById('fixture-header');
    const tbody = document.getElementById('fixture-body');

    thead.innerHTML = '';
    const headerRow = document.createElement('tr');

    const thTeam = document.createElement('th');
    thTeam.textContent = 'Team';
    headerRow.appendChild(thTeam);

    for (let gw = parseInt(startGW); gw <= endGW; gw++) {
        const th = document.createElement('th');
        th.textContent = `GW ${gw}`;
        headerRow.appendChild(th);
    }

    thead.appendChild(headerRow);

    let rowData = teams.map(team => {
        const teamCode = team.code;
        const fixtures = [];
        let metrics = [];

        for (let gw = parseInt(startGW); gw <= endGW; gw++) {
            const fix = fixturesByTeam[teamCode] ? fixturesByTeam[teamCode][gw] : null;
            
            if (!fix) {
                fixtures.push({ type: 'BLANK' });
                metrics.push(0); 
                continue;
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

                td.style.backgroundColor = getProbabilityColor(cell.prob);
                td.style.color = cell.prob > 0.6 ? 'white' : '#222';
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

        window.STATE = STATE;
        window.sanityCheck = sanityCheck;
        sanityCheck();

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