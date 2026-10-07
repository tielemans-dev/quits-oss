import { useEffect, useRef, useState } from "react"

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

/** A poll failure that retrying cannot fix; the page has to be reloaded. */
export type PollFailure = {
  code: string
  message: string
}

/**
 * tRPC error codes that retrying the same request cannot fix: the organization changed in
 * another tab (`CONFLICT`), the document is gone (`NOT_FOUND`) or no longer accessible
 * (`FORBIDDEN`).
 */
const FINAL_ERROR_CODES = new Set(["CONFLICT", "NOT_FOUND", "FORBIDDEN"])

/** The failure a poll error means for good, or `null` when the next poll may succeed. */
export function finalPollFailure(error: unknown): PollFailure | null {
  if (typeof error !== "object" || error === null) return null
  const data = (error as { data?: unknown }).data
  const code = typeof data === "object" && data !== null ? (data as { code?: unknown }).code : undefined
  if (typeof code !== "string" || !FINAL_ERROR_CODES.has(code)) return null
  const message = (error as { message?: unknown }).message
  return { code, message: typeof message === "string" && message ? message : code }
}

/**
 * Calls `poll` repeatedly while `active` is true, waiting `initialDelayMs` first and backing off
 * up to `maxDelayMs`. Stops when `active` turns false or the component unmounts. Transient
 * failures are retried on the next tick; a failure retrying cannot fix (see `finalPollFailure`)
 * stops polling and is returned so the page can tell the user to reload. It is cleared once
 * polling is no longer wanted. Used to follow work that settles in the background, such as an
 * email the outbox is still delivering.
 */
export function usePollWhile(
  active: boolean,
  poll: () => Promise<unknown>,
  options: PollOptions = {}
): PollFailure | null {
  const pollRef = useRef(poll)
  pollRef.current = poll
  const { initialDelayMs, maxDelayMs, backoff } = { ...DEFAULT_POLL_OPTIONS, ...options }
  const [failure, setFailure] = useState<PollFailure | null>(null)

  useEffect(() => {
    if (!active) {
      setFailure(null)
      return
    }
    if (failure) return
    let cancelled = false
    let delay = initialDelayMs
    let timer: ReturnType<typeof setTimeout> | undefined

    const tick = async () => {
      try {
        await pollRef.current()
      } catch (error) {
        const final = finalPollFailure(error)
        if (final) {
          if (!cancelled) setFailure(final)
          return
        }
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
  }, [active, failure, initialDelayMs, maxDelayMs, backoff])

  return failure
}
