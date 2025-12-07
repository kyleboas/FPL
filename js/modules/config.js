/**
 * Configuration Module
 * Shared configuration constants
 */

export const CONFIG = {
    PATHS: {
        SEASON_BASE: 'https://raw.githubusercontent.com/olbauday/FPL-Elo-Insights/main/data/2025-2026',
        PL_TOURNAMENT_BASE: 'https://raw.githubusercontent.com/olbauday/FPL-Elo-Insights/main/data/2025-2026/By%20Tournament/Premier%20League'
    },
    URLS: {
        PLAYERS: 'https://raw.githubusercontent.com/olbauday/FPL-Elo-Insights/main/data/2025-2026/players.csv',
        TEAMS: 'https://raw.githubusercontent.com/olbauday/FPL-Elo-Insights/main/data/2025-2026/teams.csv',
        POSITION_OVERRIDES: './data/player_position_overrides.csv',
        FPL_API_BASE: 'https://fantasy.premierleague.com/api',
        FPL_API_PROXIES: [
            'https://corsproxy.io/?',
            'https://api.allorigins.win/raw?url='
        ]
    },
    THRESHOLDS: {
        DEF: 10,
        MID_FWD: 12
    },
    MODEL: {
        K_FACTOR: 0,
        MIN_PROB: 0.0,
        MAX_PROB: 1.0
    },
    UI: {
        MAX_GW: 38
    }
};

export default CONFIG;
