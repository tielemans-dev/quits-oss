import { useCallback, useRef } from "react"
import { flushSync } from "react-dom"

import { EASE_ENTER } from "../../lib/motion"

const prefersReducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false

/**
 * Animates the height of `ref` across a change that resizes it. `run` commits the change, then
 * plays the old height to the new one, so the surface grows or shrinks instead of jumping. The
 * element must clip its overflow. With reduced motion the change is simply made.
 */
export function useMorph<T extends HTMLElement>(duration: number) {
  const ref = useRef<T>(null)
  const run = useCallback(
    (change: () => void) => {
      const el = ref.current
      const from = el?.offsetHeight
      flushSync(change)
      if (!el || from === undefined || typeof el.animate !== "function" || prefersReducedMotion()) return
      const to = el.offsetHeight
      if (from !== to) el.animate({ height: [`${from}px`, `${to}px`] }, { duration, easing: EASE_ENTER })
    },
    [duration]
  )
  return { ref, run }
}
