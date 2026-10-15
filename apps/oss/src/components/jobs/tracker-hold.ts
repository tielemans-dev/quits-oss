import { useSyncExternalStore } from "react"

/**
 * While a card is flying to the corner, the tracker toast waits: it grows out of the square the
 * card became, so it must not appear before the square has landed.
 */
const listeners = new Set<() => void>()
let holds = 0

export function holdTracker(): () => void {
  holds += 1
  for (const listener of listeners) listener()
  let released = false
  return () => {
    if (released) return
    released = true
    holds -= 1
    for (const listener of listeners) listener()
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}

export function useTrackerHeld() {
  return useSyncExternalStore(subscribe, () => holds > 0, () => false)
}
