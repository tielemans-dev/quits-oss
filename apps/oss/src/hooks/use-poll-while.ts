import { useEffect, useRef } from "react"

export type PollOptions = {
  /** Delay before the first poll. */
  initialDelayMs?: number
  /** Upper bound for the delay between polls. */
  maxDelayMs?: number
  /** Factor the delay grows by after each poll. */
  backoff?: number
}

export const DEFAULT_POLL_OPTIONS: Required<PollOptions> = {
  initialDelayMs: 3_000,
  maxDelayMs: 15_000,
  backoff: 1.5,
}

/**
 * Calls `poll` repeatedly while `active` is true, waiting `initialDelayMs` first and backing off
 * up to `maxDelayMs`. Stops when `active` turns false or the component unmounts. Failed polls are
 * ignored and retried on the next tick. Used to follow work that settles in the background, such
 * as an email the outbox is still delivering.
 */
export function usePollWhile(active: boolean, poll: () => Promise<unknown>, options: PollOptions = {}) {
  const pollRef = useRef(poll)
  pollRef.current = poll
  const { initialDelayMs, maxDelayMs, backoff } = { ...DEFAULT_POLL_OPTIONS, ...options }

  useEffect(() => {
    if (!active) return
    let cancelled = false
    let delay = initialDelayMs
    let timer: ReturnType<typeof setTimeout> | undefined

    const tick = async () => {
      try {
        await pollRef.current()
      } catch {
        // A transient failure; the next tick tries again.
      }
      if (cancelled) return
      delay = Math.min(delay * backoff, maxDelayMs)
      timer = setTimeout(tick, delay)
    }

    timer = setTimeout(tick, delay)
    return () => {
      cancelled = true
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [active, initialDelayMs, maxDelayMs, backoff])
}
