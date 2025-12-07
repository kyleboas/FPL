/**
 * Color Utilities Module
 * Functions for generating colors based on probability/value
 */

/**
 * Get color for DEFCON probability
 * @param {number} prob - Probability value (0-1)
 * @param {string} archetype - Player archetype
 * @returns {string} RGB color string
 */
export const getProbabilityColor = (prob, archetype) => {
    // Looser / lower thresholds for mids
    let start = 0.2;
    let span = 0.6;

    if (archetype === 'MID') {
        start = 0.10;   // start "heating up" earlier
        span = 0.40;    // saturate by ~50%
    }

    const intensity = Math.min(1, Math.max(0, (prob - start) / span));
    const g = Math.floor(255 * (1 - intensity));
    const b = Math.floor(255 * (1 - intensity));
    return `rgb(255, ${g}, ${b})`;
};

/**
 * Get color for goals value
 * @param {number} value - Goals value
 * @param {string} statType - 'for' or 'against'
 * @param {number} maxValue - Maximum value for scaling
 * @returns {string} RGB color string
 */
export const getGoalsColor = (value, statType, maxValue) => {
    // Use at least 1 to avoid division by zero
    const scale = Math.max(1, maxValue);

    // Both goals for and against use the same red gradient
    const intensity = Math.min(1, value / scale);
    const g = Math.floor(255 * (1 - intensity));
    const b = Math.floor(255 * (1 - intensity));
    return `rgb(255, ${g}, ${b})`;
};

/**
 * Get combined color for DEFCON + goals
 * @param {number} defconProb - DEFCON probability (0-1)
 * @param {number} goalsValue - Goals value
 * @param {number} maxGoals - Maximum goals value for scaling
 * @returns {string} RGB color string
 */
export const getCombinedColor = (defconProb, goalsValue, maxGoals) => {
    // Create a gradient based on both values
    // Normalize both to 0-1 range
    const defconNorm = Math.min(1, Math.max(0, defconProb));
    const goalsNorm = Math.min(1, Math.max(0, goalsValue / Math.max(1, maxGoals)));

    // Average the two values for color intensity
    const intensity = (defconNorm + goalsNorm) / 2;

    const g = Math.floor(255 * (1 - intensity));
    const b = Math.floor(255 * (1 - intensity));
    return `rgb(255, ${g}, ${b})`;
};

/**
 * Get color for a value with optional inversion
 * @param {number} value - The value
 * @param {number} max - Maximum value for scaling
 * @param {boolean} isInverted - Whether to invert the color scale
 * @returns {string} RGBA color string
 */
export const getColorForValue = (value, max, isInverted = false) => {
    if (max === 0) return 'rgba(200, 200, 200, 0.1)';

    let normalized = value / max;
    if (isInverted) {
        normalized = 1 - normalized;
    }

    const intensity = normalized * 0.8;
    const red = Math.round(255 * intensity);
    return `rgba(${red}, ${Math.round(50 * intensity)}, ${Math.round(50 * intensity)}, ${intensity})`;
};

/**
 * Get text color based on background color for readability
 * @param {string} bgColor - Background color string
 * @returns {string} Text color ('#000' or '#fff')
 */
export const getTextColor = (bgColor) => {
    const match = bgColor.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (!match) return '#000';

    const [_, r, g, b] = match.map(Number);
    const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;

    return luminance > 0.5 ? '#000' : '#fff';
};

/**
 * Check if text should be white based on probability and archetype
 * @param {number} prob - Probability value (0-1)
 * @param {string} archetype - Player archetype
 * @returns {boolean} True if text should be white
 */
export const shouldUseWhiteText = (prob, archetype) => {
    if (archetype === 'MID' && prob >= 0.45) return true;
    if (archetype === 'FWD' && prob >= 0.50) return true;
    if (['CB', 'LB', 'RB'].includes(archetype) && prob >= 0.60) return true;
    return false;
};
