import { randomUUID } from "node:crypto"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { betterAuth } from "better-auth"
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

  it("rejects distinct expired links concurrently without acquiring each other's verification locks", async () => {
    let release!: () => void
    const bothLocked = new Promise<void>((resolve) => { release = resolve })
    let lookups = 0
    const f = await fixture({
      createTransactionDatabaseAdapter: (tx) => (options: Parameters<ReturnType<typeof prismaAdapter>>[0]) => {
        const adapter = prismaAdapter(tx, { provider: "postgresql" })(options)
        return {
          ...adapter,
          async findMany(input: Parameters<typeof adapter.findMany>[0]) {
            if (input.model === "verification") {
              if (++lookups === 2) release()
              await bothLocked
            }
            return adapter.findMany(input)
          },
        }
      },
    })
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
    expect(await clients[0]!.verification.count({ where: { value: f.userId } })).toBe(2)
    expect(await clients[0]!.session.count({ where: { userId: f.userId } })).toBe(1)
    expect((await f.post(0, "/sign-in/email", { email: f.email, password: "original-password123" })).status).toBe(200)
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
    await Promise.all(f.background)
    expect((await f.post(0, "/reset-password", { token: f.token(), newPassword: "replacement-password123" })).status).toBe(500)
    expect(await clients[0]!.verification.count({ where: { value: f.userId } })).toBe(1)
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
