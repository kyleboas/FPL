// FPL DEFCON Predictor - Main Application
// Data source: https://github.com/Ayanab01/FPL_Stats

const DATA_BASE_URL = 'https://raw.githubusercontent.com/Ayanab01/FPL_Stats/main/data/2025-2026';
const DATA_GW_URL = 'https://raw.githubusercontent.com/Ayanab01/FPL_Stats/main/data/2025-2026/By%20Gameweek';
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

        // Fetch playermatchstats and matches from all gameweeks
        // These files only exist in By Gameweek/GW{x}/ subdirectories
        const [playerMatchStats, matches] = await Promise.all([
            fetchAllGameweekData('playermatchstats.csv'),
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

// Calculate CBIT for a defender match
// CBIT = Clean Sheet Points + Bonus + Interceptions + Tackles (blocked passes proxy)
function calculateCBIT(matchStat) {
    const cleanSheet = parseFloat(matchStat.clean_sheets || matchStat.cleansheet || 0);
    const bonus = parseFloat(matchStat.bonus || 0);
    // Use clearances, blocks, interceptions as defensive stats
    const interceptions = parseFloat(matchStat.clearances_blocks_interceptions || matchStat.interceptions || 0);
    const tackles = parseFloat(matchStat.tackles || 0);

    // Clean sheet gives 4 points for defenders, treat as 4 if they got one
    const csPoints = cleanSheet >= 1 ? 4 : 0;

    return csPoints + bonus + interceptions + tackles;
}

// Calculate CBIRT for mids/forwards
// CBIRT = Clean Sheet Points + Bonus + Interceptions + Recoveries + Tackles
function calculateCBIRT(matchStat, position) {
    const cleanSheet = parseFloat(matchStat.clean_sheets || matchStat.cleansheet || 0);
    const bonus = parseFloat(matchStat.bonus || 0);
    const interceptions = parseFloat(matchStat.clearances_blocks_interceptions || matchStat.interceptions || 0);
    const recoveries = parseFloat(matchStat.recoveries || 0);
    const tackles = parseFloat(matchStat.tackles || 0);

    // Clean sheet gives 1 point for mids, 0 for forwards
    let csPoints = 0;
    if (position === 'MID' && cleanSheet >= 1) {
        csPoints = 1;
    }

    return csPoints + bonus + interceptions + recoveries + tackles;
}

// Get player position from element_type or position field
function getPosition(player) {
    const elementType = parseInt(player.element_type || player.position || 0);
    const posMap = { 1: 'GKP', 2: 'DEF', 3: 'MID', 4: 'FWD' };
    return posMap[elementType] || player.singular_name_short || 'UNK';
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

// Calculate opponent "CBIT allowed" multiplier
// Higher multiplier = opponent allows more defensive returns (easier fixture)
function calculateOpponentMultipliers() {
    const teamStats = {};

    // Initialize team stats
    state.teams.forEach(team => {
        const teamId = team.id || team.team_id;
        teamStats[teamId] = {
            name: team.name || team.team_name,
            shortName: team.short_name || team.name?.substring(0, 3).toUpperCase(),
            totalAllowed: 0,
            matchCount: 0
        };
    });

    // Calculate what each team allows to opponents
    state.playerMatchStats.forEach(stat => {
        const opponentId = stat.opponent_team || stat.opponent_id;
        if (opponentId && teamStats[opponentId]) {
            // Get player position
            const player = state.players.find(p =>
                (p.id || p.player_id) === (stat.element || stat.player_id)
            );
            if (player) {
                const position = getPosition(player);
                const score = calculateScore(stat, position);
                teamStats[opponentId].totalAllowed += score;
                teamStats[opponentId].matchCount++;
            }
        }
    });

    // Calculate averages and league average
    let leagueTotal = 0;
    let leagueCount = 0;

    Object.values(teamStats).forEach(team => {
        if (team.matchCount > 0) {
            team.avgAllowed = team.totalAllowed / team.matchCount;
            leagueTotal += team.avgAllowed;
            leagueCount++;
        } else {
            team.avgAllowed = 0;
        }
    });

    const leagueAvg = leagueCount > 0 ? leagueTotal / leagueCount : 1;

    // Calculate multiplier (ratio vs league average)
    Object.values(teamStats).forEach(team => {
        team.multiplier = leagueAvg > 0 ? team.avgAllowed / leagueAvg : 1;
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
        const matchDate = new Date(match.kickoff_time || match.datetime || match.date);
        if (matchDate > now || !match.finished) {
            fixtures.push({
                id: match.id || match.match_id,
                gameweek: parseInt(match.event || match.gameweek || 0),
                homeTeam: match.team_h || match.home_team_id,
                awayTeam: match.team_a || match.away_team_id,
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
        const playerId = stat.element || stat.player_id;
        if (!playerStats[playerId]) {
            playerStats[playerId] = [];
        }
        playerStats[playerId].push(stat);
    });

    // Process each player
    state.players.forEach(player => {
        const playerId = player.id || player.player_id;
        const position = getPosition(player);
        const teamId = player.team || player.team_id;

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

        if (nextFixture) {
            opponentId = nextFixture.homeTeam == teamId ? nextFixture.awayTeam : nextFixture.homeTeam;
            if (opponentMultipliers[opponentId]) {
                opponentMultiplier = opponentMultipliers[opponentId].multiplier || 1;
                opponentName = opponentMultipliers[opponentId].shortName ||
                              opponentMultipliers[opponentId].name || 'UNK';
            }
        }

        // Calculate DEFCON probability
        const probability = calculateProbability(scores, threshold, opponentMultiplier);
        const adjustedScore = avgScore * opponentMultiplier;

        // Get team name
        const team = state.teams.find(t => (t.id || t.team_id) == teamId);
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
            nextGameweek: nextFixture?.gameweek || null
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

        return `
            <tr>
                <td><strong>${escapeHtml(player.webName)}</strong></td>
                <td>${escapeHtml(player.team)}</td>
                <td><span class="pos-badge pos-${player.position}">${player.position}</span></td>
                <td>${player.avgScore.toFixed(1)}</td>
                <td>${player.matchCount}</td>
                <td>${escapeHtml(player.opponent)}</td>
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
        option.value = team.id || team.team_id;
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
