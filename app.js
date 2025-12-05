// FPL DEFCON Predictor - Main Application
// Data source: https://github.com/olbauday/FPL-Elo-Insights

const DATA_BASE_URL = 'https://raw.githubusercontent.com/olbauday/FPL-Elo-Insights/main/data/2025-2026';
const DATA_GW_URL = 'https://raw.githubusercontent.com/olbauday/FPL-Elo-Insights/main/data/2025-2026/By%20Tournament/Premier%20League';
const DEFCON_THRESHOLD_DEF = 10;  // CBIT threshold for defenders
const DEFCON_THRESHOLD_MID_FWD = 12;  // CBIRT threshold for mids/forwards
const MAX_GAMEWEEKS = 38;  // Maximum gameweeks in a season

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
        // These files exist in By Tournament/Premier League/GW{x}/ subdirectories
        const [playerMatchStats, matches] = await Promise.all([
            fetchAllGameweekData('player_gameweek_stats.csv'),
            fetchAllGameweekData('fixtures.csv')
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

// Calculate CBIT for a defender match
// CBIT = Clean Sheet Points + Bonus + Interceptions + Tackles (blocked passes proxy)
function calculateCBIT(matchStat) {
    const cleanSheet = parseFloat(matchStat.clean_sheets || matchStat.cleansheet || 0);
    const bonus = parseFloat(matchStat.bonus || 0);
    // Use clearances, blocks, interceptions as defensive stats
    // FPL-Elo-Insights uses: tackles, interceptions, clearances, blocks
    const interceptions = parseFloat(matchStat.interceptions || matchStat.clearances_blocks_interceptions || 0);
    const clearances = parseFloat(matchStat.clearances || 0);
    const blocks = parseFloat(matchStat.blocks || 0);
    const tackles = parseFloat(matchStat.tackles || matchStat.tackles_won || 0);

    // Clean sheet gives 4 points for defenders, treat as 4 if they got one
    const csPoints = cleanSheet >= 1 ? 4 : 0;

    // Include clearances and blocks in the calculation
    return csPoints + bonus + interceptions + clearances + blocks + tackles;
}

// Calculate CBIRT for mids/forwards
// CBIRT = Clean Sheet Points + Bonus + Interceptions + Recoveries + Tackles
function calculateCBIRT(matchStat, position) {
    const cleanSheet = parseFloat(matchStat.clean_sheets || matchStat.cleansheet || 0);
    const bonus = parseFloat(matchStat.bonus || 0);
    // FPL-Elo-Insights uses: tackles, interceptions, recoveries
    const interceptions = parseFloat(matchStat.interceptions || matchStat.clearances_blocks_interceptions || 0);
    const recoveries = parseFloat(matchStat.recoveries || matchStat.ball_recoveries || 0);
    const tackles = parseFloat(matchStat.tackles || matchStat.tackles_won || 0);

    // Clean sheet gives 1 point for mids, 0 for forwards
    let csPoints = 0;
    if (position === 'MID' && cleanSheet >= 1) {
        csPoints = 1;
    }

    return csPoints + bonus + interceptions + recoveries + tackles;
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

// Build a lookup to determine if a match was home or away for a team
function buildMatchLocationLookup() {
    const lookup = {};

    state.matches.forEach(match => {
        const matchId = match.id || match.match_id;
        const homeTeam = match.team_h || match.home_team_id;
        const awayTeam = match.team_a || match.away_team_id;
        const gameweek = match.event || match.gameweek;

        // Create lookup keys: "teamId_opponentId_gameweek"
        if (homeTeam && awayTeam && gameweek) {
            lookup[`${homeTeam}_${awayTeam}_${gameweek}`] = 'home';
            lookup[`${awayTeam}_${homeTeam}_${gameweek}`] = 'away';
        }
    });

    return lookup;
}

// Calculate opponent "CBIT allowed" multiplier with home/away split
// Higher multiplier = opponent allows more defensive returns (easier fixture)
function calculateOpponentMultipliers() {
    const teamStats = {};
    const matchLocationLookup = buildMatchLocationLookup();

    // Initialize team stats with separate home/away tracking
    state.teams.forEach(team => {
        const teamId = team.id || team.team_id || team.code;
        teamStats[teamId] = {
            name: team.name || team.team_name,
            shortName: team.short_name || team.name?.substring(0, 3).toUpperCase(),
            home: { totalAllowed: 0, matchCount: 0 },
            away: { totalAllowed: 0, matchCount: 0 },
            overall: { totalAllowed: 0, matchCount: 0 }
        };
    });

    // Calculate what each team allows to opponents (split by home/away)
    state.playerMatchStats.forEach(stat => {
        // FPL-Elo-Insights uses opponent_team field
        const opponentId = stat.opponent_team || stat.opponent_id || stat.vs_team;
        if (!opponentId || !teamStats[opponentId]) return;

        // Get player and their team - FPL-Elo-Insights uses element for player ID
        const player = state.players.find(p =>
            (p.id || p.player_id || p.element) === (stat.element || stat.player_id)
        );
        if (!player) return;

        const playerTeamId = player.team || player.team_id || player.team_code;
        const gameweek = stat.round || stat.event || stat.gameweek;
        const position = getPosition(player);
        const score = calculateScore(stat, position);

        // Determine if this was a home or away match for the opponent
        const lookupKey = `${opponentId}_${playerTeamId}_${gameweek}`;
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

// Calculate DEFCON probability using historical data and normal distribution approximation
function calculateProbability(scores, threshold, opponentMultiplier = 1) {
    if (scores.length === 0) return 0;

    // Calculate mean and standard deviation
    const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
    const adjustedMean = mean * opponentMultiplier;

    const variance = scores.reduce((sum, x) => sum + Math.pow(x - mean, 2), 0) / scores.length;
    const stdDev = Math.sqrt(variance) || 1;

    // Use empirical probability (what % of historical games hit threshold)
    const empiricalHits = scores.filter(s => s >= threshold).length;
    const empiricalProb = empiricalHits / scores.length;

    // Adjust for opponent - if multiplier > 1, increase probability
    // Use a weighted blend of empirical and adjusted calculation
    const zScore = (threshold - adjustedMean) / stdDev;

    // Approximate normal CDF for probability of exceeding threshold
    // P(X >= threshold) = 1 - P(X < threshold)
    const normalProb = 1 - normalCDF(zScore);

    // Blend empirical and statistical approaches
    const blendedProb = (empiricalProb * 0.6) + (normalProb * 0.4);

    // Adjust by opponent multiplier (subtle adjustment)
    const finalProb = Math.min(1, Math.max(0, blendedProb * Math.pow(opponentMultiplier, 0.3)));

    return finalProb;
}

// Approximate normal CDF using Abramowitz and Stegun approximation
function normalCDF(z) {
    if (z < -6) return 0;
    if (z > 6) return 1;

    const a1 = 0.254829592;
    const a2 = -0.284496736;
    const a3 = 1.421413741;
    const a4 = -1.453152027;
    const a5 = 1.061405429;
    const p = 0.3275911;

    const sign = z < 0 ? -1 : 1;
    z = Math.abs(z);

    const t = 1.0 / (1.0 + p * z);
    const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-z * z / 2);

    return 0.5 * (1.0 + sign * y);
}

// Get upcoming fixtures
function getUpcomingFixtures() {
    const now = new Date();
    const fixtures = [];

    state.matches.forEach(match => {
        // FPL-Elo-Insights uses: kickoff_time, event, home_team, away_team, finished
        const matchDate = new Date(match.kickoff_time || match.datetime || match.date || match.kickoff);
        const isFinished = match.finished === true || match.finished === 'true' || match.finished === 'True' || match.finished === 1 || match.finished === '1';

        // Only include fixtures that are not finished (future or upcoming matches)
        // A fixture is upcoming if it's not finished yet, regardless of kickoff time
        if (!isFinished) {
            fixtures.push({
                id: match.id || match.match_id || match.fixture_id,
                gameweek: parseInt(match.event || match.gameweek || match.gw || 0),
                homeTeam: match.home_team || match.team_h || match.home_team_id || match.team_h_id,
                awayTeam: match.away_team || match.team_a || match.away_team_id || match.team_a_id,
                date: matchDate
            });
        }
    });

    // Sort by date
    fixtures.sort((a, b) => a.date - b.date);

    return fixtures;
}

// Process all player data
function processPlayerData() {
    const opponentMultipliers = calculateOpponentMultipliers();
    const upcomingFixtures = getUpcomingFixtures();
    const processed = [];

    // Group match stats by player
    const playerStats = {};
    state.playerMatchStats.forEach(stat => {
        // FPL-Elo-Insights uses element for player ID
        const playerId = stat.element || stat.player_id || stat.id;
        if (!playerStats[playerId]) {
            playerStats[playerId] = [];
        }
        playerStats[playerId].push(stat);
    });

    // Process each player
    state.players.forEach(player => {
        // FPL-Elo-Insights uses id for player ID
        const playerId = player.id || player.player_id || player.element;
        const position = getPosition(player);
        const teamId = player.team || player.team_id || player.team_code;

        // Skip goalkeepers for DEFCON (they don't contribute same way)
        if (position === 'GKP') return;

        const stats = playerStats[playerId] || [];
        if (stats.length === 0) return;

        // Calculate scores for each match
        const scores = stats.map(s => calculateScore(s, position)).filter(s => !isNaN(s));

        if (scores.length === 0) return;

        // Calculate average score
        const avgScore = scores.reduce((a, b) => a + b, 0) / scores.length;
        const threshold = getThreshold(position);

        // Find next fixture for this player's team
        const nextFixture = upcomingFixtures.find(f =>
            f.homeTeam == teamId || f.awayTeam == teamId
        );

        let opponentId = null;
        let opponentMultiplier = 1;
        let opponentName = 'TBD';
        let isHome = null;
        let fixtureLocation = '';

        if (nextFixture) {
            // Determine if player's team is home or away
            isHome = nextFixture.homeTeam == teamId;
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
                    t.id == opponentId ||
                    t.team_id == opponentId ||
                    t.code == opponentId ||
                    t.team == opponentId
                );
                if (opponentTeam) {
                    opponentName = opponentTeam.short_name || opponentTeam.name?.substring(0, 3).toUpperCase() || 'TBD';
                }
            }
        }

        // Calculate DEFCON probability
        const probability = calculateProbability(scores, threshold, opponentMultiplier);
        const adjustedScore = avgScore * opponentMultiplier;

        // Get team name - check all possible ID fields (id, team_id, code, team)
        const team = state.teams.find(t =>
            t.id == teamId ||
            t.team_id == teamId ||
            t.code == teamId ||
            t.team == teamId
        );
        const teamName = team?.short_name || team?.name?.substring(0, 3).toUpperCase() || 'UNK';

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
            threshold: threshold,
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
        // Use the same ID field priority as player data for consistency
        option.value = team.id || team.team_id || team.code;
        option.textContent = team.name || team.team_name;
        elements.teamFilter.appendChild(option);
    });

    // Gameweek filter
    const gameweeks = [...new Set(state.processedData.map(p => p.nextGameweek))].filter(g => g).sort((a, b) => a - b);

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
