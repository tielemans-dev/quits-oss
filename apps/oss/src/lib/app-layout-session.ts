/**
 * Reuse window for the app layout's server call (`getAppLayoutSession`). Switching tabs and
 * hovering links all enter the layout; within this window they share one answer instead of asking
 * the server again. Short, because a session can change in another tab or device meanwhile.
 */
export const APP_LAYOUT_SESSION_REUSE_MS = 5_000

type Entry<T> = { startedAt: number; result: Promise<T> }

let entry: Entry<{ session: unknown }> | null = null

/**
 * Loads the layout's session through a short-lived, in-flight-aware cache, so hover preloads and
 * the navigation that follows them make one request. Browser only: on the server this module is
 * shared between requests of different users, so every call loads afresh. A signed-out answer is
 * never reused, and a failed load is not remembered.
 */
export function reuseAppLayoutSession<T extends { session: unknown }>(
  load: () => Promise<T>,
  now: () => number = Date.now
): Promise<T> {
  if (typeof window === "undefined") return load()

  const current = entry as Entry<T> | null
  if (current && now() - current.startedAt < APP_LAYOUT_SESSION_REUSE_MS) return current.result

  const next: Entry<T> = { startedAt: now(), result: load() }
  entry = next
  next.result.then(
    (value) => {
      if (entry === next && !value.session) entry = null
    },
    () => {
      if (entry === next) entry = null
    }
  )
  return next.result
}

/**
 * Forgets the cached answer so the next navigation asks the server. Call after anything that
 * changes what the layout would answer: signing in or out, switching organization, completing
 * onboarding. A request already in flight still resolves for its caller but is not kept.
 */
export function invalidateAppLayoutSession(): void {
  entry = null
}
