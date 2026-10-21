import { expect, it, vi } from "vitest"
import { betterAuth } from "better-auth"
import { memoryAdapter } from "better-auth/adapters/memory"
import { buildQuitsAuthOptions } from "../runtime/auth-config"

it("drains expired verifications on auth traffic, but not on the session read of every request", async () => {
  const database: Record<string, Record<string, unknown>[]> = { user: [], session: [], account: [], verification: [] }
  const origin = "http://localhost:3102"
  const executeRaw = vi.fn().mockResolvedValue(0)
  const cleanups = () => executeRaw.mock.calls.filter(([sql]) => (sql as string[]).join("").includes("DELETE FROM verification")).length
  const options = buildQuitsAuthOptions({
    prisma: { $queryRaw: vi.fn().mockResolvedValue([{ count: 1 }]), $executeRaw: executeRaw } as never,
    env: { getEnv: (name) => name === "BETTER_AUTH_URL" ? origin : undefined },
    hooks: { createDatabaseAdapter: () => memoryAdapter(database) },
  })
  const auth = betterAuth({ ...options, secret: "verification-cleanup-test-secret-at-least-32-characters", logger: { disabled: true } })
  const signup = await auth.handler(new Request(`${origin}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ name: "Cleanup User", email: "cleanup@example.com", password: "cleanup-password123" }),
  }))
  expect(signup.status).toBe(200)
  expect(cleanups()).toBe(1)
  const cookie = signup.headers.getSetCookie().map(value => value.split(";")[0]).join("; ")
  // The browser reads the session over HTTP; the server reads it directly for tRPC and the layout.
  expect(await (await auth.handler(new Request(`${origin}/api/auth/get-session`, { headers: { cookie } }))).json()).toMatchObject({ user: { email: "cleanup@example.com" } })
  expect(await auth.api.getSession({ headers: new Headers({ cookie }) })).toMatchObject({ user: { email: "cleanup@example.com" } })
  expect(cleanups()).toBe(1)
  expect((await auth.handler(new Request(`${origin}/api/auth/sign-out`, { method: "POST", headers: { cookie, origin } }))).status).toBe(200)
  expect(cleanups()).toBe(2)
})
