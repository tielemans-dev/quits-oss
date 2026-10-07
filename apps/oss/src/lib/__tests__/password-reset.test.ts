import { describe, expect, it, vi } from "vitest"
import { betterAuth } from "better-auth"
import { memoryAdapter } from "better-auth/adapters/memory"
import { buildQuitsAuthOptions } from "../runtime/auth-config"
import { PASSWORD_RESET_EXPIRES_IN } from "../auth/password-policy"

let clientNumber = 0

function fixture(sendResetPassword = vi.fn().mockResolvedValue(undefined)) {
  const database: Record<string, Record<string, unknown>[]> = { user: [], session: [], account: [], verification: [] }
  const origin = "http://localhost:3102"
  const options = buildQuitsAuthOptions({
    prisma: {} as never,
    env: { getEnv: (name) => name === "BETTER_AUTH_URL" ? origin : undefined },
    hooks: { createDatabaseAdapter: () => memoryAdapter(database), sendResetPassword },
  })
  const auth = betterAuth({ ...options, secret: "password-reset-test-secret-at-least-32-characters", logger: { disabled: true }, advanced: { ...options.advanced, disableOriginCheck: false, disableCSRFCheck: false } })
  const ip = `192.0.2.${++clientNumber}`
  const post = (path: string, body: unknown) => auth.handler(new Request(`${origin}/api/auth${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin, "x-forwarded-for": ip },
    body: JSON.stringify(body),
  }))
  const signup = () => post("/sign-up/email", { name: "Recovery User", email: "recovery@example.com", password: "old-password123" })
  const requestReset = (email = "recovery@example.com", redirectTo = `${origin}/reset-password`) => post("/request-password-reset", { email, redirectTo })
  const resetToken = () => sendResetPassword.mock.calls[0]?.[0].token as string
  return { auth, database, origin, post, signup, requestReset, resetToken, sendResetPassword }
}

describe("Better Auth password recovery", () => {
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

  it("rejects untrusted redirects and throttles recovery requests", async () => {
    const f = fixture()
    await f.signup()
    expect((await f.requestReset("recovery@example.com", "https://attacker.example/reset")).status).toBe(403)
    expect(f.sendResetPassword).not.toHaveBeenCalled()
    const statuses = []
    for (let i = 0; i < 4; i++) statuses.push((await f.requestReset("missing@example.com")).status)
    expect(statuses).toContain(429)
  })
})
