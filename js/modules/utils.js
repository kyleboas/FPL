/**
 * Utility Functions Module
 * Common helper functions used across the application
 */

/**
 * Safely get a value from an object using multiple possible keys
 * @param {Object} obj - The object to search
 * @param {...string} keys - The keys to try in order
 * @returns {*} The first found value or undefined
 */
export const getVal = (obj, ...keys) => {
    for (let k of keys) {
        if (obj[k] !== undefined) return obj[k];
    }
    return undefined;
};

/**
 * Round a number to 2 decimal places
 * @param {number} num - The number to round
 * @returns {number} The rounded number
 */
export const roundToTwo = (num) => {
    return Math.round(num * 100) / 100;
};

/**
 * Parse excluded gameweeks from input string
 * @param {string} inputValue - Comma-separated list of GW numbers
 * @param {number} maxGW - Maximum gameweek number (default 38)
 * @returns {number[]} Array of valid excluded GW numbers
 */
export const parseExcludedGWs = (inputValue, maxGW = 38) => {
    if (!inputValue) return [];
    return inputValue
        .split(',')
        .map(s => parseInt(s.trim(), 10))
        .filter(n => !isNaN(n) && n >= 1 && n <= maxGW);
};
