/**
 * FPL DEFCON PREDICTOR - app.js
 * * A vanilla JavaScript SPA to calculate and visualize defensive action probabilities
 * based on opponent strength and position archetypes.
 * * Core Features:
 * - Bayesian shrinkage for probability smoothing.
 * - Dynamic fixture matrix rendering.
 * - Client-side CSV parsing and data aggregation.
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
        // season-level master files
        PLAYERS: 'https://raw.githubusercontent.com/olbauday/FPL-Elo-Insights/main/data/2025-2026/players.csv',
        TEAMS:   'https://raw.githubusercontent.com/olbauday/FPL-Elo-Insights/main/data/2025-2026/teams.csv'
        // STATS/FIXTURES now come from per-GW folders, so no single URL here
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
        teamsById: {}, // map id -> team obj
        playersById: {}, // map id -> player obj
        fixturesByTeam: {}, // map teamId -> { gw -> { opponentId, wasHome, finished } }
        probabilities: {} // [opponentId][isPlayerHome][archetype] -> { p, n }
    },
    ui: {
        currentArchetype: 'CB', // Default
        startGW: 1,             // Default from slider
        sortBy: 'max'           // 'max' or 'avg'
    }
};

// ==========================================
// 2. UTILITIES & PARSING
// ==========================================

/**
 * Basic CSV Parser.
 * Assumes standard CSV format with header row.
 */
const CSVParser = {
    parse: (text) => {
        if (!text) return [];
        const lines = text.trim().split('\n');
        if (lines.length < 2) return [];

        const headers = lines[0].split(',').map(h => h.trim());
        const result = [];

        for (let i = 1; i < lines.length; i++) {
            const currentLine = lines[i].split(',');
            if (currentLine.length !== headers.length) continue;

            const obj = {};
            headers.forEach((header, index) => {
                let val = currentLine[index].trim();
                // Attempt numeric conversion
                if (!isNaN(val) && val !== '') {
                    val = Number(val);
                } else if (val.toLowerCase() === 'true') {
                    val = true;
                } else if (val.toLowerCase() === 'false') {
                    val = false;
                }
                obj[header] = val;
            });
            result.push(obj);
        }
        return result;
    }
};

/**
 * Fetch helper to grab all data sources in parallel.
 */
/**
 * Fetch helper to grab all data sources.
 * - players / teams from season root
 * - stats / fixtures from per-GW Premier League folders
 */
async function loadData() {
    const fetchCSV = async (url) => {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Failed to load ${url} (${res.status})`);
        const text = await res.text();
        return CSVParser.parse(text);
    };

    // Tolerant version for per-GW files (some future GWs won’t exist yet)
    const fetchCSVOptional = async (url) => {
        try {
            const res = await fetch(url);
            if (!res.ok) {
                console.warn(`Skipping ${url}: HTTP ${res.status}`);
                return [];
            }
            const text = await res.text();
            return CSVParser.parse(text);
        } catch (e) {
            console.warn(`Error fetching ${url}: ${e.message}`);
            return [];
        }
    };

    // 1) Season-level players / teams
    const [players, teams] = await Promise.all([
        fetchCSV(CONFIG.URLS.PLAYERS),
        fetchCSV(CONFIG.URLS.TEAMS)
    ]);

    // 2) GW-level stats + fixtures for Premier League
    const allStats = [];
    const allFixtures = [];

    for (let gw = 1; gw <= CONFIG.UI.MAX_GW; gw++) {
        const gwPath = `${CONFIG.PATHS.PL_TOURNAMENT_BASE}/GW${gw}`;
        const statsUrl = `${gwPath}/player_gameweek_stats.csv`;
        const fixturesUrl = `${gwPath}/fixtures.csv`;

        const [gwStats, gwFixtures] = await Promise.all([
            fetchCSVOptional(statsUrl),
            fetchCSVOptional(fixturesUrl)
        ]);

        // Tag GW if not already present
        gwStats.forEach(row => {
            if (row.gw == null && row.gameweek != null) {
                row.gw = row.gameweek;
            } else if (row.gw == null) {
                row.gw = gw;
            }
        });

        gwFixtures.forEach(row => {
            if (row.gw == null && row.gameweek != null) {
                row.gw = row.gameweek;
            } else if (row.gw == null) {
                row.gw = gw;
            }
        });

        allStats.push(...gwStats);
        allFixtures.push(...gwFixtures);
    }

    return {
        players,
        teams,
        stats: allStats,
        fixtures: allFixtures
    };
}

// ==========================================
// 3. CORE LOGIC: ARCHETYPES & PROBABILITIES
// ==========================================

/**
 * Maps player position data to our app archetypes:
 * CB, LB, RB, MID, FWD.
 * * Logic:
 * 1. Use granular `specific_role` if available (e.g., from source).
 * 2. Fallback to broad `position` (GKP, DEF, MID, FWD).
 */
function deriveArchetype(player) {
    if (!player) return null;

    // 1. Try granular role if it exists in data
    const specific = player.detailed_position || player.role; // Adjust based on actual CSV headers
    if (specific) {
        if (['CB', 'LB', 'RB'].includes(specific)) return specific;
        if (['CDM', 'CAM', 'RM', 'LM', 'RW', 'LW'].includes(specific)) return 'MID';
        if (['ST', 'CF'].includes(specific)) return 'FWD';
    }

    // 2. Fallback based on FPL standard positions
    // 1=GKP, 2=DEF, 3=MID, 4=FWD usually, but we use string codes here
    const pos = player.position; 
    
    if (pos === 'GKP') return 'GKP'; // Excluded from table but useful for baselines if needed
    
    if (pos === 'DEF') {
        // Simple mapping function constraint:
        // Without detailed data, we can't perfectly distinguish CB vs FB.
        // We will return 'CB' as a generic default for DEF if specific is missing,
        // OR rely on a naming convention.
        // For this exercise, we map generic DEF to CB to be safe, 
        // or we could split specific IDs if we had a hardcoded list.
        return 'CB'; 
    }
    
    if (pos === 'MID') return 'MID';
    if (pos === 'FWD') return 'FWD';

    return null;
}

/**
 * Calculates whether a player hit the DEFCON threshold in a specific match.
 */
function checkDefconHit(stats, archetype) {
    const { clearances, interceptions, tackles, recoveries } = stats;
    
    // Safely handle missing keys by defaulting to 0
    const clr = clearances || 0;
    const int = interceptions || 0;
    const tck = tackles || 0;
    const rec = recoveries || 0;

    if (['CB', 'LB', 'RB'].includes(archetype)) {
        // Defender Rule: CLR + INT + TCK >= 10
        return (clr + int + tck) >= CONFIG.THRESHOLDS.DEF;
    } else if (['MID', 'FWD'].includes(archetype)) {
        // Mid/Fwd Rule: CLR + INT + TCK + REC >= 12
        return (clr + int + tck + rec) >= CONFIG.THRESHOLDS.MID_FWD;
    }
    
    return false;
}

/**
 * The Heavy Lifter: Aggregates stats and computes probabilities
 * using Bayesian shrinkage.
 */
function processProbabilities() {
    const { stats, players, teams } = STATE.data;
    const { playersById } = STATE.lookups;

    // Data Structures for Aggregation
    // Structure: agg[opponentId][isPlayerHomeString][archetype] = { hits, trials }
    // isPlayerHomeString: "true" (Home) or "false" (Away)
    const opponentAgg = {};
    
    // League Baselines: baseline[isPlayerHomeString][archetype] = { hits, trials }
    const leagueAgg = {
        'true': {}, 
        'false': {}
    };

    // Initialize Helpers
    const initAgg = () => ({ hits: 0, trials: 0 });
    const archetypes = ['CB', 'LB', 'RB', 'MID', 'FWD'];
    
    archetypes.forEach(arch => {
        leagueAgg['true'][arch] = initAgg();
        leagueAgg['false'][arch] = initAgg();
    });

    // 1. Iterate over every historical appearance
    stats.forEach(statRecord => {
        if (statRecord.minutes <= 0) return; // Ignore bench warmers

        const player = playersById[statRecord.player_id];
        if (!player) return;

        const archetype = deriveArchetype(player);
        if (!archetype || archetype === 'GKP') return;

        const isHit = checkDefconHit(statRecord, archetype);
        
        // Normalize boolean to string key for consistent object access
        const venueKey = String(statRecord.was_home); // "true" if player was home
        const opponentId = statRecord.opponent_team_id;

        // A. Update League Baseline
        const leagueBin = leagueAgg[venueKey][archetype];
        leagueBin.trials++;
        if (isHit) leagueBin.hits++;

        // B. Update Opponent Specific Aggregates
        if (!opponentAgg[opponentId]) opponentAgg[opponentId] = { 'true': {}, 'false': {} };
        if (!opponentAgg[opponentId][venueKey][archetype]) opponentAgg[opponentId][venueKey][archetype] = initAgg();

        const oppBin = opponentAgg[opponentId][venueKey][archetype];
        oppBin.trials++;
        if (isHit) oppBin.hits++;
    });

    // 2. Compute Probabilities with Shrinkage
    STATE.lookups.probabilities = {};
    const { K_FACTOR, MIN_PROB, MAX_PROB } = CONFIG.MODEL;

    teams.forEach(team => {
        const teamId = team.id;
        STATE.lookups.probabilities[teamId] = { 'true': {}, 'false': {} };

        ['true', 'false'].forEach(venueKey => {
            archetypes.forEach(arch => {
                // Get League Average for this Archetype + Venue
                const lb = leagueAgg[venueKey][arch];
                const leagueProb = lb.trials > 0 ? (lb.hits / lb.trials) : 0;

                // Get Opponent Specific Data
                let hits = 0;
                let trials = 0;

                if (opponentAgg[teamId] && opponentAgg[teamId][venueKey][arch]) {
                    hits = opponentAgg[teamId][venueKey][arch].hits;
                    trials = opponentAgg[teamId][venueKey][arch].trials;
                }

                // Bayesian Shrinkage Formula
                // P = (hits + K * leagueProb) / (trials + K)
                const smoothedProb = (hits + (K_FACTOR * leagueProb)) / (trials + K_FACTOR);

                // Clamp
                let finalProb = Math.max(MIN_PROB, Math.min(MAX_PROB, smoothedProb));

                STATE.lookups.probabilities[teamId][venueKey][arch] = finalProb;
            });
        });
    });

    console.log("Probabilities Processed", STATE.lookups.probabilities);
}

// ==========================================
// 4. DATA PROCESSING & INDEXING
// ==========================================

function processData() {
    // Index Players
    STATE.data.players.forEach(p => {
        STATE.lookups.playersById[p.id] = p;
    });

    // Index Teams
    STATE.data.teams.forEach(t => {
        STATE.lookups.teamsById[t.id] = t;
    });

    // Index Fixtures: Group by Team
    STATE.lookups.fixturesByTeam = {};
    
    // Initialize array for all teams
    STATE.data.teams.forEach(t => {
        STATE.lookups.fixturesByTeam[t.id] = {};
    });

    STATE.data.fixtures.forEach(fix => {
        // Processing Home Team's fixture
        if (STATE.lookups.fixturesByTeam[fix.home_team_id]) {
            STATE.lookups.fixturesByTeam[fix.home_team_id][fix.gw] = {
                opponentId: fix.away_team_id,
                wasHome: true,
                finished: fix.finished === true || fix.finished === 'true'
            };
        }

        // Processing Away Team's fixture
        if (STATE.lookups.fixturesByTeam[fix.away_team_id]) {
            STATE.lookups.fixturesByTeam[fix.away_team_id][fix.gw] = {
                opponentId: fix.home_team_id,
                wasHome: false, // Away team is NOT home
                finished: fix.finished === true || fix.finished === 'true'
            };
        }
    });

    // Run Probability Engine
    processProbabilities();
}

// ==========================================
// 5. RENDERING & UI
// ==========================================

/**
 * Returns a CSS color string based on probability.
 * Low Prob (0.05) -> Transparent/Neutral
 * High Prob (0.95) -> High Intensity Red/Orange
 */
function getProbabilityColor(prob) {
    // 0 to 1 scale. 
    // Let's go from Light Yellow to Dark Red for "Hot" zones.
    // HSL: Start around 60 (Yellow) go down to 0 (Red). 
    // Lightness: 90% down to 50%.
    
    // Using a simpler alpha approach for clean UI
    // Base color red: 255, 50, 50
    const alpha = (prob - 0.1) / 0.8; // Normalize roughly for visibility
    const safeAlpha = Math.max(0, Math.min(1, alpha));
    
    return `rgba(255, 99, 71, ${safeAlpha})`; // Tomato red with variable opacity
}

function renderTable() {
    const { currentArchetype, startGW, sortBy } = STATE.ui;
    const { teams, teamsById } = STATE.data; // teams is array
    const { fixturesByTeam, probabilities } = STATE.lookups;
    const endGW = parseInt(startGW) + CONFIG.UI.VISIBLE_GW_SPAN - 1;

    const thead = document.getElementById('fixture-header');
    const tbody = document.getElementById('fixture-body');

    // 1. Build Header
    thead.innerHTML = '';
    const thTeam = document.createElement('th');
    thTeam.textContent = 'Team';
    thTeam.style.textAlign = 'left';
    thead.appendChild(thTeam);

    for (let gw = parseInt(startGW); gw <= endGW; gw++) {
        const th = document.createElement('th');
        th.textContent = `GW ${gw}`;
        th.style.width = '80px';
        thead.appendChild(th);
    }

    // 2. Prepare Rows Data
    let rowData = teams.map(team => {
        const teamId = team.id;
        const fixtures = [];
        let metrics = []; // To calculate sort values

        for (let gw = parseInt(startGW); gw <= endGW; gw++) {
            const fix = fixturesByTeam[teamId] ? fixturesByTeam[teamId][gw] : null;
            
            if (!fix) {
                // Blank Gameweek
                fixtures.push({ type: 'BLANK' });
                metrics.push(0); 
                continue;
            }

            const opponentId = fix.opponentId;
            const isHome = fix.wasHome; // Boolean
            const venueKey = String(isHome); // "true" or "false"

            // LOOKUP LOGIC:
            // We want the probability that THIS team's player (Archetype) hits DEFCON.
            // This happens against the OPPONENT.
            // Condition: Opponent ID, and the VENUE of the player.
            // e.g. Arsenal (Home) vs Liverpool.
            // We look at stats conceded by Liverpool when Liverpool is Away (== Player Home).
            
            let prob = 0;
            if (probabilities[opponentId] && 
                probabilities[opponentId][venueKey] && 
                probabilities[opponentId][venueKey][currentArchetype]) {
                
                prob = probabilities[opponentId][venueKey][currentArchetype];
            } else {
                // Fallback (shouldn't happen often due to league baseline)
                prob = CONFIG.MODEL.MIN_PROB;
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

        // Compute Sort Metric
        const validMetrics = metrics.filter(m => m > 0);
        const maxVal = validMetrics.length ? Math.max(...validMetrics) : 0;
        const avgVal = validMetrics.length ? (validMetrics.reduce((a,b)=>a+b,0) / validMetrics.length) : 0;

        return {
            teamName: team.name,
            fixtures: fixtures,
            sortVal: sortBy === 'max' ? maxVal : avgVal
        };
    });

    // 3. Sort Rows
    rowData.sort((a, b) => b.sortVal - a.sortVal);

    // 4. Render Body
    tbody.innerHTML = '';
    rowData.forEach(row => {
        const tr = document.createElement('tr');
        
        // Name Cell
        const tdName = document.createElement('td');
        tdName.textContent = row.teamName;
        tdName.style.fontWeight = 'bold';
        tr.appendChild(tdName);

        // Fixture Cells
        row.fixtures.forEach(cell => {
            const td = document.createElement('td');
            
            if (cell.type === 'BLANK') {
                td.textContent = '-';
                td.style.backgroundColor = '#eee';
            } else {
                // Inner Content
                const divOpp = document.createElement('div');
                divOpp.textContent = `${cell.opponent} ${cell.venue}`;
                divOpp.style.fontSize = '0.85em';
                
                const divProb = document.createElement('div');
                divProb.textContent = `${(cell.prob * 100).toFixed(0)}%`;
                divProb.style.fontWeight = 'bold';
                
                td.appendChild(divOpp);
                td.appendChild(divProb);
                
                // Styling
                td.style.backgroundColor = getProbabilityColor(cell.prob);
                td.style.textAlign = 'center';
                td.style.border = '1px solid #ddd';
                
                // Optional: dark text on light bg, white text on dark bg
                if (cell.prob > 0.7) td.style.color = 'white';
                else td.style.color = 'black';
            }
            tr.appendChild(td);
        });

        tbody.appendChild(tr);
    });
}

// ==========================================
// 6. INITIALIZATION & EVENTS
// ==========================================

function setupEventListeners() {
    // Archetype Filter
    const archSelect = document.getElementById('archetype-filter');
    archSelect.addEventListener('change', (e) => {
        STATE.ui.currentArchetype = e.target.value;
        renderTable();
    });

    // GW Slider
    const slider = document.getElementById('gw-slider');
    const gwLabel = document.getElementById('gw-label'); // Optional label
    
    // Initialize slider value
    if (gwLabel) gwLabel.textContent = `GW ${slider.value}`;
    STATE.ui.startGW = slider.value;

    slider.addEventListener('input', (e) => {
        const val = e.target.value;
        STATE.ui.startGW = val;
        if (gwLabel) gwLabel.textContent = `GW ${val}`;
        renderTable();
    });

    // Sort By
    const sortSelect = document.getElementById('sort-by');
    sortSelect.addEventListener('change', (e) => {
        STATE.ui.sortBy = e.target.value;
        renderTable();
    });
}

async function init() {
    const loadingEl = document.getElementById('loading');
    const mainEl = document.getElementById('main-content');
    const errorEl = document.getElementById('error');

    try {
        // 1. Load Data
        const rawData = await loadData();
        STATE.data = rawData;

        // 2. Process Data
        processData();

        // 3. Update UI
        loadingEl.style.display = 'none';
        mainEl.style.display = 'block';

        // 4. Initial Render
        setupEventListeners();
        renderTable();

    } catch (err) {
        console.error("Initialization Error:", err);
        loadingEl.style.display = 'none';
        errorEl.style.display = 'block';
        errorEl.textContent = `Error loading data: ${err.message}. Ensure data files exist in /data/ folder.`;
    }
}

// Start the app when DOM is ready
document.addEventListener('DOMContentLoaded', init);// app.js

// Initialise the matrix preview when the DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  if (typeof window.initMatrixPreview === 'function') {
    window.initMatrixPreview();
  } else {
    console.warn('[app] initMatrixPreview not found. Is matrixPreview.js loaded?');
  }
});