/**
 * FPL Goals Statistics
 * Team-level goals analysis using ES6 modules
 */

import {
    CONFIG,
    getVal,
    roundToTwo,
    parseExcludedGWs,
    loadAllData,
    buildFixturesLookup,
    buildGWList,
    processGoalsData,
    calculateCumulativeGoals,
    getGoalsColor
} from './modules/index.js';

// Application State
const STATE = {
    data: {
        players: [],
        teams: [],
        stats: [],
        fixtures: [],
        positionOverrides: []
    },
    lookups: {
        playersById: {},
        teamsById: {},
        teamsByCode: {},
        fixturesByTeam: {},
        positionOverrides: {},
        teamGoals: {},
        positionGoalsRaw: {}  // teamCode -> gw -> { ALL:{for,against}, DEF:{...}, MID:{...}, FWD:{...} }
    },
    ui: {
        statType: 'for',
        venueFilter: 'homeaway',
        formFilter: 8,
        startGW: 1,
        endGW: 6,
        excludedGWs: [],
        sortMode: {
            type: 'avg',      // now using Highest Average as default
            direction: 'desc',
            gw: null
        },
        positionFilter: 'ALL',  // 'ALL' | 'DEF' | 'MID' | 'FWD'
        highlightMode: false,    // NEW: jump-on opacity toggle
        highlightPercent: 50     // NEW: % above best (default 50%)
    },
    latestGW: 0
};

// ==========================================
// HELPER FUNCTIONS
// ==========================================

// Map player object to a simple position key: 'GK' | 'DEF' | 'MID' | 'FWD'
function getPlayerPositionKey(player) {
    if (!player) return 'UNK';

    // common FPL / custom fields
    const rawPos = getVal(player, 'actual_position', 'position', 'pos', 'element_type', 'position_short', 'primary_position');
    if (typeof rawPos === 'number') {
        // FPL convention: 1=GK,2=DEF,3=MID,4=FWD
        if (rawPos === 1) return 'GK';
        if (rawPos === 2) return 'DEF';
        if (rawPos === 3) return 'MID';
        if (rawPos === 4) return 'FWD';
    } else if (typeof rawPos === 'string') {
        const p = rawPos.trim().toUpperCase();
        if (p.startsWith('G')) return 'GK';
        if (p.startsWith('D')) return 'DEF';
        if (p.startsWith('M')) return 'MID';
        if (p.startsWith('F')) return 'FWD';
    }

    return 'UNK';
}

// ==========================================
// GOAL SCORERS HELPERS
// ==========================================

// From GW stats CSV: "..., gw, ..."
function getGWValue(statRow) {
    return Number(getVal(statRow, 'gw'));
}

// From GW stats CSV: first column is "id"
function getPlayerId(statRow) {
    return Number(getVal(statRow, 'id'));
}

// From GW stats CSV: "team" and "team_id" are numeric team IDs
function getTeamId(statRow) {
    return Number(getVal(statRow, 'team', 'team_id'));
}

// From GW stats CSV: "opponent_team" or "opp_team"
function getOppTeamId(statRow) {
    return Number(getVal(statRow, 'opponent_team', 'opp_team'));
}

// From GW stats CSV: "goals_scored"
function getGoals(statRow) {
    const raw = getVal(statRow, 'goals_scored');
    const n = Number(raw);
    return Number.isNaN(n) ? 0 : n;
}

// Return list of scorers for that fixture (both teams)
function getScorersForFixture(teamCode, opponentCode, gw) {
    // Try to find team by code first, then by id (code might be numeric id)
    let team = STATE.data.teams.find(t => t.code === teamCode);
    if (!team) {
        team = STATE.data.teams.find(t => getVal(t, 'id', 'team_id') === teamCode);
    }

    let opp = STATE.data.teams.find(t => t.code === opponentCode);
    if (!opp) {
        opp = STATE.data.teams.find(t => getVal(t, 'id', 'team_id') === opponentCode);
    }

    if (!team || !opp) return [];

    // Extract team IDs using getVal with fallbacks, ensure numeric
    const teamId = Number(getVal(team, 'id', 'team_id', 'code'));
    const oppId  = Number(getVal(opp, 'id', 'team_id', 'code'));

    const gwStats = STATE.data.stats.filter(row => {
        const rowGW   = getGWValue(row);
        const rowTeam = getTeamId(row);
        const rowOpp  = getOppTeamId(row);

        return rowGW === gw &&
            (
                (rowTeam === teamId && rowOpp === oppId) ||
                (rowTeam === oppId  && rowOpp === teamId)
            );
    });

    const scorers = [];

    gwStats.forEach(row => {
        const goals = getGoals(row);
        if (!goals || goals <= 0) return;

        const playerId = getPlayerId(row);
        const player = STATE.lookups.playersById[playerId];

        const firstName  = player ? getVal(player, 'first_name')  : '';
        const secondName = player ? getVal(player, 'second_name') : '';
        const webName    = player ? getVal(player, 'web_name')    : '';

        const name =
            webName ||
            `${firstName} ${secondName}`.trim() ||
            `Player ${playerId}`;

        const rowTeamId = getTeamId(row);
        const isHomeTeam = rowTeamId === teamId;
        const teamLabel = isHomeTeam
            ? (team.short_name || team.name)
            : (opp.short_name  || opp.name);

        scorers.push({
            name,
            goals,
            teamLabel
        });
    });

    // Combine duplicates: same player multiple goals
    const merged = {};
    scorers.forEach(s => {
        const key = `${s.teamLabel}::${s.name}`;
        if (!merged[key]) {
            merged[key] = { ...s };
        } else {
            merged[key].goals += s.goals;
        }
    });

    return Object.values(merged)
        .sort((a, b) => b.goals - a.goals || a.teamLabel.localeCompare(b.teamLabel));
}

// Return list of historical scorers against a specific opponent (for future fixtures)
// Filters by position if positionFilter is set
function getHistoricalScorersVsOpponent(teamCode, opponentCode, positionFilter = 'ALL') {
    // Find opponent team
    let opp = STATE.data.teams.find(t => t.code === opponentCode);
    if (!opp) {
        opp = STATE.data.teams.find(t => getVal(t, 'id', 'team_id') === opponentCode);
    }
    if (!opp) return [];

    const oppId = Number(getVal(opp, 'id', 'team_id', 'code'));

    // Find all stats where the opponent was the opposition
    const historicalStats = STATE.data.stats.filter(row => {
        const rowOpp = getOppTeamId(row);
        return rowOpp === oppId;
    });

    const scorers = [];

    historicalStats.forEach(row => {
        const goals = getGoals(row);
        if (!goals || goals <= 0) return;

        const playerId = getPlayerId(row);
        const player = STATE.lookups.playersById[playerId];
        if (!player) return;

        // Apply position filter
        if (positionFilter && positionFilter !== 'ALL') {
            const playerPos = getPlayerPositionKey(player);
            if (playerPos !== positionFilter) return;
        }

        const firstName  = getVal(player, 'first_name')  || '';
        const secondName = getVal(player, 'second_name') || '';
        const webName    = getVal(player, 'web_name')    || '';

        const name =
            webName ||
            `${firstName} ${secondName}`.trim() ||
            `Player ${playerId}`;

        // Get player's team name
        const playerTeamCode = getVal(player, 'team_code', 'teamCode', 'team');
        let playerTeam = STATE.data.teams.find(t => t.code === playerTeamCode);
        if (!playerTeam) {
            playerTeam = STATE.data.teams.find(t => getVal(t, 'id', 'team_id') === playerTeamCode);
        }
        const teamLabel = playerTeam ? (playerTeam.short_name || playerTeam.name) : 'Unknown';

        const gw = getGWValue(row);

        scorers.push({
            name,
            goals,
            teamLabel,
            gw
        });
    });

    // Combine duplicates: same player, aggregate goals across all matches
    const merged = {};
    scorers.forEach(s => {
        const key = `${s.teamLabel}::${s.name}`;
        if (!merged[key]) {
            merged[key] = { name: s.name, goals: s.goals, teamLabel: s.teamLabel, matches: 1 };
        } else {
            merged[key].goals += s.goals;
            merged[key].matches += 1;
        }
    });

    return Object.values(merged)
        .sort((a, b) => b.goals - a.goals || a.name.localeCompare(b.name));
}

// Classify fixture quality into simple ratings
function classifyFixture(value, statType) {
    if (value == null) return 'blank';

    if (statType === 'against') {
        // Higher = better for attackers
        if (value >= 2.0) return 'great';
        if (value >= 1.4) return 'good';
        if (value >= 1.0) return 'ok';
        return 'bad';
    } else { // 'for' – lower is better for defenders
        if (value <= 0.6) return 'great';
        if (value <= 0.9) return 'good';
        if (value <= 1.3) return 'ok';
        return 'bad';
    }
}

// Compute a dynamic threshold based on a % above/below the best value
function computeDynamicHighlightThreshold(values, statType, percent = 0.5) {
    const filtered = values.filter(v => v != null && !Number.isNaN(v));
    if (!filtered.length) return { base: null, threshold: null };

    filtered.sort((a, b) => a - b);

    if (statType === 'for') {
        // DEFENSE view → best = lowest
        let best = filtered[0];

        if (best === 0) {
            const nz = filtered.find(v => v > 0);
            best = nz != null ? nz : 1;
        }

        let threshold = best * (1 + percent);

        // --- NEW: enforce minimum defense threshold ---
        const DEFENSE_MIN_THRESHOLD = 0.95;
        threshold = Math.max(threshold, DEFENSE_MIN_THRESHOLD);

        return { base: best, threshold };
    } else {
        // ATTACK view → best = highest
        let best = filtered[filtered.length - 1];

        const threshold = best * (1 - percent);
        return { base: best, threshold };
    }
}

function shouldHighlightCellDynamic(value, statType, threshold) {
    if (value == null || threshold == null) return false;

    if (statType === 'for') {
        // DEFENSE: lower is better → highlight <= threshold
        return value <= threshold;
    } else {
        // ATTACK: higher is better → highlight >= threshold
        return value >= threshold;
    }
}

// Find runs of good fixtures (consecutive 'great' or 'good' ratings)
function findGoodRuns(fixtures, minLen = 3) {
    const runs = [];
    let start = null;
    let length = 0;

    fixtures.forEach((cell, idx) => {
        const isGood = cell.rating === 'great' || cell.rating === 'good';

        if (isGood) {
            if (start === null) start = idx;
            length++;
        } else {
            if (start !== null && length >= minLen) {
                runs.push({ startIdx: start, endIdx: start + length - 1 });
            }
            start = null;
            length = 0;
        }
    });

    // handle run that extends to last GW
    if (start !== null && length >= minLen) {
        runs.push({ startIdx: start, endIdx: start + length - 1 });
    }

    return runs;
}

// ==========================================
// DATA PROCESSING
// ==========================================

function processData() {
    STATE.lookups.playersById = {};
    STATE.data.players.forEach(p => {
        const pid = getVal(p, 'player_id', 'id');
        if (pid != null) {
            STATE.lookups.playersById[pid] = p;
        }
    });

    // Build position overrides lookup (for consistency with app.js)
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

    STATE.lookups.fixturesByTeam = buildFixturesLookup({
        fixtures: STATE.data.fixtures,
        teams: STATE.data.teams
    });

    const goalsResult = processGoalsData({
        fixtures: STATE.data.fixtures,
        teams: STATE.data.teams,
        fixturesByTeam: STATE.lookups.fixturesByTeam,
        stats: STATE.data.stats,
        playersById: STATE.lookups.playersById,
        teamsById: STATE.lookups.teamsById,
        positionOverrides: STATE.lookups.positionOverrides
    });

    STATE.lookups.teamGoals = goalsResult.teamGoals;
    STATE.lookups.positionGoalsRaw = goalsResult.positionGoalsRaw;
    STATE.latestGW = goalsResult.latestGW;

    const debugEl = document.getElementById('status-bar');
    if (debugEl) {
        debugEl.textContent =
            `Data Ready: ${STATE.data.teams.length} Teams, ` +
            `${STATE.data.fixtures.length} Fixtures processed.`;
    }
}

// ==========================================
// SCORERS PANEL
// ==========================================

function showScorersPanel(row, cell, scorers, options = {}) {
    const panel  = document.getElementById('goal-detail-panel');
    const titleEl = document.getElementById('goal-detail-title');
    const bodyEl  = document.getElementById('goal-detail-body');

    const team = STATE.data.teams.find(t => t.code === row.teamCode);
    const opp  = STATE.data.teams.find(t => t.code === cell.opponentCode);

    const teamName = team ? (team.short_name || team.name) : row.teamName;
    const oppName  = opp  ? (opp.short_name  || opp.name)  : cell.opponent;

    const homeSide = cell.venue === '(H)' ? teamName : oppName;
    const awaySide = cell.venue === '(H)' ? oppName  : teamName;

    // Build title based on whether it's historical or match data
    if (options.isHistorical) {
        const posLabel = options.positionFilter && options.positionFilter !== 'ALL'
            ? ` (${options.positionFilter})`
            : '';
        titleEl.textContent = `GW ${cell.gw} – ${homeSide} vs ${awaySide}`;
        titleEl.innerHTML = `GW ${cell.gw} – ${homeSide} vs ${awaySide}<br><small style="font-weight:normal;color:#666;">Historical scorers vs ${oppName}${posLabel}</small>`;
    } else {
        titleEl.textContent = `GW ${cell.gw} – ${homeSide} vs ${awaySide}`;
    }

    if (!scorers.length) {
        if (options.isHistorical) {
            const posLabel = options.positionFilter && options.positionFilter !== 'ALL'
                ? ` ${options.positionFilter.toLowerCase()}s`
                : '';
            bodyEl.innerHTML = `<p>No${posLabel} have scored against ${oppName} this season.</p>`;
        } else if (options.isFuture) {
            bodyEl.innerHTML = `<p>Match not yet played.</p>`;
        } else {
            bodyEl.innerHTML = `<p>No goals scored in this match (0-0).</p>`;
        }
    } else if (options.isHistorical) {
        // Historical data: show matches count
        const rowsHtml = scorers.map(s => `
            <tr>
                <td>${s.teamLabel}</td>
                <td>${s.name}</td>
                <td style="text-align:right;">${s.goals}</td>
                <td style="text-align:right;color:#666;">${s.matches}</td>
            </tr>
        `).join('');

        bodyEl.innerHTML = `
            <table style="border-collapse: collapse; width: 100%; max-width: 520px;">
                <thead>
                    <tr>
                        <th style="text-align:left; padding: 4px 0;">Team</th>
                        <th style="text-align:left; padding: 4px 0;">Player</th>
                        <th style="text-align:right; padding: 4px 0;">Goals</th>
                        <th style="text-align:right; padding: 4px 0;">Matches</th>
                    </tr>
                </thead>
                <tbody>
                    ${rowsHtml}
                </tbody>
            </table>
        `;
    } else {
        // Regular match data
        const rowsHtml = scorers.map(s => `
            <tr>
                <td>${s.teamLabel}</td>
                <td>${s.name}</td>
                <td style="text-align:right;">${s.goals}</td>
            </tr>
        `).join('');

        bodyEl.innerHTML = `
            <table style="border-collapse: collapse; width: 100%; max-width: 480px;">
                <thead>
                    <tr>
                        <th style="text-align:left; padding: 4px 0;">Team</th>
                        <th style="text-align:left; padding: 4px 0;">Player</th>
                        <th style="text-align:right; padding: 4px 0;">Goals</th>
                    </tr>
                </thead>
                <tbody>
                    ${rowsHtml}
                </tbody>
            </table>
        `;
    }

    panel.style.display = 'block';
}

function handleCellClick(row, cell) {
    const positionFilter = STATE.ui.positionFilter;

    // FUTURE fixtures → show historical scorers against this opponent
    if (cell.type === 'FUTURE') {
        const historicalScorers = getHistoricalScorersVsOpponent(
            cell.teamCode,
            cell.opponentCode,
            positionFilter
        );
        showScorersPanel(row, cell, historicalScorers, {
            isFuture: true,
            isHistorical: true,
            positionFilter
        });
        return;
    }

    const scorers = getScorersForFixture(cell.teamCode, cell.opponentCode, cell.gw);
    showScorersPanel(row, cell, scorers, { isFuture: false, positionFilter });
}

// ==========================================
// RENDERING
// ==========================================

function handleGwHeaderClick(gw) {
    const mode = STATE.ui.sortMode;
    if (mode.type === 'column' && mode.gw === gw) {
        mode.direction = mode.direction === 'desc' ? 'asc' : 'desc';
    } else {
        mode.type = 'column';
        mode.gw = gw;
        mode.direction = STATE.ui.statType === 'for' ? 'asc' : 'desc';
    }
    renderTable();
}

function updateFormFilterDisplay(value) {
    const displayEl = document.getElementById('form-filter-value');
    if (!displayEl) return;

    if (value === 0) {
        displayEl.textContent = 'All Time';
    } else {
        displayEl.textContent = `Last ${value} GW${value > 1 ? 's' : ''}`;
    }
}

function renderTable() {
    const { statType, venueFilter, sortMode, formFilter, positionFilter } = STATE.ui;
    const startGW = parseInt(STATE.ui.startGW, 10);
    const endGW = parseInt(STATE.ui.endGW, 10);

    const gwList = buildGWList(startGW, endGW, STATE.ui.excludedGWs);

    const { teams } = STATE.data;
    const { fixturesByTeam, teamsByCode } = STATE.lookups;

    // Calculate cumulative goals
    const cumulativeGoalsByTeam = calculateCumulativeGoals({
        teams,
        fixturesByTeam,
        latestGW: STATE.latestGW,
        formFilter,
        maxGW: CONFIG.UI.MAX_GW,
        positionFilter,
        positionGoalsRaw: STATE.lookups.positionGoalsRaw
    });

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

    const allValues = [];

    let rowData = teams.map(team => {
        const teamCode = team.code;
        const fixtures = [];
        const gwValueMap = {};
        let metrics = [];

        gwList.forEach(gw => {
            const fix = fixturesByTeam[teamCode] ? fixturesByTeam[teamCode][gw] : null;

            if (!fix) {
                fixtures.push({ type: 'BLANK', cumulativeValue: null, rating: 'blank' });
                gwValueMap[gw] = null;
                return;
            }

            const opponentCode = fix.opponentCode;
            const isHome = fix.wasHome;
            const oppTeam = teamsByCode[opponentCode];
            const oppName = oppTeam ? oppTeam.short_name : 'UNK';

            let oppVenue = 'combined';
            if (venueFilter === 'homeaway') {
                oppVenue = isHome ? 'away' : 'home';
            }

            const oppCumulative = cumulativeGoalsByTeam[opponentCode]
                ? cumulativeGoalsByTeam[opponentCode][oppVenue][gw]
                : null;

            if (!oppCumulative) {
                fixtures.push({ type: 'BLANK', cumulativeValue: null, rating: 'blank' });
                gwValueMap[gw] = null;
                return;
            }

            const oppCumulativeValue = statType === 'for'
                ? oppCumulative.for
                : oppCumulative.against;

            const value = oppCumulativeValue;
            const rating = classifyFixture(value, statType);

            if (value != null) {
                allValues.push(value);
            }

            fixtures.push({
                type: fix.finished ? 'MATCH' : 'FUTURE',
                opponent: oppName,
                opponentCode,
                teamCode,
                gw,
                venue: isHome ? '(H)' : '(A)',
                value: value,
                isFinished: fix.finished,
                rating: rating,
                highlight: false   // set later after we know the threshold
            });
            metrics.push(value);
            gwValueMap[gw] = value;
        });

        const validMetrics = metrics.filter(m => m !== null);
        const maxVal = validMetrics.length ? Math.max(...validMetrics) : 0;
        const avgVal = validMetrics.length ? roundToTwo(validMetrics.reduce((a, b) => a + b, 0) / validMetrics.length) : 0;
        const totalVal = roundToTwo(validMetrics.reduce((a, b) => a + b, 0));

        // Get team's own goals for/against (use latest GW available or last GW in range)
        // This shows the team's own performance metric
        let teamGoalsValue = null;
        const lastGwInRange = gwList[gwList.length - 1];
        const teamCumulative = cumulativeGoalsByTeam[teamCode]
            ? cumulativeGoalsByTeam[teamCode]['combined'][lastGwInRange]
            : null;
        if (teamCumulative) {
            // statType 'for' (defense view) -> show team's goals against
            // statType 'against' (attack view) -> show team's goals for
            teamGoalsValue = statType === 'for'
                ? teamCumulative.against
                : teamCumulative.for;
        }

        return {
            teamName: team.short_name || team.name,
            teamCode,
            fixtures,
            gwValueMap,
            maxVal,
            avgVal,
            totalVal,
            teamGoalsValue
        };
    });

    // Dynamic highlight threshold based on UI setting (percent)
    const percent = (STATE.ui.highlightPercent ?? 50) / 100;

    const { base: highlightBase, threshold: highlightThreshold } =
        computeDynamicHighlightThreshold(allValues, statType, percent);

    // Apply highlight flags based on the dynamic threshold
    rowData.forEach(row => {
        row.fixtures.forEach(cell => {
            if (cell.type === 'MATCH' || cell.type === 'FUTURE') {
                cell.highlight = shouldHighlightCellDynamic(
                    cell.value,
                    statType,
                    highlightThreshold,
                    highlightBase
                );
            }
        });
    });

    // Detect good fixture runs and mark cells
    rowData.forEach(row => {
        row.runs = findGoodRuns(row.fixtures, 3);

        // Mark which cells belong to a run
        row.fixtures.forEach((cell, idx) => {
            cell.isInRun = row.runs.some(run => idx >= run.startIdx && idx <= run.endIdx);
        });
    });

    // Sorting
    const sortMultiplier = statType === 'for' ? 1 : -1;

    if (sortMode.type === 'max') {
        rowData.sort((a, b) => sortMultiplier * (a.maxVal - b.maxVal));
    } else if (sortMode.type === 'avg') {
        rowData.sort((a, b) => sortMultiplier * (a.avgVal - b.avgVal));
    } else if (sortMode.type === 'total') {
        rowData.sort((a, b) => sortMultiplier * (a.totalVal - b.totalVal));
    } else if (sortMode.type === 'column' && sortMode.gw != null) {
        const dir = sortMode.direction === 'asc' ? 1 : -1;
        const gw = sortMode.gw;
        rowData.sort((a, b) => {
            const va = a.gwValueMap[gw] ?? -1;
            const vb = b.gwValueMap[gw] ?? -1;
            return dir * (va - vb);
        });
    }

    // Calculate global max for color scaling
    let globalMaxValue = 0;
    rowData.forEach(row => {
        row.fixtures.forEach(cell => {
            if ((cell.type === 'MATCH' || cell.type === 'FUTURE') && cell.value != null) {
                globalMaxValue = Math.max(globalMaxValue, cell.value);
            }
        });
    });

    // Calculate max team goals value for column 1 color scaling
    let maxTeamGoalsValue = 0;
    rowData.forEach(row => {
        if (row.teamGoalsValue != null) {
            maxTeamGoalsValue = Math.max(maxTeamGoalsValue, row.teamGoalsValue);
        }
    });

    tbody.innerHTML = '';
    rowData.forEach(row => {
        const tr = document.createElement('tr');

        const tdName = document.createElement('td');
        tdName.style.fontWeight = '600';

        // Create wrapper for team name and goals value
        const nameWrapper = document.createElement('div');
        nameWrapper.className = 'team-cell';

        const divName = document.createElement('div');
        divName.className = 'team-name';
        divName.textContent = row.teamName;

        const divGoals = document.createElement('div');
        divGoals.className = 'team-goals';
        divGoals.style.fontSize = '0.85em';
        divGoals.textContent = row.teamGoalsValue != null ? roundToTwo(row.teamGoalsValue) : '-';

        // Color the cell background based on team goals value
        if (row.teamGoalsValue != null) {
            tdName.style.backgroundColor = getGoalsColor(row.teamGoalsValue, statType, maxTeamGoalsValue);
            // Adjust text color for readability
            if (row.teamGoalsValue <= 0.8) {
                divName.style.color = '#000';
                divGoals.style.color = '#000';
            } else {
                divName.style.color = '#fff';
                divGoals.style.color = 'rgba(255,255,255,0.8)';
            }
        } else {
            divGoals.style.color = '#666';
        }

        nameWrapper.appendChild(divName);
        nameWrapper.appendChild(divGoals);
        tdName.appendChild(nameWrapper);
        tr.appendChild(tdName);

        row.fixtures.forEach(cell => {
            const td = document.createElement('td');

            if (cell.type === 'BLANK' || cell.type === 'FILTERED') {
                td.textContent = '-';
                td.style.backgroundColor = '#e2e8f0'; // soft slate gray
                td.style.color = '#94a3b8';          // muted text
            } else if (cell.type === 'MATCH' || cell.type === 'FUTURE') {
                const wrapper = document.createElement('div');
                wrapper.className = 'match-cell';

                const divOpp = document.createElement('div');
                divOpp.className = 'match-opp';
                divOpp.textContent = `${cell.opponent} ${cell.venue}`;

                const divValue = document.createElement('div');
                divValue.className = 'match-value';
                divValue.textContent = roundToTwo(cell.value);

                wrapper.appendChild(divOpp);
                wrapper.appendChild(divValue);
                td.appendChild(wrapper);

                td.style.backgroundColor = getGoalsColor(cell.value, statType, globalMaxValue);

                // Adjust text color for readability
                if (cell.value <= 0.8) {
                    divOpp.style.color = '#000';
                    divValue.style.color = '#000';
                } else {
                    divOpp.style.color = '#fff';
                    divValue.style.color = '#fff';
                }

                // Style future fixtures slightly differently
                if (cell.type === 'FUTURE') {
                    td.style.fontStyle = 'italic';
                }

                // NEW: opacity based on Jump On View toggle
                if (STATE.ui.highlightMode) {
                    if (cell.highlight) {
                        td.style.opacity = '1';
                    } else {
                        td.style.opacity = '0.15';  // fade non-highlighted cells
                    }
                } else {
                    td.style.opacity = '1';
                }

                // >>> NEW: click to show who scored <<<
                td.style.cursor = 'pointer';
                td.addEventListener('click', () => {
                    handleCellClick(row, cell);
                });
            }
            tr.appendChild(td);
        });

        tbody.appendChild(tr);
    });
}

// ==========================================
// DEFAULT GW WINDOW
// ==========================================

function applyDefaultGWWindow() {
    const startInput = document.getElementById('gw-start');
    const endInput = document.getElementById('gw-end');
    const excludeInput = document.getElementById('gw-exclude');

    // Default window: first unplayed GW (latest completed + 1) to 5 GWs after
    const nextUnplayedGW = Math.min((STATE.latestGW || 0) + 1, CONFIG.UI.MAX_GW);
    const defaultEndGW   = Math.min(nextUnplayedGW + 5, CONFIG.UI.MAX_GW);

    STATE.ui.startGW = nextUnplayedGW;
    STATE.ui.endGW   = defaultEndGW;
    STATE.ui.excludedGWs = parseExcludedGWs(excludeInput.value);

    // Reflect defaults in the inputs
    startInput.value = String(nextUnplayedGW);
    endInput.value   = String(defaultEndGW);
}

// ==========================================
// EVENT LISTENERS
// ==========================================

function setupEventListeners() {
    // Stat type toggle (Goals For / Goals Against)
    const statToggle = document.getElementById('stat-type-toggle');
    statToggle.querySelectorAll('.toggle-option').forEach(option => {
        option.addEventListener('click', (e) => {
            const value = e.currentTarget.dataset.value; // 'for' or 'against'
            STATE.ui.statType = value;

            // Update active state
            statToggle.querySelectorAll('.toggle-option').forEach(opt => {
                opt.classList.remove('active');
            });
            e.currentTarget.classList.add('active');

            // Reset sort defaults when switching stat type
            STATE.ui.sortMode.type = 'avg';
            STATE.ui.sortMode.gw = null;
            STATE.ui.sortMode.direction = value === 'for' ? 'asc' : 'desc';

            renderTable();
        });
    });

    const venueToggle = document.getElementById('venue-toggle');
    venueToggle.querySelectorAll('.toggle-option').forEach(option => {
        option.addEventListener('click', (e) => {
            const value = e.target.dataset.value;
            STATE.ui.venueFilter = value;

            // Update active state
            venueToggle.querySelectorAll('.toggle-option').forEach(opt => {
                opt.classList.remove('active');
            });
            e.target.classList.add('active');

            renderTable();
        });
    });

    // Position toggle (All / DEF / MID / FWD)
    const positionToggle = document.getElementById('position-toggle');
    if (positionToggle) {
        positionToggle.querySelectorAll('.toggle-option').forEach(option => {
            option.addEventListener('click', (e) => {
                const value = e.target.dataset.value; // 'ALL', 'DEF', 'MID', 'FWD'
                STATE.ui.positionFilter = value || 'ALL';

                positionToggle.querySelectorAll('.toggle-option').forEach(opt => {
                    opt.classList.remove('active');
                });
                e.target.classList.add('active');

                renderTable();
            });
        });
    }

    const formFilterSlider = document.getElementById('form-filter');

    // Ensure slider + label match default state (8)
    formFilterSlider.value = STATE.ui.formFilter; // STATE.ui.formFilter is 8 from the STATE object
    updateFormFilterDisplay(STATE.ui.formFilter);

    formFilterSlider.addEventListener('input', (e) => {
        const value = parseInt(e.target.value, 10);
        STATE.ui.formFilter = value;
        updateFormFilterDisplay(value);
        renderTable();
    });

    const startInput = document.getElementById('gw-start');
    const endInput = document.getElementById('gw-end');
    const excludeInput = document.getElementById('gw-exclude');

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
        if (!isNaN(val) && val >= 1 && val <= CONFIG.UI.MAX_GW) {
            STATE.ui.endGW = val;
            renderTable();
        }
    });

    endInput.addEventListener('blur', (e) => {
        let val = parseInt(e.target.value, 10);
        if (isNaN(val)) val = CONFIG.UI.MAX_GW;
        if (val < 1) val = 1;
        if (val > CONFIG.UI.MAX_GW) val = CONFIG.UI.MAX_GW;

        if (val < STATE.ui.startGW) {
            val = STATE.ui.startGW;
        }

        e.target.value = String(val);
        STATE.ui.endGW = val;
        renderTable();
    });

    excludeInput.addEventListener('input', (e) => {
        STATE.ui.excludedGWs = parseExcludedGWs(e.target.value, CONFIG.UI.MAX_GW);
        renderTable();
    });

    document.getElementById('sort-by').addEventListener('change', (e) => {
        const val = e.target.value;
        STATE.ui.sortMode.type = val;
        STATE.ui.sortMode.gw = null;
        STATE.ui.sortMode.direction = 'desc';
        renderTable();
    });

    // Jump On View toggle
    const highlightToggle = document.getElementById('highlight-toggle');
    if (highlightToggle) {
        highlightToggle.querySelectorAll('.toggle-option').forEach(option => {
            option.addEventListener('click', (e) => {
                const value = e.currentTarget.dataset.value; // 'on' or 'off'
                STATE.ui.highlightMode = (value === 'on');

                highlightToggle.querySelectorAll('.toggle-option').forEach(opt => {
                    opt.classList.remove('active');
                });
                e.currentTarget.classList.add('active');

                renderTable();
            });
        });
    }

    // Highlight % input
    const highlightPercentInput = document.getElementById('highlight-percent');
    if (highlightPercentInput) {
        // sync default from state
        highlightPercentInput.value = STATE.ui.highlightPercent;

        highlightPercentInput.addEventListener('input', (e) => {
            let val = parseFloat(e.target.value);
            if (isNaN(val)) val = 50;
            if (val < 0) val = 0;
            if (val > 200) val = 200; // cap at 200% if you want
            STATE.ui.highlightPercent = val;
            renderTable();
        });
    }
}

// ==========================================
// INITIALIZATION
// ==========================================

async function init() {
    const loadingEl = document.getElementById('loading');
    const mainEl = document.getElementById('main-content');
    const errorEl = document.getElementById('error');

    try {
        const rawData = await loadAllData(true);
        STATE.data = rawData;
        processData();

        window.STATE = STATE;

        loadingEl.style.display = 'none';
        mainEl.style.display = 'block';

        applyDefaultGWWindow();
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
