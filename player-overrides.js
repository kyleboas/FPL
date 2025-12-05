/**
 * Player Position Overrides
 *
 * This file contains manual position classifications for specific players.
 * Use this to override the automatic position detection when players are
 * misclassified in the source data.
 *
 * Map player names (case-insensitive) to their archetype:
 * - CB: Center Back
 * - LB: Left Back
 * - RB: Right Back
 * - MID: Midfielder
 * - FWD: Forward
 * - GKP: Goalkeeper
 */

const PLAYER_OVERRIDES = {
    'wieffer': 'CB'  // Classify Wieffer as a defender (Center Back)
};
