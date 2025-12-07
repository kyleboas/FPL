/**
 * DEFCON Logic Module
 * Functions for calculating DEFCON probabilities and hit detection
 */

import { getVal } from './utils.js';
import { CONFIG } from './config.js';

/**
 * Derive player archetype from player data
 * @param {Object} player - Player object
 * @param {Object} positionOverrides - Map of player_id to position override
 * @returns {string|null} Archetype: 'CB', 'LB', 'RB', 'MID', 'FWD', 'GKP', or null
 */
export const deriveArchetype = (player, positionOverrides = {}) => {
    if (!player) return null;

    // Check position overrides first
    const pid = getVal(player, 'player_id', 'id');
    if (pid != null && positionOverrides[pid]) {
        const override = positionOverrides[pid];
        // LB and RB return as-is, CDM maps to MID
        if (['LB', 'RB'].includes(override)) return override;
        if (override === 'CDM') return 'MID';
        if (override === 'CB') return 'CB';
        if (override === 'MID') return 'MID';
        if (override === 'FWD') return 'FWD';
    }

    // Check detailed position / role
    const specific = player.detailed_position || player.role;
    if (specific) {
        const upperSpecific = specific.toUpperCase();
        if (['CB'].includes(upperSpecific)) return 'CB';
        if (['LB', 'RB', 'LWB', 'RWB'].includes(upperSpecific)) return upperSpecific.replace('WB', 'B');
        if (['CDM', 'CAM', 'RM', 'LM', 'RW', 'LW', 'CM'].includes(upperSpecific)) return 'MID';
        if (['ST', 'CF'].includes(upperSpecific)) return 'FWD';
    }

    // Fall back to general position
    const posRaw = (player.position || '').toString().toLowerCase();

    if (posRaw.startsWith('goal')) return 'GKP';
    if (posRaw.startsWith('def')) return 'CB';   // treat generic defender as CB archetype
    if (posRaw.startsWith('mid')) return 'MID';
    if (posRaw.startsWith('for')) return 'FWD';

    return null;
};

/**
 * Get position group from archetype
 * @param {string} archetype - Player archetype
 * @returns {string|null} Position group: 'GKP', 'DEF', 'MID', 'FWD', or null
 */
export const getPositionGroup = (archetype) => {
    if (archetype === 'GKP') return 'GKP';
    if (['CB', 'LB', 'RB'].includes(archetype)) return 'DEF';
    if (archetype === 'MID') return 'MID';
    if (archetype === 'FWD') return 'FWD';
    return null;
};

/**
 * Check if a player hit DEFCON threshold in a match
 * @param {Object} stats - Player stats for a match
 * @param {string} archetype - Player archetype
 * @returns {boolean} True if DEFCON threshold was reached
 */
export const checkDefconHit = (stats, archetype) => {
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
};

/**
 * Process probabilities for all teams based on historical data
 * @param {Object} params - Processing parameters
 * @param {Array} params.stats - All player stats
 * @param {Array} params.teams - All teams
 * @param {Object} params.playersById - Players lookup by ID
 * @param {Object} params.fixturesByTeam - Fixtures lookup by team code
 * @param {Object} params.teamsById - Teams lookup by ID
 * @param {Object} params.teamsByCode - Teams lookup by code
 * @param {Object} params.positionOverrides - Position overrides lookup
 * @returns {Object} Probabilities by opponent code, venue, and archetype
 */
export const processProbabilities = ({
    stats,
    teams,
    playersById,
    fixturesByTeam,
    teamsById,
    teamsByCode,
    positionOverrides = {}
}) => {
    const opponentAgg = {};
    const initAgg = () => ({ hits: 0, trials: 0 });
    const archetypes = ['CB', 'LB', 'RB', 'MID', 'FWD'];

    stats.forEach(statRecord => {
        const minutes = getVal(statRecord, 'minutes', 'minutes_played', 'minutes_x');
        if ((minutes || 0) <= 0) return;

        const pID = getVal(statRecord, 'player_id', 'element', 'id');
        const player = playersById[pID];
        if (!player) return;

        const archetype = deriveArchetype(player, positionOverrides);
        if (!archetype || archetype === 'GKP') return;

        const gw = getVal(statRecord, 'gw', 'gameweek', 'event', 'round');
        if (!gw) return;

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

    const probabilities = {};

    teams.forEach(team => {
        const teamCode = team.code;
        probabilities[teamCode] = { 'true': {}, 'false': {} };

        ['true', 'false'].forEach(venueKey => {
            archetypes.forEach(arch => {
                let hits = 0;
                let trials = 0;

                if (opponentAgg[teamCode] &&
                    opponentAgg[teamCode][venueKey] &&
                    opponentAgg[teamCode][venueKey][arch]) {
                    hits = opponentAgg[teamCode][venueKey][arch].hits;
                    trials = opponentAgg[teamCode][venueKey][arch].trials;
                }

                const prob = trials > 0 ? (hits / trials) : 0;
                probabilities[teamCode][venueKey][arch] = prob;
            });
        });
    });

    return probabilities;
};
