/**
 * Main Module Index
 * Re-exports all modules for convenient importing
 */

// CSV Parser
export { CSVParser } from './csv-parser.js';

// Configuration
export { CONFIG } from './config.js';

// Utilities
export { getVal, roundToTwo, parseExcludedGWs } from './utils.js';

// Data Loading
export {
    fetchCSV,
    fetchCSVOptional,
    updateStatus,
    loadGameweekData,
    loadBaseData,
    loadAllData
} from './data-loader.js';

// DEFCON Logic
export {
    deriveArchetype,
    getPositionGroup,
    checkDefconHit,
    processProbabilities
} from './defcon.js';

// Goals Logic
export {
    processGoalsData,
    calculateCumulativeGoals
} from './goals.js';

// Fixtures Logic
export {
    buildFixturesLookup,
    buildGWList
} from './fixtures.js';

// Color Utilities
export {
    getProbabilityColor,
    getGoalsColor,
    getCombinedColor,
    getColorForValue,
    getTextColor,
    shouldUseWhiteText
} from './colors.js';

// FPL API
export {
    fetchFPL,
    fetchFPLTeam
} from './fpl-api.js';

// Chip Strategy Planning
export {
    calculateFixtureDifficulty,
    analyzeTeamCoverage,
    findWeakCoverage,
    analyzeChipStrategy
} from './chip-planner.js';
