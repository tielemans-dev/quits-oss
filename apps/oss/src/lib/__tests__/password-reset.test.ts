import { describe, expect, it, vi } from "vitest"
import { betterAuth } from "better-auth"
import { memoryAdapter } from "better-auth/adapters/memory"
import { buildQuitsAuthOptions, type AuthHooks } from "../runtime/auth-config"
import { PASSWORD_RESET_EXPIRES_IN } from "../auth/password-policy"

let clientNumber = 0

function fixture(sendResetPassword = vi.fn().mockResolvedValue(undefined), runInBackground?: AuthHooks["runInBackground"]) {
  const database: Record<string, Record<string, unknown>[]> = { user: [], session: [], account: [], verification: [] }
  const origin = "http://localhost:3102"
  const background: Promise<void>[] = []
  const logger = vi.fn()
  const transaction = vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work({ $queryRaw: vi.fn().mockResolvedValue([]) }))
  const options = buildQuitsAuthOptions({
    prisma: {
      $queryRaw: vi.fn().mockResolvedValue([{ count: 1 }]),
      $executeRaw: vi.fn().mockResolvedValue(0),
      $transaction: transaction,
    } as never,
    env: { getEnv: (name) => name === "BETTER_AUTH_URL" ? origin : undefined },
    hooks: { createDatabaseAdapter: () => memoryAdapter(database), createTransactionDatabaseAdapter: () => memoryAdapter(database), sendResetPassword, runInBackground: runInBackground ?? ((task) => { background.push(task) }) },
  })
  const auth = betterAuth({ ...options, secret: "password-reset-test-secret-at-least-32-characters", logger: { log: logger }, advanced: { ...options.advanced, disableOriginCheck: false, disableCSRFCheck: false } })
  const ip = `192.0.2.${++clientNumber}`
  const post = (path: string, body: unknown) => auth.handler(new Request(`${origin}/api/auth${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin, "x-forwarded-for": ip },
    body: JSON.stringify(body),
  }))
  const signup = () => post("/sign-up/email", { name: "Recovery User", email: "recovery@example.com", password: "old-password123" })
  const requestReset = (email = "recovery@example.com", redirectTo = `${origin}/reset-password`) => post("/request-password-reset", { email, redirectTo })
  const resetToken = () => sendResetPassword.mock.calls[0]?.[0].token as string
  return { auth, database, origin, post, signup, requestReset, resetToken, sendResetPassword, transaction, background, logger }
}

describe("Better Auth password recovery", () => {
  it.each([false, true])("preserves generic confirmation when background registration throws, delivery rejects: %s", async (rejectDelivery) => {
    let finish!: () => void
    const delivery = new Promise<void>((resolve, reject) => {
      finish = () => rejectDelivery ? reject(new Error("private provider details")) : resolve()
    })
    const tasks: Promise<void>[] = []
    const register = vi.fn((task: Promise<void>) => {
      tasks.push(task)
      throw new Error("private registration details")
    })
    const sender = vi.fn(() => delivery)
    const f = fixture(sender, register)
    await f.signup()
    const logged = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      const known = await f.requestReset()
      const unknown = await f.requestReset("private-unknown@example.com")
      expect([known.status, unknown.status]).toEqual([200, 200])
      expect(await known.json()).toEqual(await unknown.json())
      expect(f.database.verification).toHaveLength(1)
      expect(sender).toHaveBeenCalledOnce()
      expect(register).toHaveBeenCalledOnce()
      expect(f.logger).not.toHaveBeenCalled()
      expect(logged.mock.calls).toEqual([["Auth background task registration failed"]])
      finish()
      await Promise.all(tasks)
      expect(logged.mock.calls).toEqual([
        ["Auth background task registration failed"],
        ...(rejectDelivery ? [["Password reset email delivery failed"]] : []),
      ])
    } finally { finish(); await Promise.all(tasks); logged.mockRestore() }
  })

  it("observes background promise rejection even when registration throws", async () => {
    const tasks: Promise<void>[] = []
    const f = fixture(undefined, (task) => {
      tasks.push(task)
      throw new Error("private registration details")
    })
    const logged = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      const handler = f.auth.options.advanced!.backgroundTasks!.handler!
      expect(() => handler(Promise.reject(new Error("private task details")))).not.toThrow()
      await Promise.all(tasks)
      expect(logged.mock.calls).toEqual([
        ["Auth background task registration failed"], ["Auth background task failed"],
      ])
    } finally { logged.mockRestore() }
  })

  it("does not start delivery or hand it to native waitUntil before a successful commit", async () => {
    const f = fixture()
    await f.signup()
    const context = await f.auth.$context
    const nativeWaitUntil = vi.fn(async (task: void | Promise<unknown>) => { f.background.push(Promise.resolve(task).then(() => {})) })
    context.runInBackgroundOrAwait = nativeWaitUntil
    f.transaction.mockImplementationOnce(async (work) => {
      const result = await work({ $queryRaw: vi.fn().mockResolvedValue([]) })
      expect(f.sendResetPassword).not.toHaveBeenCalled()
      expect(nativeWaitUntil).not.toHaveBeenCalled()
      expect(f.background).toHaveLength(0)
      return result
    })
    expect((await f.requestReset()).status).toBe(200)
    await Promise.all(f.background)
    expect(f.sendResetPassword).toHaveBeenCalledOnce()
    expect(f.background).toHaveLength(1)
    expect(context.options.emailAndPassword?.sendResetPassword).toBe(f.auth.options.emailAndPassword?.sendResetPassword)
  })

  it("discards a rolled-back issuance queue while an independent request commits", async () => {
    const f = fixture()
    await f.signup()
    let entered!: () => void
    let release!: () => void
    const buffered = new Promise<void>((resolve) => { entered = resolve })
    const held = new Promise<void>((resolve) => { release = resolve })
    f.transaction.mockImplementationOnce(async (work) => {
      await work({ $queryRaw: vi.fn().mockResolvedValue([]) })
      entered()
      await held
      throw new Error("commit failed")
    })
    const logged = vi.spyOn(console, "error").mockImplementation(() => {})
    const failing = f.requestReset()
    try {
      await buffered
      expect(f.sendResetPassword).not.toHaveBeenCalled()
      expect((await f.requestReset()).status).toBe(200)
      await Promise.all(f.background)
      expect(f.sendResetPassword).toHaveBeenCalledOnce()
    } finally { release(); await failing; logged.mockRestore() }
    expect((await failing).status).toBe(500)
    await Promise.all(f.background)
    expect(f.sendResetPassword).toHaveBeenCalledOnce()
  })

  it("keeps native unknown-account timing work and omits only its identifying log", async () => {
    const f = fixture()
    await f.signup()
    const context = await f.auth.$context
    const originalError = context.logger.error
    const known = await f.requestReset()
    const unknown = await f.requestReset("private-unknown@example.com")
    expect(unknown.status).toBe(known.status)
    expect(await unknown.json()).toEqual(await known.json())
    expect(f.sendResetPassword).toHaveBeenCalledOnce()
    expect(f.logger).not.toHaveBeenCalled()
    expect(context.logger.error).toBe(originalError)
    context.logger.error("An unrelated auth failure")
    expect(f.logger).toHaveBeenCalledWith("error", "An unrelated auth failure")
  })

  it("changes the password, consumes the token and revokes all existing sessions", async () => {
    const f = fixture()
    const signup = await f.signup()
    expect(signup.status).toBe(200)
    expect(f.database.session).toHaveLength(1)
    const requested = await f.requestReset()
    expect(requested.status).toBe(200)
    expect(f.sendResetPassword).toHaveBeenCalledOnce()
    const verification = f.database.verification[0]!
    expect((verification.expiresAt as Date).getTime() - Date.now()).toBeLessThanOrEqual(PASSWORD_RESET_EXPIRES_IN * 1000)
    expect((verification.expiresAt as Date).getTime() - Date.now()).toBeGreaterThan((PASSWORD_RESET_EXPIRES_IN - 5) * 1000)
    const url = f.sendResetPassword.mock.calls[0]![0].url as string
    const callback = await f.auth.handler(new Request(url))
    expect(callback.status).toBe(302)
    expect(new URL(callback.headers.get("location")!).searchParams.get("token")).toBe(f.resetToken())
    const reset = await f.post("/reset-password", { token: f.resetToken(), newPassword: "new-password456" })
    expect(reset.status).toBe(200)
    expect(f.database.session).toHaveLength(0)
    expect(f.database.verification).toHaveLength(0)
    expect((await f.post("/reset-password", { token: f.resetToken(), newPassword: "third-password789" })).status).toBe(400)
    expect((await f.post("/sign-in/email", { email: "recovery@example.com", password: "old-password123" })).status).toBe(401)
    expect((await f.post("/sign-in/email", { email: "recovery@example.com", password: "new-password456" })).status).toBe(200)
  })

  it("gives identical confirmations for known, unknown and delivery-failed accounts", async () => {
    const f = fixture()
    await f.signup()
    const known = await f.requestReset()
    const unknown = await f.requestReset("missing@example.com")
    expect(await unknown.json()).toEqual(await known.json())
    expect(f.sendResetPassword).toHaveBeenCalledOnce()
    const logged = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      f.sendResetPassword.mockRejectedValue(new Error("provider error with private reset URL"))
      const failed = await f.requestReset()
      expect(failed.status).toBe(200)
      expect(await failed.json()).toEqual({ status: true, message: "If this email exists in our system, check your email for the reset link" })
      expect(logged).toHaveBeenCalledWith("Password reset email delivery failed")
    } finally { logged.mockRestore() }
  })

  it("rejects expired links and passwords outside the server policy", async () => {
    const f = fixture()
    await f.signup()
    await f.requestReset()
    for (const newPassword of ["short", "x".repeat(129)]) {
      expect((await f.post("/reset-password", { token: f.resetToken(), newPassword })).status).toBe(400)
    }
    f.database.verification[0]!.expiresAt = new Date(Date.now() - 1000)
    expect((await f.post("/reset-password", { token: f.resetToken(), newPassword: "new-password456" })).status).toBe(400)
    const callback = await f.auth.handler(new Request(f.sendResetPassword.mock.calls[0]![0].url))
    expect(new URL(callback.headers.get("location")!).searchParams.get("error")).toBe("INVALID_TOKEN")
    expect((await f.post("/sign-in/email", { email: "recovery@example.com", password: "old-password123" })).status).toBe(200)
  })

  it("rejects untrusted redirects", async () => {
    const f = fixture()
    await f.signup()
    expect((await f.requestReset("recovery@example.com", "https://attacker.example/reset")).status).toBe(403)
    expect(f.sendResetPassword).not.toHaveBeenCalled()
  })

  it("preserves native body-token validation even with a valid query token", async () => {
    const f = fixture()
    await f.signup()
    await f.requestReset()
    const path = `/reset-password?token=${encodeURIComponent(f.resetToken())}`
    for (const token of [null, false, 0, [], {}]) {
      expect((await f.post(path, { token, newPassword: "new-password456" })).status).toBe(400)
    }
    expect(f.database.verification).toHaveLength(1)
    expect((await f.post(path, { token: "", newPassword: "new-password456" })).status).toBe(200)
  })

  it.each([null, true, false, 0, 123, [], {}, undefined].map((newPassword) => ({ newPassword })))("preserves native malformed-password errors and the reset token for $newPassword", async ({ newPassword }) => {
    const f = fixture()
    await f.signup()
    await f.requestReset()
    const failed = await f.post("/reset-password", { token: f.resetToken(), newPassword })
    expect(failed.status).toBe(400)
    expect(await failed.json()).toEqual(expect.objectContaining({ code: "VALIDATION_ERROR" }))
    expect(f.database.verification).toHaveLength(1)
    expect(f.database.session).toHaveLength(1)
    expect((await f.post("/sign-in/email", { email: "recovery@example.com", password: "old-password123" })).status).toBe(200)
    expect((await f.post("/reset-password", { token: f.resetToken(), newPassword: "new-password456" })).status).toBe(200)
    expect(f.database.verification).toHaveLength(0)
    expect(f.database.session).toHaveLength(0)
  })
})
