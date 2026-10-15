/**
 * Easings and durations for script (Web Animations, timers). The CSS side reads the same values
 * from `motion-tokens.css`; `__tests__/motion.test.ts` keeps the two equal.
 */
export const EASE_ENTER = "cubic-bezier(0.32, 0.72, 0, 1)"
export const EASE_EXIT = "ease-out"

/** Milliseconds, keyed by the camelCase of the `--duration-*` token. */
export const DURATION = {
  fade: 150,
  squareShrink: 200,
  leave: 250,
  squareFly: 260,
  base: 300,
  row: 320,
  toast: 380,
  card: 400,
  highlight: 2400,
} as const

export const STAGGER_STEP = 45
