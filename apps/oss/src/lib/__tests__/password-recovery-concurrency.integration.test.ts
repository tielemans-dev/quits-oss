import { randomUUID } from "node:crypto"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { betterAuth } from "better-auth"
import { hashPassword } from "better-auth/crypto"
import { prismaAdapter } from "better-auth/adapters/prisma"
import { PrismaPg } from "@prisma/adapter-pg"
import { PrismaClient } from "../../../generated/prisma/client"
import { buildQuitsAuthOptions, type AuthHooks } from "../runtime/auth-config"

const databaseUrl = process.env.DATABASE_URL
const localDatabase = databaseUrl && ["localhost", "127.0.0.1"].includes(new URL(databaseUrl).hostname)
const origin = "http://localhost:3102"
const secret = "password-recovery-concurrency-test-secret-at-least-32-characters"
const clients: PrismaClient[] = []
const users: string[] = []

beforeAll(async () => {
  if (!localDatabase) return
  for (let index = 0; index < 2; index++) {
    const client = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) })
    await client.$connect()
    clients.push(client)
  }
})
afterEach(async () => {
  if (!clients.length) return
  await clients[0]!.verification.deleteMany({ where: { value: { in: users } } })
  await clients[0]!.user.deleteMany({ where: { id: { in: users } } })
  users.length = 0
})
afterAll(async () => { await Promise.all(clients.map((client) => client.$disconnect())) })

async function fixture(overrides: AuthHooks = {}) {
  const id = randomUUID()
  const email = `recovery-${id}@example.com`
  const sendResetPassword = vi.fn().mockResolvedValue(undefined)
  const background: Promise<void>[] = []
  const auths = clients.map((prisma) => {
    const options = buildQuitsAuthOptions({
      prisma,
      env: { getEnv: (name) => ({ BETTER_AUTH_URL: origin, BETTER_AUTH_SECRET: secret })[name] },
      hooks: {
        sendResetPassword,
        getRecoveryClientKey: () => `trusted-peer-${id}`,
        runInBackground: (task) => { background.push(task) },
        ...overrides,
      },
    })
    return betterAuth({ ...options, secret, logger: { disabled: true }, advanced: { ...options.advanced, disableOriginCheck: false, disableCSRFCheck: false } })
  })
  let requestNumber = 0
  const post = (instance: number, path: string, body: unknown) => auths[instance]!.handler(new Request(`${origin}/api/auth${path}`, {
    method: "POST",
    // Every request spoofs a new forwarding header. Admission must still use the same trusted peer.
    headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(JSON.stringify(body))), origin, "x-forwarded-for": `198.51.${++requestNumber}.${Math.floor(Math.random() * 250)}` },
    body: JSON.stringify(body),
  }))
  const signup = await post(0, "/sign-up/email", { email, name: "Concurrent Recovery", password: "original-password123" })
  expect(signup.status).toBe(200)
  const userId = (await signup.json()).user.id as string
  users.push(userId)
  const requestReset = (instance = 0, targetEmail = email) => post(instance, "/request-password-reset", { email: targetEmail, redirectTo: `${origin}/reset-password` })
  const token = () => sendResetPassword.mock.calls[0]![0].token as string
  return { auths, post, requestReset, token, email, userId, sendResetPassword, background }
}

describe.skipIf(!localDatabase)("shared database password recovery guards", () => {
  it("never starts delivery when PostgreSQL rejects issuance at commit", async () => {
    const sendResetPassword = vi.fn().mockResolvedValue(undefined)
    let deferredViolationInserted = false
    const f = await fixture({
      sendResetPassword,
      createTransactionDatabaseAdapter: (tx) => (options: Parameters<ReturnType<typeof prismaAdapter>>[0]) => {
        const adapter = prismaAdapter(tx, { provider: "postgresql" })(options)
        return {
          ...adapter,
          create: async (input: Parameters<typeof adapter.create>[0]) => {
            const result = await adapter.create(input)
            if (input.model === "verification") {
              // The native endpoint succeeds. This deferred FK fails only at COMMIT, after all
              // callback work has returned, and the temporary table rolls back with the token.
              await tx.$executeRaw`CREATE TEMP TABLE recovery_commit_parent (id TEXT PRIMARY KEY) ON COMMIT DROP`
              await tx.$executeRaw`CREATE TEMP TABLE recovery_commit_failure ("userId" TEXT REFERENCES recovery_commit_parent(id) DEFERRABLE INITIALLY DEFERRED) ON COMMIT DROP`
              await tx.$executeRaw`INSERT INTO recovery_commit_failure VALUES (${randomUUID()})`
              deferredViolationInserted = true
            }
            return result
          },
        }
      },
    })
    const logged = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      expect((await f.requestReset()).status).toBe(500)
      expect(deferredViolationInserted).toBe(true)
      await Promise.all(f.background)
      expect(sendResetPassword).not.toHaveBeenCalled()
      expect(f.background).toHaveLength(0)
      expect(await clients[0]!.verification.count({ where: { value: f.userId } })).toBe(0)
      expect(logged.mock.calls).toEqual([["Password reset transaction failed"]])
    } finally { logged.mockRestore() }
  })

  it.each(["body", "empty body with query fallback", "body takes precedence over query"])("allows exactly one simultaneous reset across instances using %s", async (tokenSource) => {
    const f = await fixture()
    expect((await f.requestReset()).status).toBe(200)
    await Promise.all(f.background)
    const passwords = ["first-replacement123", "second-replacement456"]
    const path = tokenSource === "empty body with query fallback"
      ? `/reset-password?token=${encodeURIComponent(f.token())}`
      : tokenSource === "body takes precedence over query" ? "/reset-password?token=unrelated-token" : "/reset-password"
    const token = tokenSource === "empty body with query fallback" ? "" : f.token()
    const results = await Promise.all(passwords.map((newPassword, index) => f.post(index, path, { token, newPassword })))
    expect(results.map((response) => response.status).sort()).toEqual([200, 400])
    const winner = results.findIndex((response) => response.status === 200)
    expect(await results[winner]!.json()).toEqual({ status: true })
    expect(results[winner]!.headers.get("content-length")).toBeNull()
    expect(results[winner]!.headers.get("x-forwarded-for")).toBeNull()
    expect((await f.post(0, "/sign-in/email", { email: f.email, password: passwords[winner] })).status).toBe(200)
    expect((await f.post(1, "/sign-in/email", { email: f.email, password: passwords[1 - winner] })).status).toBe(401)
    expect(await clients[0]!.verification.count({ where: { value: f.userId } })).toBe(0)
  })

  it("serializes different sibling tokens across instances and invalidates all siblings", async () => {
    const f = await fixture()
    await f.requestReset()
    await f.requestReset(1)
    await Promise.all(f.background)
    const tokens = f.sendResetPassword.mock.calls.map(([data]) => data.token as string)
    const responses = await Promise.all(tokens.map((token, index) => f.post(index, "/reset-password", { token, newPassword: `replacement-password${index}123` })))
    expect(responses.map((response) => response.status).sort()).toEqual([200, 400])
    expect(await clients[0]!.verification.count({ where: { value: f.userId } })).toBe(0)
  })

  it("using the newest link invalidates older links but preserves other users and verification kinds", async () => {
    const f = await fixture()
    const other = await fixture()
    await f.requestReset()
    await f.requestReset(1)
    await other.requestReset()
    await Promise.all([...f.background, ...other.background])
    await clients[0]!.verification.create({ data: { id: randomUUID(), identifier: "email-verification:other-purpose", value: f.userId, expiresAt: new Date(Date.now() + 60_000) } })
    const newer = f.sendResetPassword.mock.calls[1]![0].token as string
    expect((await f.post(0, "/reset-password", { token: newer, newPassword: "replacement-password123" })).status).toBe(200)
    expect((await f.post(1, "/reset-password", { token: f.token(), newPassword: "older-replacement123" })).status).toBe(400)
    expect(await clients[0]!.verification.count({ where: { value: other.userId } })).toBe(1)
    expect(await clients[0]!.verification.count({ where: { value: f.userId } })).toBe(1)
  })

  it("serializes new token issuance behind an active reset transaction", async () => {
    let entered!: () => void
    let release!: () => void
    const hashing = new Promise<void>((resolve) => { entered = resolve })
    const held = new Promise<void>((resolve) => { release = resolve })
    const f = await fixture({ password: { hash: async (password) => {
      if (password === "held-replacement123") { entered(); await held }
      return hashPassword(password)
    } } })
    await f.requestReset()
    await Promise.all(f.background)
    const resetting = f.post(0, "/reset-password", { token: f.token(), newPassword: "held-replacement123" })
    await hashing
    const requesting = f.requestReset(1)
    try {
      // PostgreSQL exposes the actual blocked row-lock waiter, rather than relying on timing.
      await vi.waitFor(async () => {
        const waiting = await clients[0]!.$queryRaw<{ count: bigint }[]>`SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE 'SELECT id FROM "user" WHERE email%'`
        expect(Number(waiting[0]!.count)).toBeGreaterThan(0)
      })
    } finally { release() }
    expect((await resetting).status).toBe(200)
    expect((await requesting).status).toBe(200)
    await Promise.all(f.background)
    expect(await clients[0]!.verification.count({ where: { value: f.userId } })).toBe(1)
    const freshToken = f.sendResetPassword.mock.calls[1]![0].token as string
    expect((await f.post(1, "/reset-password", { token: freshToken, newPassword: "fresh-replacement123" })).status).toBe(200)
  })

  it("rejects distinct expired links concurrently without acquiring each other's verification locks", async () => {
    const f = await fixture()
    await f.requestReset()
    await f.requestReset(1)
    await Promise.all(f.background)
    await clients[0]!.verification.updateMany({ where: { value: f.userId }, data: { expiresAt: new Date(Date.now() - 60_000) } })
    const tokens = f.sendResetPassword.mock.calls.map(([data]) => data.token as string)
    const responses = await Promise.all(tokens.map((token, index) => f.post(index, "/reset-password", { token, newPassword: `replacement-password${index}123` })))
    expect(responses.map((response) => response.status)).toEqual([400, 400])
    expect(await Promise.all(responses.map((response) => response.json()))).toEqual([
      expect.objectContaining({ code: "INVALID_TOKEN" }), expect.objectContaining({ code: "INVALID_TOKEN" }),
    ])
    expect(await clients[0]!.verification.count({ where: { value: f.userId } })).toBe(0)
    expect(await clients[0]!.session.count({ where: { userId: f.userId } })).toBe(1)
    expect((await f.post(0, "/sign-in/email", { email: f.email, password: "original-password123" })).status).toBe(200)
  })

  it("redirects an expired native GET while reset holds that token and needs an expired sibling", async () => {
    let entered!: () => void
    let release!: () => void
    const hashing = new Promise<void>((resolve) => { entered = resolve })
    const held = new Promise<void>((resolve) => { release = resolve })
    const f = await fixture({ password: { hash: async (password) => {
      if (password === "held-replacement123") { entered(); await held }
      return hashPassword(password)
    } } })
    await f.requestReset()
    await Promise.all(f.background)
    const expiresAt = new Date(Date.now() + 1000)
    await clients[0]!.verification.updateMany({ where: { value: f.userId }, data: { expiresAt } })
    const resetting = f.post(0, "/reset-password", { token: f.token(), newPassword: "held-replacement123" })
    let callback: Promise<Response> | undefined
    try {
      await hashing
      // Insert after reset acquires its token, so request-time cleanup cannot remove it early.
      await clients[1]!.verification.create({ data: { id: randomUUID(), identifier: `reset-password:${randomUUID()}`, value: f.userId, expiresAt: new Date(Date.now() - 60_000) } })
      await vi.waitFor(() => { expect(Date.now()).toBeGreaterThan(expiresAt.getTime()) }, { timeout: 2000, interval: 10 })
      callback = f.auths[1]!.handler(new Request(f.sendResetPassword.mock.calls[0]![0].url))
      // GET must finish before releasing reset. A blocked cleanup cannot pass this assertion.
      const response = await Promise.race([callback, new Promise<undefined>((resolve) => setTimeout(resolve, 1500))])
      expect(response?.status).toBe(302)
      expect(new URL(response!.headers.get("location")!).searchParams.get("error")).toBe("INVALID_TOKEN")
      expect(await clients[1]!.verification.count({ where: { value: f.userId } })).toBe(1)
    } finally {
      release()
      await callback
      expect((await resetting).status).toBe(200)
    }
    expect(await clients[0]!.verification.count({ where: { value: f.userId } })).toBe(0)
    expect(await clients[0]!.session.count({ where: { userId: f.userId } })).toBe(0)
    expect((await f.post(0, "/sign-in/email", { email: f.email, password: "held-replacement123" })).status).toBe(200)
  })

  it("rolls back password and token writes if native session revocation fails", async () => {
    const f = await fixture({
      createTransactionDatabaseAdapter: (tx) => (options: Parameters<ReturnType<typeof prismaAdapter>>[0]) => {
        const adapter = prismaAdapter(tx, { provider: "postgresql" })(options)
        return {
          ...adapter,
          deleteMany: (input: Parameters<typeof adapter.deleteMany>[0]) => {
            if (input.model === "session") throw new Error("session revocation failed")
            return adapter.deleteMany(input)
          },
        }
      },
    })
    await f.requestReset()
    await f.requestReset(1)
    await Promise.all(f.background)
    expect((await f.post(0, "/reset-password", { token: f.token(), newPassword: "replacement-password123" })).status).toBe(500)
    expect(await clients[0]!.verification.count({ where: { value: f.userId } })).toBe(2)
    expect((await f.post(0, "/sign-in/email", { email: f.email, password: "original-password123" })).status).toBe(200)
    expect((await f.post(0, "/sign-in/email", { email: f.email, password: "replacement-password123" })).status).toBe(401)
  })

  it("admits only three of twelve concurrent requests across instances despite spoofed forwarding headers", async () => {
    const f = await fixture()
    const responses = await Promise.all(Array.from({ length: 12 }, (_, index) => f.requestReset(index % 2)))
    await Promise.all(f.background)
    expect(responses.filter((response) => response.status === 200)).toHaveLength(3)
    expect(responses.filter((response) => response.status === 429)).toHaveLength(9)
    expect(f.sendResetPassword).toHaveBeenCalledTimes(3)
    expect(responses.find((response) => response.status === 429)?.headers.get("retry-after")).toBe("60")
  })

  it("returns both known and unknown confirmations while successful delivery is still pending", async () => {
    let release!: () => void
    const delivery = new Promise<void>((resolve) => { release = resolve })
    const sendResetPassword = vi.fn(() => delivery)
    const f = await fixture({ sendResetPassword })
    let settled = false
    delivery.then(() => { settled = true })
    try {
      const known = await Promise.race([f.requestReset(), new Promise<undefined>((resolve) => setTimeout(resolve, 500))])
      expect(known?.status).toBe(200)
      const unknown = await f.requestReset(1, "unknown-recovery@example.com")
      expect(await unknown.json()).toEqual(await known!.json())
      expect(settled).toBe(false)
      expect(sendResetPassword).toHaveBeenCalledOnce()
      expect(f.background).toHaveLength(1)
    } finally { release(); await Promise.all(f.background) }
  })

  it("returns before failed delivery completes and logs only a constant message", async () => {
    let reject!: (error: Error) => void
    const delivery = new Promise<void>((_resolve, fail) => { reject = fail })
    const logged = vi.spyOn(console, "error").mockImplementation(() => {})
    const f = await fixture({ sendResetPassword: () => delivery })
    try {
      const response = await Promise.race([f.requestReset(), new Promise<undefined>((resolve) => setTimeout(resolve, 500))])
      expect(response?.status).toBe(200)
      reject(new Error("private provider error with token, recipient and password"))
      await Promise.all(f.background)
      expect(logged.mock.calls).toEqual([["Password reset email delivery failed"]])
    } finally { reject(new Error("delivery ended")); await Promise.all(f.background); logged.mockRestore() }
  })
})
