import css from "../motion-tokens.css?raw"

// CSS is the source for Tailwind, plain CSS and script consumers.
const token = (name: string) => {
  const value = css.match(new RegExp(`--${name}:\\s*([^;]+);`))?.[1]?.trim()
  if (!value) throw new Error(`Missing motion token: ${name}`)
  return value
}
const milliseconds = (name: string) => Number.parseFloat(token(name))
export const EASE_ENTER = token("ease-enter")
export const EASE_EXIT = token("ease-exit")

/** Milliseconds, keyed by the camelCase of the `--duration-*` token. */
export const DURATION = {
  palette: milliseconds("duration-palette"),
  listFade: milliseconds("duration-list-fade"),
  spin: milliseconds("duration-spin"),
  pulse: milliseconds("duration-pulse"),
  fade: milliseconds("duration-fade"),
  undoFade: milliseconds("duration-undo-fade"),
  undoTick: milliseconds("duration-undo-tick"),
  squareShrink: milliseconds("duration-square-shrink"),
  surface: milliseconds("duration-surface"),
  leave: milliseconds("duration-leave"),
  squareFly: milliseconds("duration-square-fly"),
  base: milliseconds("duration-base"),
  row: milliseconds("duration-row"),
  toast: milliseconds("duration-toast"),
  card: milliseconds("duration-card"),
  count: milliseconds("duration-count"),
  highlight: milliseconds("duration-highlight"),
  requestPart: milliseconds("duration-request-part"),
} as const

export const STAGGER_STEP = milliseconds("stagger-step")

/** True when the user asked for reduced motion; script-driven motion then fades only. */
export const prefersReducedMotion = () =>
  typeof window !== "undefined" && (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false)
