/**
 * Ids and cursors are bigint. They travel as strings of at most 18 digits so they
 * always fit a bigint (max 9.22e18) and never lose precision in a JS number (max 2^53).
 */
export const ID_PATTERN = /^\d{1,18}$/;
export const ID_MESSAGE = 'must be a non-negative integer of at most 18 digits';
