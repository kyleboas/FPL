/**
 * FPL API Module
 * Functions for fetching data from the Fantasy Premier League API
 */

import { CONFIG } from './config.js';

/**
 * Fetch data from FPL API using proxies
 * @param {string} path - API path (e.g., '/bootstrap-static/')
 * @returns {Promise<Object>} Parsed JSON response
 */
export const fetchFPL = async (path) => {
    const targetBase = CONFIG.URLS.FPL_API_BASE;
    const proxies = CONFIG.URLS.FPL_API_PROXIES;
    const targetUrl = `${targetBase}${path}`;

    const errors = [];

    for (const proxyBase of proxies) {
        const finalUrl = `${proxyBase}${encodeURIComponent(targetUrl)}`;

        try {
            const res = await fetch(finalUrl);

            if (!res.ok) {
                errors.push(`Proxy ${proxyBase} returned ${res.status}`);
                continue;
            }

            const text = await res.text();

            if (!text || text.trim() === '') {
                errors.push(`Proxy ${proxyBase} returned empty response`);
                continue;
            }

            try {
                return JSON.parse(text);
            } catch (parseErr) {
                errors.push(`Proxy ${proxyBase} returned invalid JSON`);
                continue;
            }
        } catch (fetchErr) {
            const errMsg = fetchErr.message || fetchErr.name || 'Network error';
            errors.push(`Proxy ${proxyBase} failed: ${errMsg}`);
            continue;
        }
    }

    throw new Error(`All proxies failed: ${errors.join('; ')}`);
};

/**
 * Fetch an FPL team's current picks
 * @param {string|number} teamId - FPL team ID
 * @returns {Promise<{playerIds: number[], eventId: number}>}
 */
export const fetchFPLTeam = async (teamId) => {
    try {
        // Fetch current or next GW from bootstrap-static
        const bootstrap = await fetchFPL('/bootstrap-static/');

        const currentEvent =
            bootstrap.events.find(e => e.is_current) ||
            bootstrap.events.find(e => e.is_next);

        const eventId = currentEvent ? currentEvent.id : 1;

        // Fetch team picks for that event
        const picksData = await fetchFPL(`/entry/${teamId}/event/${eventId}/picks/`);

        const playerIds = (picksData.picks || []).map(pick => pick.element);

        return { playerIds, eventId };
    } catch (error) {
        console.error('Error fetching FPL team:', error);
        throw error;
    }
};
