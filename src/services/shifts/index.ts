/**
 * Shifts: one drawer from float in to count out. Expected cash is derived from the rows every
 * time; the count at the end is blind and it sticks. See shifts.service for the four rules.
 */
export { shiftFor, cashFigures, openSinceYesterday, current, open, move, close, openShifts, NOTE_MIN } from './shifts.service';
export type { CashFigures, MoveInput } from './shifts.service';
