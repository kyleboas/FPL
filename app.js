// FPL DEFCON Predictor - Fixture Matrix Version
// Data source: https://github.com/olbauday/FPL-Elo-Insights/main/data/2025-2026
//
// New behaviour:
// - No player list.
// - Builds a fixture matrix: rows = teams, columns = upcoming gameweeks.
// - Each cell shows opponent + H/A + DEFCON hit probability for a selected archetype.
//
// Required HTML IDs:
// - #loading, #error, #main-content (as before)
// - #fixture-header  (inside <thead> of the fixture table)
// - #fixture-body    (inside <tbody> of the fixture table)
// - #archetype-filter <select> with values like: CB, RB, LB, MID, DEF_GKP, MID_FWD

const DATA_BASE_URL = 'https://raw.githubusercontent.com/olbauday/FPL-Elo-Insights/main/data/2025-2026';
const DATA_GW_URL = 'https://raw.githubusercontent.com/olbauday/FPL-Elo-Insights/main/data/2025-2026/By%20Tournament/Premier%20League';
const DEFCON_THRESHOLD_DEF = 10;  // CBIT threshold for defenders/keepers
const DEFCON_THRESHOLD_MID_FWD = 12;  // CBIRT threshold for mids/forwards
const MAX_GAMEWEEKS = 38;  // Maximum gameweeks in a season

// Default league-wide DEFCON probability when no data exists yet
const DEFAULT_DEFCON_PROB = 0.28;

// Strength of league-wide prior (in "virtual games") for smoothing per-opponent rates.
const DEFCON_PRIOR_STRENGTH = 6;

// Global state
let state = {
    players: [],
    playerMatchStats: [],
    matches: [],
    teams: [],
    teamLookup: {},            // id -> { id, name, shortName }
    teamPositionProbs: null,   // from buildOpponentPositionProbabilities()
    leaguePositionProbs: null, // from buildOpponentPositionProbabilities()
    fixtureMatrix: null,       // { gameweeks: number[], rows: [ { teamId, name, shortName, fixtures: { [gw]: cell } } ] }
    filters: {
        archetype: 'CB'        // CB, RB, LB, MID, DEF_GKP, MID_FWD
    }
};

// DOM Elements
const elements = {
    loading: document.getElementById('loading'),
    error: document.getElementById('error'),
    mainContent: document.getElementById('main-content'),
    fixtureHeader: document.getElementById('fixture-header'),
    fixtureBody: document.getElementById('fixture-body'),
    archetypeFilter: document.getElementById('archetype-filter')
};

// --------------------- Utility helpers ---------------------

// Normalize any team / player ID so "7", "7.0" and 7 all become "7"
function normId(value) {
    if (value === null || value === undefined) return null;
    const trimmed = String(value).trim();
    if (!trimmed) return null;
    const num = Number(trimmed);
    if (!Number.isNaN(num)) return String(num);
    return trimmed;
}

// CSV Parser
function parseCSV(text) {
    const lines = text.trim().split('\n');
    if (lines.length === 0) return [];

    const headers = parseCSVLine(lines[0]);
    const data = [];

    for (let i = 1; i < lines.length; i++) {
        if (lines[i].trim()) {
            const values = parseCSVLine(lines[i]);
            const row = {};
            headers.forEach((header, idx) => {
                row[header.trim()] = values[idx]?.trim() || '';
            });
            data.push(row);
        }
    }
    return data;
}

function parseCSVLine(line) {
    const result = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
        const char = line[i];
        if (char === '"') {
            inQuotes = !inQuotes;
        } else if (char === ',' && !inQuotes) {
            result.push(current);
            current = '';
        } else {
            current += char;
        }
    }
    result.push(current);
    return result;
}

// Fetch data from GitHub
async function fetchCSV(url) {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Failed to fetch ${url}: ${response.status}`);
    }
    const text = await response.text();
    return parseCSV(text);
}

// Fetch CSV from root data directory
async function fetchRootCSV(filename) {
    return fetchCSV(`${DATA_BASE_URL}/${filename}`);
}

// Fetch CSV from a specific gameweek directory
async function fetchGameweekCSV(gameweek, filename) {
    return fetchCSV(`${DATA_GW_URL}/GW${gameweek}/${filename}`);
}

// Fetch data from all available gameweeks and aggregate
async function fetchAllGameweekData(filename) {
    const allData = [];
    const fetchPromises = [];

    for (let gw = 1; gw <= MAX_GAMEWEEKS; gw++) {
        fetchPromises.push(
            fetchGameweekCSV(gw, filename)
                .then(data => ({ gw, data, success: true }))
                .catch(() => ({ gw, data: [], success: false }))
        );
    }

    const results = await Promise.all(fetchPromises);

    results.forEach(result => {
        if (result.success && result.data.length > 0) {
            allData.push(...result.data);
        }
    });

    return allData;
}

async function loadAllData() {
    try {
        const [players, teams] = await Promise.all([
            fetchRootCSV('players.csv'),
            fetchRootCSV('teams.csv')
        ]);

        state.players = players;
        state.teams = teams;

        console.log('Loaded root data:', { players: players.length, teams: teams.length });

        const [playerMatchStats, matches] = await Promise.all([
            fetchAllGameweekData('player_gameweek_stats.csv'),
            fetchAllGameweekData('matches.csv')
        ]);

        state.playerMatchStats = playerMatchStats;
        state.matches = matches;

        console.log('Loaded gameweek data:', {
            playerMatchStats: playerMatchStats.length,
            matches: matches.length
        });

        if (players.length === 0 || teams.length === 0) {
            throw new Error('Failed to load essential player/team data');
        }

        if (playerMatchStats.length === 0 || matches.length === 0) {
            console.warn('No gameweek data available yet - season may not have started');
        }

        buildTeamLookup();

        return true;
    } catch (error) {
        console.error('Error loading data:', error);
        return false;
    }
}

// Build canonical team lookup
function buildTeamLookup() {
    const lookup = {};
    state.teams.forEach(t => {
        const id = normId(t.id || t.team_id || t.code);
        if (!id) return;
        lookup[id] = {
            id,
            name: t.name || t.team_name || 'Unknown',
            shortName: t.short_name || (t.name ? t.name.substring(0, 3).toUpperCase() : id)
        };
    });
    state.teamLookup = lookup;
}

// Map a player row to its team row using FPL-Elo-Insights conventions
function getTeamFromPlayer(player) {
    const playerTeamKey = normId(player.team_id || player.team_code || player.team);
    if (!playerTeamKey) return null;

    const team = state.teams.find(t =>
        normId(t.code) === playerTeamKey ||
        normId(t.team_code) === playerTeamKey ||
        normId(t.id) === playerTeamKey ||
        normId(t.team_id) === playerTeamKey
    );

    return team || null;
}

// Robust player lookup from a player_gameweek_stats row.
// FPL-Elo-Insights usually uses `element` for the FPL player id.
function getPlayerFromStat(stat) {
    // Prefer FPL-style fields first, then fall back to id
    const candidateIds = [
        stat.element,
        stat.player_id,
        stat.player,
        stat.id
    ]
        .map(normId)
        .filter(Boolean);

    if (candidateIds.length === 0) return null;

    for (const cand of candidateIds) {
        const player = state.players.find(p =>
            normId(p.element) === cand ||
            normId(p.player_id) === cand ||
            normId(p.id) === cand
        );
        if (player) return player;
    }

    return null;
}

// Map a team id coming from matches.csv to canonical id (teams.id)
function mapMatchTeamId(rawTeamId) {
    const codeKey = normId(rawTeamId);
    if (!codeKey) return null;

    const team = state.teams.find(t =>
        normId(t.code || t.team_code) === codeKey ||
        normId(t.id || t.team_id) === codeKey
    );

    return team ? normId(team.id || team.team_id || team.code) : codeKey;
}

// --------------------- Metrics & Probabilities ---------------------

// Calculate CBIT for a defender/keeper match
function calculateCBIT(matchStat) {
    const interceptions = parseFloat(matchStat.interceptions || matchStat.clearances_blocks_interceptions || 0);
    const clearances = parseFloat(matchStat.clearances || 0);
    const blocks = parseFloat(matchStat.blocks || 0);
    const tackles = parseFloat(matchStat.tackles || matchStat.tackles_won || 0);
    return interceptions + clearances + blocks + tackles;
}

// Calculate CBIRT for mids/forwards
function calculateCBIRT(matchStat, position) {
    const interceptions = parseFloat(matchStat.interceptions || matchStat.clearances_blocks_interceptions || 0);
    const recoveries = parseFloat(matchStat.recoveries || matchStat.ball_recoveries || 0);
    const tackles = parseFloat(matchStat.tackles || matchStat.tackles_won || 0);
    return interceptions + recoveries + tackles;
}

// Get player position (GKP/DEF/MID/FWD)
function getPosition(player) {
    const elementType = parseInt(player.element_type || player.position || player.pos || 0);
    const posMap = { 1: 'GKP', 2: 'DEF', 3: 'MID', 4: 'FWD' };
    if (posMap[elementType]) {
        return posMap[elementType];
    }

    const posStr = (player.singular_name_short || player.position || player.pos || '').toUpperCase();
    const strMap = {
        'GK': 'GKP', 'GKP': 'GKP', 'GOALKEEPER': 'GKP',
        'DEF': 'DEF', 'D': 'DEF', 'DEFENDER': 'DEF',
        'MID': 'MID', 'M': 'MID', 'MIDFIELDER': 'MID',
        'FWD': 'FWD', 'F': 'FWD', 'FW': 'FWD', 'FORWARD': 'FWD', 'ATT': 'FWD'
    };
    return strMap[posStr] || 'UNK';
}

// Position group for opponent-history aggregation
function getPositionGroup(position) {
    if (position === 'DEF' || position === 'GKP') {
        return 'DEF_GKP';
    }
    if (position === 'MID' || position === 'FWD') {
        return 'MID_FWD';
    }
    return null;
}

// Archetype -> position group mapping for UI
function getPositionGroupFromArchetype(archetype) {
    const key = (archetype || '').toUpperCase();
    if (key === 'CB' || key === 'RB' || key === 'LB' || key === 'DEF' || key === 'GKP' || key === 'DEF_GKP') {
        return 'DEF_GKP';
    }
    if (key === 'MID' || key === 'FWD' || key === 'MID_FWD') {
        return 'MID_FWD';
    }
    // default to DEF_GKP if unknown
    return 'DEF_GKP';
}

// Score per match based on position
function calculateScore(matchStat, position) {
    if (position === 'DEF' || position === 'GKP') {
        return calculateCBIT(matchStat);
    }
    return calculateCBIRT(matchStat, position);
}

// DEFCON threshold by position
function getThreshold(position) {
    if (position === 'DEF' || position === 'GKP') {
        return DEFCON_THRESHOLD_DEF;
    }
    return DEFCON_THRESHOLD_MID_FWD;
}

function createEmptyPositionStats() {
    return { hits: 0, n: 0 };
}

function createEmptyTeamHistoryEntry() {
    return {
        home: {
            DEF_GKP: createEmptyPositionStats(),
            MID_FWD: createEmptyPositionStats()
        },
        away: {
            DEF_GKP: createEmptyPositionStats(),
            MID_FWD: createEmptyPositionStats()
        },
        overall: {
            DEF_GKP: createEmptyPositionStats(),
            MID_FWD: createEmptyPositionStats()
        }
    };
}

// Build a lookup to determine if a match was home or away for a team
function buildMatchLocationLookup() {
    const lookup = {};

    state.matches.forEach(match => {
        const homeTeamId = mapMatchTeamId(match.home_team || match.team_h || match.home_team_id);
        const awayTeamId = mapMatchTeamId(match.away_team || match.team_a || match.away_team_id);
        const gwKey      = normId(match.event || match.gameweek || match.round || match.gw);

        if (homeTeamId && awayTeamId && gwKey) {
            lookup[`${homeTeamId}_${awayTeamId}_${gwKey}`] = 'home';
            lookup[`${awayTeamId}_${homeTeamId}_${gwKey}`] = 'away';
        }
    });

    return lookup;
}

// Smoothed probability using a Beta prior
function getSmoothedProbability(hits, n, priorMean, priorStrength) {
    const alpha0 = priorMean * priorStrength;
    const beta0  = (1 - priorMean) * priorStrength;

    const alphaPost = alpha0 + hits;
    const betaPost  = beta0 + (n - hits);

    if (alphaPost <= 0 || betaPost <= 0) {
        return priorMean;
    }

    return alphaPost / (alphaPost + betaPost);
}

// Core: build per-opponent, per-location, per-position-group DEFCON hit probabilities
function buildOpponentPositionProbabilities() {
    const matchLocationLookup = buildMatchLocationLookup();
    const opponentHistory = {};
    const leagueTotals = createEmptyTeamHistoryEntry();

    const LOCATIONS = ['home', 'away', 'overall'];
    const GROUPS = ['DEF_GKP', 'MID_FWD'];

    // 1) Accumulate hits and totals
    state.playerMatchStats.forEach(stat => {
        const opponentId = normId(stat.opponent_team || stat.opponent_id || stat.vs_team);
        if (!opponentId) return;

        const player = getPlayerFromStat(stat);
if (!player) return;

        const playerTeam = getTeamFromPlayer(player);
        if (!playerTeam) return;
        const playerTeamId = normId(playerTeam.id || playerTeam.team_id || playerTeam.code);

        const gameweek = stat.round || stat.event || stat.gameweek || stat.gw;
        const gwKey = normId(gameweek);
        if (!gwKey) return;

        const position = getPosition(player);
        const positionGroup = getPositionGroup(position);
        if (!positionGroup) return;

        const score = calculateScore(stat, position);
        if (isNaN(score)) return;

        const threshold = getThreshold(position);

        const lookupKey = `${opponentId}_${playerTeamId}_${gwKey}`;
        const location = matchLocationLookup[lookupKey]; // 'home' or 'away' from opponent POV
        if (location !== 'home' && location !== 'away') return;

        if (!opponentHistory[opponentId]) {
            opponentHistory[opponentId] = createEmptyTeamHistoryEntry();
        }

        const teamEntry = opponentHistory[opponentId];

        const locBucket = teamEntry[location][positionGroup];
        locBucket.n++;
        if (score >= threshold) {
            locBucket.hits++;
        }

        const overallBucket = teamEntry.overall[positionGroup];
        overallBucket.n++;
        if (score >= threshold) {
            overallBucket.hits++;
        }
    });

    // 2) League totals
    Object.values(opponentHistory).forEach(teamEntry => {
        LOCATIONS.forEach(loc => {
            GROUPS.forEach(group => {
                const src = teamEntry[loc][group];
                const dst = leagueTotals[loc][group];
                dst.n += src.n;
                dst.hits += src.hits;
            });
        });
    });

    // 3) League-wide baselines
    const leaguePositionProbs = {
        home:   { DEF_GKP: 0, MID_FWD: 0 },
        away:   { DEF_GKP: 0, MID_FWD: 0 },
        overall:{ DEF_GKP: 0, MID_FWD: 0 }
    };

    ['home', 'away', 'overall'].forEach(loc => {
        GROUPS.forEach(group => {
            const stats = leagueTotals[loc][group];
            if (stats.n > 0) {
                leaguePositionProbs[loc][group] = stats.hits / stats.n;
            } else {
                leaguePositionProbs[loc][group] = DEFAULT_DEFCON_PROB;
            }
        });
    });

    // 4) Smoothed probabilities per opponent/location/group
    const teamPositionProbs = {};
    const priorStrength = DEFCON_PRIOR_STRENGTH;

    Object.entries(opponentHistory).forEach(([teamId, teamEntry]) => {
        teamPositionProbs[teamId] = {
            home:   { DEF_GKP: { prob: 0, sampleSize: 0 }, MID_FWD: { prob: 0, sampleSize: 0 } },
            away:   { DEF_GKP: { prob: 0, sampleSize: 0 }, MID_FWD: { prob: 0, sampleSize: 0 } },
            overall:{ DEF_GKP: { prob: 0, sampleSize: 0 }, MID_FWD: { prob: 0, sampleSize: 0 } }
        };

        GROUPS.forEach(group => {
            ['home', 'away', 'overall'].forEach(loc => {
                const locStats = teamEntry[loc][group];
                const overallStats = teamEntry.overall[group];

                const leagueLocBase     = leaguePositionProbs[loc][group];
                const leagueOverallBase = leaguePositionProbs.overall[group];
                const leagueBase = loc === 'overall'
                    ? leagueOverallBase
                    : (leagueLocBase || leagueOverallBase || DEFAULT_DEFCON_PROB);

                let prob;
                let nUsed = 0;

                if (locStats.n > 0) {
                    prob = getSmoothedProbability(locStats.hits, locStats.n, leagueBase, priorStrength);
                    nUsed = locStats.n;
                } else if (overallStats.n > 0) {
                    prob = getSmoothedProbability(overallStats.hits, overallStats.n, leagueOverallBase, priorStrength);
                    nUsed = overallStats.n;
                } else {
                    prob = leagueBase;
                    nUsed = 0;
                }

                teamPositionProbs[teamId][loc][group] = {
                    prob: Math.max(0, Math.min(1, prob)),
                    sampleSize: nUsed
                };
            });
        });
    });

    return { teamPositionProbs, leaguePositionProbs };
}

// --------------------- Fixtures & Matrix ---------------------

// Upcoming fixtures from matches
function getUpcomingFixtures() {
    const fixtures = [];

    state.matches.forEach(match => {
        const matchDate = new Date(match.kickoff_time || match.datetime || match.date || match.kickoff);

        const isFinished =
            match.finished === true ||
            match.finished === 'true' ||
            match.finished === 'True' ||
            match.finished === 1 ||
            match.finished === '1';

        if (!isFinished) {
            const gwKey      = normId(match.event || match.gameweek || match.round || match.gw || 0);
            const homeTeamId = mapMatchTeamId(match.home_team || match.team_h || match.home_team_id);
            const awayTeamId = mapMatchTeamId(match.away_team || match.team_a || match.away_team_id);

            fixtures.push({
                id: match.id || match.match_id || match.fixture_id,
                gameweek: gwKey ? Number(gwKey) : 0,
                homeTeam: homeTeamId,
                awayTeam: awayTeamId,
                date: matchDate
            });
        }
    });

    fixtures.sort((a, b) => a.date - b.date);
    return fixtures;
}

// Compute probabilities for a team vs an opponent in a given defensive location
function getOpponentProbabilities(opponentId, defendingLocation) {
    const groups = ['DEF_GKP', 'MID_FWD'];
    const probs = {};
    const { teamPositionProbs, leaguePositionProbs } = state;

    groups.forEach(group => {
        let prob = (leaguePositionProbs.overall && leaguePositionProbs.overall[group] != null)
            ? leaguePositionProbs.overall[group]
            : DEFAULT_DEFCON_PROB;

        const teamEntry = teamPositionProbs[opponentId];

        if (teamEntry && teamEntry[defendingLocation] && teamEntry[defendingLocation][group]) {
            prob = teamEntry[defendingLocation][group].prob;
        } else if (teamEntry && teamEntry.overall && teamEntry.overall[group]) {
            prob = teamEntry.overall[group].prob;
        } else {
            const leagueLocBase  = leaguePositionProbs[defendingLocation] && leaguePositionProbs[defendingLocation][group];
            const leagueOverall  = leaguePositionProbs.overall && leaguePositionProbs.overall[group];
            prob = leagueLocBase != null
                ? leagueLocBase
                : (leagueOverall != null ? leagueOverall : DEFAULT_DEFCON_PROB);
        }

        probs[group] = Math.max(0, Math.min(1, prob));
    });

    return probs;
}

// Add a cell to a team's row
function addFixtureCell(row, teamId, opponentId, isHome, gw) {
    if (!row || !opponentId || !gw) return;

    const opponentMeta = state.teamLookup[opponentId];
    const defendingLocation = isHome ? 'away' : 'home'; // opponent is defending
    const probabilities = getOpponentProbabilities(opponentId, defendingLocation);

    row.fixtures[gw] = {
        gameweek: gw,
        teamId,
        opponentId,
        opponentShortName: opponentMeta ? opponentMeta.shortName : opponentId,
        location: isHome ? 'H' : 'A',
        probabilities // { DEF_GKP: p, MID_FWD: p }
    };
}

// Build the fixture matrix: rows by team, columns by GW
function buildFixtureMatrix() {
    const { teamPositionProbs, leaguePositionProbs } = buildOpponentPositionProbabilities();
    state.teamPositionProbs = teamPositionProbs;
    state.leaguePositionProbs = leaguePositionProbs;

    const fixtures = getUpcomingFixtures();

    const gwSet = new Set();
    fixtures.forEach(f => {
        if (f.gameweek && f.gameweek > 0) gwSet.add(f.gameweek);
    });
    const gameweeks = Array.from(gwSet).sort((a, b) => a - b);

    const rowsByTeamId = {};
    Object.values(state.teamLookup).forEach(team => {
        rowsByTeamId[team.id] = {
            teamId: team.id,
            name: team.name,
            shortName: team.shortName,
            fixtures: {} // gw -> cell
        };
    });

    fixtures.forEach(f => {
        if (!f.homeTeam || !f.awayTeam || !f.gameweek) return;
        const gw = f.gameweek;

        // From home team's perspective
        addFixtureCell(rowsByTeamId[f.homeTeam], f.homeTeam, f.awayTeam, true, gw);

        // From away team's perspective
        addFixtureCell(rowsByTeamId[f.awayTeam], f.awayTeam, f.homeTeam, false, gw);
    });

    const rows = Object.values(rowsByTeamId).sort((a, b) => a.name.localeCompare(b.name));

    state.fixtureMatrix = {
        gameweeks,
        rows
    };
}

// --------------------- Rendering ---------------------

function getProbabilityClass(prob) {
    if (prob >= 0.6) return 'very-high';
    if (prob >= 0.4) return 'high';
    if (prob >= 0.25) return 'med';
    return 'low';
}

function renderFixtureMatrix() {
    const matrix = state.fixtureMatrix;
    if (!matrix || !matrix.gameweeks.length) {
        elements.fixtureHeader.innerHTML = '';
        elements.fixtureBody.innerHTML = `
            <tr class="no-results">
                <td colspan="2">No upcoming fixtures available</td>
            </tr>
        `;
        return;
    }

    const positionGroup = getPositionGroupFromArchetype(state.filters.archetype);

    // Header row: Team + GWs
    const headerHtml = `
        <tr>
            <th>Team</th>
            ${matrix.gameweeks.map(gw => `<th>GW ${gw}</th>`).join('')}
        </tr>
    `;
    elements.fixtureHeader.innerHTML = headerHtml;

    // Body rows
    const bodyHtml = matrix.rows.map(row => {
        const cellsHtml = matrix.gameweeks.map(gw => {
            const cell = row.fixtures[gw];
            if (!cell) {
                return `<td class="no-fixture">-</td>`;
            }

            const prob = cell.probabilities[positionGroup] ?? DEFAULT_DEFCON_PROB;
            const probPercent = (prob * 100).toFixed(0);
            const probClass = getProbabilityClass(prob);
            const label = `${cell.opponentShortName} ${cell.location}`;

            return `
                <td class="fixture-cell prob-${probClass}">
                    <div class="fixture-opponent">${label}</div>
                    <div class="fixture-prob">${probPercent}%</div>
                </td>
            `;
        }).join('');

        return `
            <tr>
                <td class="team-cell"><strong>${row.shortName}</strong></td>
                ${cellsHtml}
            </tr>
        `;
    }).join('');

    elements.fixtureBody.innerHTML = bodyHtml;
}

// --------------------- Events ---------------------

function setupEventListeners() {
    if (elements.archetypeFilter) {
        elements.archetypeFilter.addEventListener('change', (e) => {
            state.filters.archetype = e.target.value;
            renderFixtureMatrix();
        });
    }
}

// --------------------- Init ---------------------

async function init() {
    console.log('FPL DEFCON Fixture Matrix initializing...');

    const success = await loadAllData();

    if (!success) {
        elements.loading?.classList.add('hidden');
        elements.error?.classList.remove('hidden');
        return;
    }

    console.log('Data loaded:', {
        players: state.players.length,
        matchStats: state.playerMatchStats.length,
        matches: state.matches.length,
        teams: state.teams.length
    });

    buildFixtureMatrix();
    console.log('Fixture matrix built');

    setupEventListeners();
    renderFixtureMatrix();

    elements.loading?.classList.add('hidden');
    elements.mainContent?.classList.remove('hidden');

    console.log('FPL DEFCON Fixture Matrix ready!');
}

document.addEventListener('DOMContentLoaded', init);