/**
 * Reuse window for the app layout's server call (`getAppLayoutSession`). Switching tabs and
 * hovering links all enter the layout; within this window they share one answer instead of asking
 * the server again. Short, because a session can change in another tab or device meanwhile.
 */
export const APP_LAYOUT_SESSION_REUSE_MS = 5_000

/** The user fields the browser may see. Nothing that authenticates (tokens, ids of sessions). */
export type AppLayoutUser = {
  id: string
  name: string | null
  email: string | null
  image: string | null
}

type Entry<T> = { startedAt: number; result: Promise<T>; userId?: string }

/**
 * Browser only. The guard is `import.meta.env.SSR`, which the bundler replaces with a constant, so
 * in the server bundle every function below returns early and the cache is never reachable: this
 * module is shared by every request of a server process, and a cached answer would be one user's
 * session served to another. It cannot be faked at run time the way `typeof window` can.
 */
let entry: Entry<{ user: unknown }> | null = null

/**
 * Loads the layout's session through a short-lived, in-flight-aware cache, so hover preloads and
 * the navigation that follows them make one request. A signed-out answer is never reused, and a
 * failed load is not remembered.
 *
 * The cache cannot read the session cookie (it is httpOnly), so it cannot compare users itself.
 * What keeps it from outliving an identity change is `invalidateAppLayoutSession`: called by every
 * place in this app that changes identity, by the auth client whenever better-auth reports a
 * session change (see `auth-client.ts`), and by the layout when the live session names a different
 * user than the cached answer.
 */
export function reuseAppLayoutSession<T extends { user: unknown }>(
  load: () => Promise<T>,
  now: () => number = Date.now
): Promise<T> {
  if (import.meta.env.SSR) return load()

  const current = entry as Entry<T> | null
  if (current && now() - current.startedAt < APP_LAYOUT_SESSION_REUSE_MS) return current.result

  const next: Entry<T> = { startedAt: now(), result: load() }
  entry = next
  forgetUnlessUsable(next)
  return next.result
}

function forgetUnlessUsable(next: Entry<{ user: unknown }>): void {
  next.result.then(
    (value) => {
      const user = value.user as { id?: unknown } | null
      if (entry === next && !user) entry = null
      else if (typeof user?.id === "string") next.userId = user.id
    },
    () => {
      if (entry === next) entry = null
    }
  )
}

/**
 * Starts the cache from an answer the browser already holds, the one the server rendered into the
 * page, so the first client navigation after a server render does not ask again. Only fills an
 * empty cache, and only for a signed-in answer.
 */
export function seedAppLayoutSession<T extends { user: unknown }>(
  value: T,
  now: () => number = Date.now
): void {
  if (import.meta.env.SSR || entry || !value.user) return
  const userId = (value.user as { id?: unknown }).id
  entry = { startedAt: now(), result: Promise.resolve(value), userId: typeof userId === "string" ? userId : undefined }
}

/**
 * Forgets the cached answer so the next navigation asks the server. Call after anything that
 * changes what the layout would answer: signing in or out, switching organization, completing
 * onboarding. A request already in flight still resolves for its caller but is not kept.
 *
 * Several callers (login, sign-out, organization switch) invalidate right before a full page load,
 * which discards this module anyway. Those calls matter mainly when the browser restores the page
 * from its back/forward cache, which keeps module state alive across the navigation.
 */
export function invalidateAppLayoutSession(): void {
  entry = null
}

/**
 * Drops the cached answer if it belongs to a different user than the one the live session names
 * (`null` for signed out). The layout calls this with what `useSession` reports, which is the
 * nearest the browser gets to checking the cached answer against the session cookie.
 */
export function invalidateAppLayoutSessionUnlessUser(userId: string | null): void {
  if (entry?.userId !== undefined && entry.userId !== userId) entry = null
}
