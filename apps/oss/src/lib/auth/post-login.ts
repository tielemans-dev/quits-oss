type ListResult<T> = { data?: T | null; error?: { status?: number } | null }

export const SESSION_VISIBLE_ATTEMPTS = 3
export const SESSION_VISIBLE_RETRY_MS = 250

export type PostLoginOrganizations<T> =
  | { kind: "listed"; organizations: T }
  /** The server still answers 401 for the session sign-in just created. */
  | { kind: "no-session" }
  /** Listing failed for another reason; the caller lets the page guards recover. */
  | { kind: "unavailable" }

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Lists the organizations of the user who just signed in, and waits briefly for the server to
 * recognise the new session first.
 *
 * Sign-in answers before every server read can see the session it created (a read served from a
 * replica or connection that has not caught up answers 401 for a moment). Treating that 401 as
 * "no organizations" sent the user to /onboarding, whose guard found no session and bounced them
 * to an empty /login with no error, while the second attempt, a moment later, worked (QUI-76).
 * Retrying a few times hides the lag; if the session never appears the caller shows an error
 * instead of navigating into a guaranteed bounce.
 */
export async function listOrganizationsAfterSignIn<T>(
  list: () => Promise<ListResult<T>>,
  sleep: (ms: number) => Promise<void> = defaultSleep,
  isCancelled: () => boolean = () => false
): Promise<PostLoginOrganizations<T>> {
  let last: ListResult<T> = {}
  for (let attempt = 1; attempt <= SESSION_VISIBLE_ATTEMPTS; attempt++) {
    last = await list()
    if (!last.error) return { kind: "listed", organizations: (last.data ?? []) as T }
    if (last.error.status !== 401) return { kind: "unavailable" }
    if (attempt < SESSION_VISIBLE_ATTEMPTS) {
      await sleep(SESSION_VISIBLE_RETRY_MS * attempt)
      // The caller left the page: stop asking the server on its behalf.
      if (isCancelled()) return { kind: "unavailable" }
    }
  }
  return { kind: "no-session" }
}
