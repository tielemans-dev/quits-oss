/** How long a person can take an action back. Sends and emails wait this long before anything leaves. */
export const UNDO_WINDOW_MS = 8000

/**
 * A countdown that is paused (hover, focus) keeps its job held this much longer than the time it
 * has left, and renews that. If the tab goes away the hold lapses and the job runs.
 */
export const UNDO_HOLD_LEASE_MS = 5000
