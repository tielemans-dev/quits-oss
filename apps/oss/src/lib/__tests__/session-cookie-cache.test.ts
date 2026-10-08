import { betterAuth } from "better-auth"
import { memoryAdapter } from "better-auth/adapters/memory"
import { afterEach, describe, expect, it, vi } from "vitest"
import { buildQuitsAuthOptions, SESSION_COOKIE_CACHE_MAX_AGE_SECONDS } from "../runtime/auth-config"

const origin = "http://localhost:3102"

function fixture() {
  const database: Record<string, Record<string, unknown>[]> = { user: [], session: [], account: [], verification: [], organization: [], member: [], invitation: [], team: [], teamMember: [] }
  const prisma = {
    $executeRaw: vi.fn().mockResolvedValue(0),
    $queryRaw: vi.fn().mockResolvedValue([]),
    $transaction: vi.fn(),
  }
  const options = buildQuitsAuthOptions({
    prisma: prisma as never,
    env: { getEnv: (name) => (name === "BETTER_AUTH_URL" ? origin : undefined) },
    hooks: { createDatabaseAdapter: () => memoryAdapter(database) },
  })
  const auth = betterAuth({ ...options, secret: "session-cache-test-secret-at-least-32-characters" })
  return { auth, database, executeRaw: prisma.$executeRaw }
}

/** The cookies a browser keeps, updated from each response's `Set-Cookie` headers. */
function absorb(cookies: Map<string, string>, setCookie: string[]) {
  for (const value of setCookie) {
    const [pair] = value.split(";")
    const separator = pair!.indexOf("=")
    cookies.set(pair!.slice(0, separator), pair!.slice(separator + 1))
  }
}

function jar(cookies: Map<string, string>) {
  return new Headers({ cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join("; ") })
}

/** Signs up a user and returns the cookies the browser would keep. */
async function signUp(auth: ReturnType<typeof fixture>["auth"]) {
  const { headers } = await auth.api.signUpEmail({
    body: { email: "cache-test@example.com", password: "correct horse battery staple", name: "Cache Test" },
    returnHeaders: true,
  })
  const cookie = headers.getSetCookie().map((value) => value.split(";")[0]).join("; ")
  return new Headers({ cookie })
}

afterEach(() => {
  vi.useRealTimers()
})

describe("session cookie cache", () => {
  it("caches the session for the bounded window that the revocation trade-off documents", () => {
    const { auth } = fixture()
    expect(auth.options.session?.cookieCache).toEqual({ enabled: true, maxAge: SESSION_COOKIE_CACHE_MAX_AGE_SECONDS })
    expect(SESSION_COOKIE_CACHE_MAX_AGE_SECONDS).toBeLessThanOrEqual(60)
  })

  it("answers a session read from the cookie without reading the session row", async () => {
    const { auth, database } = fixture()
    const headers = await signUp(auth)

    // Simulate a revoked session: the row is gone, the browser's cached copy is not.
    database.session.splice(0)
    expect(await auth.api.getSession({ headers }).then((result) => result?.user.email)).toBe("cache-test@example.com")
  })

  it("stops accepting a revoked session once the cached copy expires", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    const { auth, database } = fixture()
    const headers = await signUp(auth)
    database.session.splice(0)

    vi.setSystemTime(Date.now() + (SESSION_COOKIE_CACHE_MAX_AGE_SECONDS + 1) * 1000)
    expect(await auth.api.getSession({ headers })).toBeNull()
  })

  it("reports each switched-to organization from the cookie, as the browser keeps refreshing it", async () => {
    const { auth } = fixture()
    const cookies = new Map<string, string>()
    absorb(cookies, (await auth.api.signUpEmail({
      body: { email: "cache-test@example.com", password: "correct horse battery staple", name: "Cache Test" },
      returnHeaders: true,
    })).headers.getSetCookie())
    const activeOrganization = () => auth.api.getSession({ headers: jar(cookies) }).then((result) => result?.session.activeOrganizationId)

    const first = await auth.api.createOrganization({ body: { name: "First", slug: "first" }, headers: jar(cookies) })
    const second = await auth.api.createOrganization({ body: { name: "Second", slug: "second" }, headers: jar(cookies) })
    for (const organization of [first!, second!]) {
      const switched = await auth.api.setActiveOrganization({ body: { organizationId: organization.id }, headers: jar(cookies), returnHeaders: true })
      absorb(cookies, switched.headers.getSetCookie())
      expect(await activeOrganization()).toBe(organization.id)
    }
  })

  it("does not drain expired verifications on a session read, but still does on other auth traffic", async () => {
    const { auth, executeRaw } = fixture()
    const headers = await signUp(auth)
    expect(executeRaw).toHaveBeenCalled()

    executeRaw.mockClear()
    await auth.api.getSession({ headers })
    expect(executeRaw).not.toHaveBeenCalled()

    await auth.api.signOut({ headers }).catch(() => undefined)
    expect(executeRaw).toHaveBeenCalled()
  })
})
