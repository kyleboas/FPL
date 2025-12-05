// FPL DEFCON Predictor - Main Application
// Data source: https://github.com/olbauday/FPL-Elo-Insights

const DATA_BASE_URL = 'https://raw.githubusercontent.com/olbauday/FPL-Elo-Insights/main/data/2025-2026';
const DATA_GW_URL = 'https://raw.githubusercontent.com/olbauday/FPL-Elo-Insights/main/data/2025-2026/By%20Tournament/Premier%20League';
const DEFCON_THRESHOLD_DEF = 10;  // CBIT threshold for defenders/keepers
const DEFCON_THRESHOLD_MID_FWD = 12;  // CBIRT threshold for mids/forwards
const MAX_GAMEWEEKS = 38;  // Maximum gameweeks in a season

// Default league-wide DEFCON probability when no data exists yet
// This is the neutral baseline chance that a player of a given position group
// hits the DEFCON threshold vs a random opponent.
const DEFAULT_DEFCON_PROB = 0.28;

// Strength of league-wide prior (in "virtual games") for smoothing per-opponent rates.
// Higher = more regression to league average, lower = more noisy team-specific rates.
const DEFCON_PRIOR_STRENGTH = 6;

// Global state
let state = {
    players: [],
    playerMatchStats: [],
    matches: [],
    teams: [],
    processedData: [],
    filters: {
        position: 'all',
        team: 'all',
        gameweek: 'next',
        minMatches: 3,
        sortBy: 'probability'
    }
};

// DOM Elements
const elements = {
    loading: document.getElementById('loading'),
    error: document.getElementById('error'),
    mainContent: document.getElementById('main-content'),
    resultsBody: document.getElementById('results-body'),
    positionFilter: document.getElementById('position-filter'),
    teamFilter: document.getElementById('team-filter'),
    gameweekFilter: document.getElementById('gameweek-filter'),
    minMatches: document.getElementById('min-matches'),
    sortBy: document.getElementById('sort-by'),
    totalPlayers: document.getElementById('total-players'),
    highProbCount: document.getElementById('high-prob-count'),
    medProbCount: document.getElementById('med-prob-count')
};

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

    // Try to fetch from all gameweeks (1 to MAX_GAMEWEEKS)
    for (let gw = 1; gw <= MAX_GAMEWEEKS; gw++) {
        fetchPromises.push(
            fetchGameweekCSV(gw, filename)
                .then(data => ({ gw, data, success: true }))
                .catch(() => ({ gw, data: [], success: false }))
        );
    }

    const results = await Promise.all(fetchPromises);

    // Aggregate successful results
    results.forEach(result => {
        if (result.success && result.data.length > 0) {
            allData.push(...result.data);
        }
    });

    return allData;
}

async function loadAllData() {
    try {
        // Fetch players and teams from root (these exist at root level)
        const [players, teams] = await Promise.all([
            fetchRootCSV('players.csv'),
            fetchRootCSV('teams.csv')
        ]);

        state.players = players;
        state.teams = teams;

        console.log('Loaded root data:', { players: players.length, teams: teams.length });

        // Fetch player stats and matches from all gameweeks
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

        // Validate we have enough data
        if (players.length === 0 || teams.length === 0) {
            throw new Error('Failed to load essential player/team data');
        }

        if (playerMatchStats.length === 0 || matches.length === 0) {
            console.warn('No gameweek data available yet - season may not have started');
        }

        return true;
    } catch (error) {
        console.error('Error loading data:', error);
        return false;
    }
}

// Map a player row to its team row using FPL-Elo-Insights conventions:
// players.team_id -> teams.code, and then teams.id is the canonical key for matches.
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

// Map a team id coming from matches.csv (usually FPL "code" like 91.0)
// to the canonical team id we use elsewhere (teams.id).
function mapMatchTeamId(rawTeamId) {
    const codeKey = normId(rawTeamId);
    if (!codeKey) return null;

    const team = state.teams.find(t =>
        normId(t.code || t.team_code) === codeKey ||
        normId(t.id || t.team_id) === codeKey
    );

    // Canonical id is teams.id (fallback to whatever we got if not found)
    return team ? normId(team.id || team.team_id || team.code) : codeKey;
}

// Calculate CBIT for a defender/keeper match
// CBIT = Interceptions + Clearances + Blocks + Tackles
function calculateCBIT(matchStat) {
    // FPL-Elo-Insights uses: tackles, interceptions, clearances, blocks
    const interceptions = parseFloat(matchStat.interceptions || matchStat.clearances_blocks_interceptions || 0);
    const clearances = parseFloat(matchStat.clearances || 0);
    const blocks = parseFloat(matchStat.blocks || 0);
    const tackles = parseFloat(matchStat.tackles || matchStat.tackles_won || 0);

    // No clean sheets or bonus in this metric
    return interceptions + clearances + blocks + tackles;
}

// Calculate CBIRT for mids/forwards
// CBIRT = Interceptions + Recoveries + Tackles
function calculateCBIRT(matchStat, position) {
    // FPL-Elo-Insights uses: tackles, interceptions, recoveries
    const interceptions = parseFloat(matchStat.interceptions || matchStat.clearances_blocks_interceptions || 0);
    const recoveries = parseFloat(matchStat.recoveries || matchStat.ball_recoveries || 0);
    const tackles = parseFloat(matchStat.tackles || matchStat.tackles_won || 0);

    // No clean sheets or bonus in this metric
    return interceptions + recoveries + tackles;
}

// Get player position from element_type or position field
function getPosition(player) {
    // Try numeric element_type first (FPL API standard: 1=GKP, 2=DEF, 3=MID, 4=FWD)
    const elementType = parseInt(player.element_type || player.position || player.pos || 0);
    const posMap = { 1: 'GKP', 2: 'DEF', 3: 'MID', 4: 'FWD' };
    if (posMap[elementType]) {
        return posMap[elementType];
    }

    // Try string position codes
    const posStr = (player.singular_name_short || player.position || player.pos || '').toUpperCase();
    const strMap = {
        'GK': 'GKP', 'GKP': 'GKP', 'GOALKEEPER': 'GKP',
        'DEF': 'DEF', 'D': 'DEF', 'DEFENDER': 'DEF',
        'MID': 'MID', 'M': 'MID', 'MIDFIELDER': 'MID',
        'FWD': 'FWD', 'F': 'FWD', 'FW': 'FWD', 'FORWARD': 'FWD', 'ATT': 'FWD'
    };
    return strMap[posStr] || 'UNK';
}

// Calculate score based on position
function calculateScore(matchStat, position) {
    if (position === 'DEF' || position === 'GKP') {
        return calculateCBIT(matchStat);
    }
    return calculateCBIRT(matchStat, position);
}

// Get DEFCON threshold based on position
function getThreshold(position) {
    if (position === 'DEF' || position === 'GKP') {
        return DEFCON_THRESHOLD_DEF;
    }
    return DEFCON_THRESHOLD_MID_FWD;
}

// Group positions into DEF+GKP vs MID+FWD buckets for opponent-history aggregation
function getPositionGroup(position) {
    if (position === 'DEF' || position === 'GKP') {
        return 'DEF_GKP';
    }
    if (position === 'MID' || position === 'FWD') {
        return 'MID_FWD';
    }
    return null;
}

// Helper for opponent-history stats
function createEmptyPositionStats() {
    return { hits: 0, n: 0 };
}

// Helper structure for per-team, per-location, per-position-group counts
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

        // Create lookup keys: "teamId_opponentId_gameweek"
        if (homeTeamId && awayTeamId && gwKey) {
            lookup[`${homeTeamId}_${awayTeamId}_${gwKey}`] = 'home';
            lookup[`${awayTeamId}_${homeTeamId}_${gwKey}`] = 'away';
        }
    });

    return lookup;
}

// Calculate opponent "CBIT/CBIRT allowed" multiplier with home/away split
// Higher multiplier = opponent allows more defensive returns (easier fixture)
function calculateOpponentMultipliers() {
    const teamStats = {};
    const matchLocationLookup = buildMatchLocationLookup();

    // Initialize team stats with separate home/away tracking
    state.teams.forEach(team => {
        const teamId = normId(team.id || team.team_id || team.code);
        if (!teamId) return;

        teamStats[teamId] = {
            name: team.name || team.team_name,
            shortName: team.short_name || (team.name ? team.name.substring(0, 3).toUpperCase() : 'UNK'),
            home: { totalAllowed: 0, matchCount: 0 },
            away: { totalAllowed: 0, matchCount: 0 },
            overall: { totalAllowed: 0, matchCount: 0 }
        };
    });

    // Calculate what each team allows to opponents (split by home/away)
    state.playerMatchStats.forEach(stat => {
        // FPL-Elo-Insights uses opponent_team field -> matches teams.id
        const opponentId = normId(stat.opponent_team || stat.opponent_id || stat.vs_team);
        if (!opponentId || !teamStats[opponentId]) return;

        // Link stats to players: player_gameweek_stats.id -> players.player_id/element
        const playerId = stat.id || stat.element || stat.player_id;
        const player = state.players.find(p =>
            (p.player_id || p.id || p.element) == playerId
        );
        if (!player) return;

        // Resolve player's actual team row and canonical team id (matches teams.id)
        const playerTeam = getTeamFromPlayer(player);
        if (!playerTeam) return;
        const playerTeamId = normId(playerTeam.id || playerTeam.team_id || playerTeam.code);

        const gameweek = stat.round || stat.event || stat.gameweek || stat.gw;
        const gwKey = normId(gameweek);
        const position = getPosition(player);
        const score = calculateScore(stat, position);

        // Determine if this was a home or away match for the opponent
        const lookupKey = `${opponentId}_${playerTeamId}_${gwKey}`;
        const location = matchLocationLookup[lookupKey];

        if (location === 'home') {
            // Opponent was at home (defending at home)
            teamStats[opponentId].home.totalAllowed += score;
            teamStats[opponentId].home.matchCount++;
        } else if (location === 'away') {
            // Opponent was away (defending away)
            teamStats[opponentId].away.totalAllowed += score;
            teamStats[opponentId].away.matchCount++;
        }

        // Always track overall
        teamStats[opponentId].overall.totalAllowed += score;
        teamStats[opponentId].overall.matchCount++;
    });

    // Calculate averages and league averages (separate for home/away)
    let leagueHomeTotal = 0, leagueHomeCount = 0;
    let leagueAwayTotal = 0, leagueAwayCount = 0;
    let leagueOverallTotal = 0, leagueOverallCount = 0;

    Object.values(teamStats).forEach(team => {
        // Home average
        if (team.home.matchCount > 0) {
            team.home.avgAllowed = team.home.totalAllowed / team.home.matchCount;
            leagueHomeTotal += team.home.avgAllowed;
            leagueHomeCount++;
        } else {
            team.home.avgAllowed = 0;
        }

        // Away average
        if (team.away.matchCount > 0) {
            team.away.avgAllowed = team.away.totalAllowed / team.away.matchCount;
            leagueAwayTotal += team.away.avgAllowed;
            leagueAwayCount++;
        } else {
            team.away.avgAllowed = 0;
        }

        // Overall average (fallback)
        if (team.overall.matchCount > 0) {
            team.overall.avgAllowed = team.overall.totalAllowed / team.overall.matchCount;
            leagueOverallTotal += team.overall.avgAllowed;
            leagueOverallCount++;
        } else {
            team.overall.avgAllowed = 0;
        }
    });

    const leagueHomeAvg = leagueHomeCount > 0 ? leagueHomeTotal / leagueHomeCount : 1;
    const leagueAwayAvg = leagueAwayCount > 0 ? leagueAwayTotal / leagueAwayCount : 1;
    const leagueOverallAvg = leagueOverallCount > 0 ? leagueOverallTotal / leagueOverallCount : 1;

    // Calculate multipliers (ratio vs league average)
    Object.values(teamStats).forEach(team => {
        team.home.multiplier = leagueHomeAvg > 0 ? team.home.avgAllowed / leagueHomeAvg : 1;
        team.away.multiplier = leagueAwayAvg > 0 ? team.away.avgAllowed / leagueAwayAvg : 1;
        team.overall.multiplier = leagueOverallAvg > 0 ? team.overall.avgAllowed / leagueOverallAvg : 1;

        // Fallback: if no home/away data, use overall
        if (team.home.matchCount === 0) team.home.multiplier = team.overall.multiplier;
        if (team.away.matchCount === 0) team.away.multiplier = team.overall.multiplier;
    });

    return teamStats;
}

// Smoothed probability using a Beta prior with mean = priorMean and strength = priorStrength
// This keeps probabilities stable for small sample sizes.
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

// Build historical DEFCON hit probabilities by opponent, location (home/away),
// and position group (DEF_GKP vs MID_FWD).
// This is the core engine driving DEFCON probabilities.
function buildOpponentPositionProbabilities() {
    const matchLocationLookup = buildMatchLocationLookup();
    const opponentHistory = {};
    const leagueTotals = createEmptyTeamHistoryEntry(); // reused shape for league-level aggregation

    const LOCATIONS = ['home', 'away', 'overall'];
    const GROUPS = ['DEF_GKP', 'MID_FWD'];

    // 1) Accumulate hits and totals per opponent/location/positionGroup
    state.playerMatchStats.forEach(stat => {
        const opponentId = normId(stat.opponent_team || stat.opponent_id || stat.vs_team);
        if (!opponentId) return;

        const playerId = stat.id || stat.element || stat.player_id;
        const player = state.players.find(p =>
            (p.player_id || p.id || p.element) == playerId
        );
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

        // Determine if the OPPONENT was at home or away in this match
        const lookupKey = `${opponentId}_${playerTeamId}_${gwKey}`;
        const location = matchLocationLookup[lookupKey]; // 'home' or 'away' from opponent POV
        if (location !== 'home' && location !== 'away') return;

        if (!opponentHistory[opponentId]) {
            opponentHistory[opponentId] = createEmptyTeamHistoryEntry();
        }

        const teamEntry = opponentHistory[opponentId];

        // Location-specific bucket (home/away)
        const locBucket = teamEntry[location][positionGroup];
        locBucket.n++;
        if (score >= threshold) {
            locBucket.hits++;
        }

        // Overall bucket (regardless of home/away)
        const overallBucket = teamEntry.overall[positionGroup];
        overallBucket.n++;
        if (score >= threshold) {
            overallBucket.hits++;
        }
    });

    // 2) Compute league totals by aggregating all teams
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

    // 3) League-wide baseline probabilities (used for smoothing & fallbacks)
    const leaguePositionProbs = {
        home:   { DEF_GKP: 0, MID_FWD: 0 },
        away:   { DEF_GKP: 0, MID_FWD: 0 },
        overall:{ DEF_GKP: 0, MID_FWD: 0 }
    };

    LOCATIONS.forEach(loc => {
        GROUPS.forEach(group => {
            const stats = leagueTotals[loc][group];
            if (stats.n > 0) {
                leaguePositionProbs[loc][group] = stats.hits / stats.n;
            } else {
                leaguePositionProbs[loc][group] = DEFAULT_DEFCON_PROB;
            }
        });
    });

    // 4) Convert raw counts into smoothed probabilities per opponent/location/group
    const teamPositionProbs = {};
    const priorStrength = DEFCON_PRIOR_STRENGTH;

    Object.entries(opponentHistory).forEach(([teamId, teamEntry]) => {
        teamPositionProbs[teamId] = {
            home:   { DEF_GKP: { prob: 0, sampleSize: 0 }, MID_FWD: { prob: 0, sampleSize: 0 } },
            away:   { DEF_GKP: { prob: 0, sampleSize: 0 }, MID_FWD: { prob: 0, sampleSize: 0 } },
            overall:{ DEF_GKP: { prob: 0, sampleSize: 0 }, MID_FWD: { prob: 0, sampleSize: 0 } }
        };

        GROUPS.forEach(group => {
            LOCATIONS.forEach(loc => {
                const locStats = teamEntry[loc][group];
                const overallStats = teamEntry.overall[group];

                // Select league baseline for this bucket
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
                    // No history at all for this team+group: use league baseline
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

// Get upcoming fixtures
function getUpcomingFixtures() {
    const fixtures = [];

    state.matches.forEach(match => {
        // FPL-Elo-Insights uses: kickoff_time, event, home_team, away_team, finished
        const matchDate = new Date(match.kickoff_time || match.datetime || match.date || match.kickoff);
        const isFinished =
            match.finished === true ||
            match.finished === 'true' ||
            match.finished === 'True' ||
            match.finished === 1 ||
            match.finished === '1';

        // Only include fixtures that are not finished (future or upcoming matches)
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

    // Sort by date
    fixtures.sort((a, b) => a.date - b.date);

    return fixtures;
}

// Process all player data
// Core change: DEFCON probability now comes from opponent's historical
// allowance vs that position group (DEF+GKP vs MID+FWD) at the given
// defensive location (home/away), rather than from the player's own distribution.
function processPlayerData() {
    const opponentMultipliers = calculateOpponentMultipliers();
    const { teamPositionProbs, leaguePositionProbs } = buildOpponentPositionProbabilities();
    const upcomingFixtures = getUpcomingFixtures();
    const processed = [];

    // Group match stats by player
    const playerStats = {};
    state.playerMatchStats.forEach(stat => {
        // player_gameweek_stats.id -> players.player_id
        const playerId = stat.id || stat.element || stat.player_id;
        if (!playerStats[playerId]) {
            playerStats[playerId] = [];
        }
        playerStats[playerId].push(stat);
    });

    // Process each player
    state.players.forEach(player => {
        const playerId = player.player_id || player.id || player.element;
        const position = getPosition(player);
        const positionGroup = getPositionGroup(position);

        // Ignore unknown positions altogether
        if (!positionGroup) return;

        const team = getTeamFromPlayer(player);
        if (!team) return;

        // Canonical normalized team id (matches matches.home_team / matches.away_team)
        const teamId = normId(team.id || team.team_id || team.code);

        const stats = playerStats[playerId] || [];
        if (stats.length === 0) return;

        // Calculate scores for each match
        const scores = stats
            .map(s => calculateScore(s, position))
            .filter(s => !isNaN(s));

        if (scores.length === 0) return;

        // Calculate average score (still useful to show historical involvement)
        const avgScore = scores.reduce((a, b) => a + b, 0) / scores.length;

        // Find next fixture for this player's team
        const nextFixture = upcomingFixtures.find(f =>
            f.homeTeam === teamId || f.awayTeam === teamId
        );

        let opponentId = null;
        let opponentMultiplier = 1;
        let opponentName = 'TBD';
        let isHome = null;
        let fixtureLocation = '';

        if (nextFixture) {
            // Determine if player's team is home or away
            isHome = nextFixture.homeTeam === teamId;
            opponentId = isHome ? nextFixture.awayTeam : nextFixture.homeTeam;
            fixtureLocation = isHome ? 'H' : 'A';

            if (opponentMultipliers[opponentId]) {
                // Use home/away specific multiplier based on opponent's defensive location
                // If player is home, opponent defends away (and vice versa)
                const opponentDefendsAt = isHome ? 'away' : 'home';
                opponentMultiplier = opponentMultipliers[opponentId][opponentDefendsAt].multiplier || 1;
                opponentName = opponentMultipliers[opponentId].shortName ||
                    opponentMultipliers[opponentId].name || 'UNK';
            } else {
                // Fallback: look up opponent team directly from teams array
                const opponentTeam = state.teams.find(t =>
                    normId(t.id || t.team_id || t.code) === opponentId
                );
                if (opponentTeam) {
                    opponentName = opponentTeam.short_name ||
                        (opponentTeam.name ? opponentTeam.name.substring(0, 3).toUpperCase() : 'TBD');
                }
            }
        }

        // Adjusted score still uses historical avg * opponent multiplier for UI
        const adjustedScore = avgScore * opponentMultiplier;

        // --- New DEFCON probability logic ---
        // Base fallback: league-wide overall probability for this position group
        let probability = (leaguePositionProbs.overall && leaguePositionProbs.overall[positionGroup] != null)
            ? leaguePositionProbs.overall[positionGroup]
            : DEFAULT_DEFCON_PROB;

        if (nextFixture && opponentId) {
            const defLocation = isHome ? 'away' : 'home'; // where opponent is defending
            const teamEntry = teamPositionProbs[opponentId];

            if (teamEntry && teamEntry[defLocation] && teamEntry[defLocation][positionGroup]) {
                // Use opponent+location+position-group-specific probability (already smoothed)
                probability = teamEntry[defLocation][positionGroup].prob;
            } else if (teamEntry && teamEntry.overall && teamEntry.overall[positionGroup]) {
                // Fallback to opponent overall vs this position group
                probability = teamEntry.overall[positionGroup].prob;
            } else {
                // Final fallback: league baselines (home/away then overall)
                const leagueLocBase  = leaguePositionProbs[defLocation] && leaguePositionProbs[defLocation][positionGroup];
                const leagueOverall  = leaguePositionProbs.overall && leaguePositionProbs.overall[positionGroup];
                probability = leagueLocBase != null
                    ? leagueLocBase
                    : (leagueOverall != null ? leagueOverall : DEFAULT_DEFCON_PROB);
            }
        }

        probability = Math.max(0, Math.min(1, probability));

        // Team name for display
        const teamName = team.short_name ||
            (team.name ? team.name.substring(0, 3).toUpperCase() : 'UNK');

        processed.push({
            id: playerId,
            name: `${player.first_name || ''} ${player.second_name || player.web_name || ''}`.trim() || player.web_name,
            webName: player.web_name || player.second_name,
            team: teamName,
            teamId: teamId,
            position: position,
            avgScore: avgScore,
            adjustedScore: adjustedScore,
            matchCount: scores.length,
            scores: scores,
            threshold: getThreshold(position),
            opponent: opponentName,
            opponentId: opponentId,
            opponentMultiplier: opponentMultiplier,
            probability: probability,
            nextGameweek: nextFixture?.gameweek || null,
            fixtureLocation: fixtureLocation,
            isHome: isHome
        });
    });

    state.processedData = processed;
    return processed;
}

// Filter and sort data based on current filters
function getFilteredData() {
    let data = [...state.processedData];

    // Position filter
    if (state.filters.position !== 'all') {
        data = data.filter(p => p.position === state.filters.position);
    }

    // Team filter
    if (state.filters.team !== 'all') {
        data = data.filter(p => p.teamId == state.filters.team);
    }

    // Min matches filter
    data = data.filter(p => p.matchCount >= state.filters.minMatches);

    // Sort
    switch (state.filters.sortBy) {
        case 'probability':
            data.sort((a, b) => b.probability - a.probability);
            break;
        case 'average':
            data.sort((a, b) => b.avgScore - a.avgScore);
            break;
        case 'name':
            data.sort((a, b) => a.webName.localeCompare(b.webName));
            break;
    }

    return data;
}

// Render results table
function renderResults() {
    const data = getFilteredData();

    // Update stats
    elements.totalPlayers.textContent = data.length;
    elements.highProbCount.textContent = data.filter(p => p.probability >= 0.5).length;
    elements.medProbCount.textContent = data.filter(p => p.probability >= 0.25 && p.probability < 0.5).length;

    // Render table
    if (data.length === 0) {
        elements.resultsBody.innerHTML = `
            <tr class="no-results">
                <td colspan="9">No players match the current filters</td>
            </tr>
        `;
        return;
    }

    elements.resultsBody.innerHTML = data.map(player => {
        const probPercent = (player.probability * 100).toFixed(1);
        const probClass = getProbabilityClass(player.probability);
        const multClass = getMultiplierClass(player.opponentMultiplier);
        const fixtureDisplay = player.fixtureLocation ? `${player.opponent} (${player.fixtureLocation})` : player.opponent;

        return `
            <tr>
                <td><strong>${escapeHtml(player.webName)}</strong></td>
                <td>${escapeHtml(player.team)}</td>
                <td><span class="pos-badge pos-${player.position}">${player.position}</span></td>
                <td>${player.avgScore.toFixed(1)}</td>
                <td>${player.matchCount}</td>
                <td>${escapeHtml(fixtureDisplay)}</td>
                <td class="${multClass}">${player.opponentMultiplier.toFixed(2)}x</td>
                <td>${player.adjustedScore.toFixed(1)}</td>
                <td>
                    <div class="prob-cell">
                        <div class="prob-bar">
                            <div class="prob-fill prob-${probClass}" style="width: ${probPercent}%"></div>
                        </div>
                        <span class="prob-value ${probClass}">${probPercent}%</span>
                    </div>
                </td>
            </tr>
        `;
    }).join('');
}

function getProbabilityClass(prob) {
    if (prob >= 0.6) return 'very-high';
    if (prob >= 0.4) return 'high';
    if (prob >= 0.25) return 'med';
    return 'low';
}

function getMultiplierClass(mult) {
    if (mult >= 1.15) return 'mult-good';
    if (mult <= 0.85) return 'mult-bad';
    return 'mult-neutral';
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Populate filter dropdowns
function populateFilters() {
    // Team filter
    const teams = [...state.teams].sort((a, b) =>
        (a.name || '').localeCompare(b.name || '')
    );

    teams.forEach(team => {
        const option = document.createElement('option');
        // Use the same ID field priority as player data for consistency (normalized)
        option.value = normId(team.id || team.team_id || team.code);
        option.textContent = team.name || team.team_name;
        elements.teamFilter.appendChild(option);
    });

    // Gameweek filter
    const gameweeks = [...new Set(state.processedData.map(p => p.nextGameweek))]
        .filter(g => g)
        .sort((a, b) => a - b);

    gameweeks.forEach(gw => {
        const option = document.createElement('option');
        option.value = gw;
        option.textContent = `GW ${gw}`;
        elements.gameweekFilter.appendChild(option);
    });
}

// Set up event listeners
function setupEventListeners() {
    elements.positionFilter.addEventListener('change', (e) => {
        state.filters.position = e.target.value;
        renderResults();
    });

    elements.teamFilter.addEventListener('change', (e) => {
        state.filters.team = e.target.value;
        renderResults();
    });

    elements.gameweekFilter.addEventListener('change', (e) => {
        state.filters.gameweek = e.target.value;
        renderResults();
    });

    elements.minMatches.addEventListener('change', (e) => {
        state.filters.minMatches = parseInt(e.target.value) || 1;
        renderResults();
    });

    elements.sortBy.addEventListener('change', (e) => {
        state.filters.sortBy = e.target.value;
        renderResults();
    });
}

// Initialize application
async function init() {
    console.log('FPL DEFCON Predictor initializing...');

    const success = await loadAllData();

    if (!success) {
        elements.loading.classList.add('hidden');
        elements.error.classList.remove('hidden');
        return;
    }

    console.log('Data loaded:', {
        players: state.players.length,
        matchStats: state.playerMatchStats.length,
        matches: state.matches.length,
        teams: state.teams.length
    });

    // Process data
    processPlayerData();
    console.log('Processed players:', state.processedData.length);

    // Populate filters
    populateFilters();

    // Set up event listeners
    setupEventListeners();

    // Initial render
    renderResults();

    // Show main content
    elements.loading.classList.add('hidden');
    elements.mainContent.classList.remove('hidden');

    console.log('FPL DEFCON Predictor ready!');
}

// Start the application
document.addEventListener('DOMContentLoaded', init);