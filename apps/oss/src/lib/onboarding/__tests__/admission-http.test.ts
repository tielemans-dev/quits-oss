import { afterEach, expect, it, vi } from "vitest"
import { betterAuth } from "better-auth"
import { memoryAdapter } from "better-auth/adapters/memory"
import { buildQuitsAuthOptions } from "../../runtime/auth-config"
import { resetRuntimeServices, setRuntimeServices } from "../../runtime/services"

const company = { cvr: "24256790", name: "Registry ApS", address: "Testvej 1", companyForm: "ApS",
  status: "active" as const, statusClass: "active" as const, momsRegistered: true }
afterEach(() => { resetRuntimeServices(); vi.restoreAllMocks() })
it.each(["invalid", "inactive", "unavailable", "timeout", "active", "selfhost"])("enforces %s CVR admission through Better Auth HTTP", async scenario => {
  const origin = "http://localhost:3197"
  const database: Record<string, Record<string, unknown>[]> = { user: [], session: [], account: [], verification: [], organization: [], member: [], invitation: [] }
  const tx = { orgSettings: { create: vi.fn() }, organizationTaxId: { create: vi.fn() }, organizationCvrVerification: { upsert: vi.fn() } }
  const prisma = { organizationCvrVerification: { findMany: vi.fn().mockResolvedValue([]) }, $executeRaw: vi.fn(), $transaction: async (save: (tx: unknown) => unknown) => save(tx) }
  const get = vi.fn(async () => {
    if (scenario === "timeout") throw new DOMException("Synthetic timeout", "TimeoutError")
    if (scenario === "unavailable") throw new Error("private upstream failure")
    return scenario === "inactive" ? { ...company, status: "ceased" as const, statusClass: "blocked" as const } : company
  })
  setRuntimeServices({ cvrLookupProvider: { get, search: vi.fn() } })
  const options = buildQuitsAuthOptions({ prisma: prisma as never,
    env: { getEnv: name => name === "BETTER_AUTH_URL" ? origin : name === "QUITS_DISTRIBUTION" ? (scenario === "selfhost" ? "selfhost" : "cloud") : undefined },
    hooks: { createDatabaseAdapter: () => memoryAdapter(database) } })
  const auth = betterAuth({ ...options, secret: "synthetic-admission-http-secret-at-least-32-chars", logger: { disabled: true } })
  const signup = await auth.handler(new Request(`${origin}/api/auth/sign-up/email`, { method: "POST",
    headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ name: "Test", email: "test@example.test", password: "local-password123" }) }))
  expect(signup.status).toBe(200)
  const cookie = signup.headers.getSetCookie().map(value => value.split(";")[0]).join("; ")
  const response = await auth.handler(new Request(`${origin}/api/auth/organization/create`, { method: "POST",
    headers: { origin, cookie, "content-type": "application/json" },
    body: JSON.stringify({ name: "Typed name", slug: "test", metadata: { cvr: scenario === "invalid" ? "12345678" : scenario === "selfhost" ? "" : company.cvr } }) }))
  const admitted = scenario === "active" || scenario === "selfhost" || scenario === "unavailable" || scenario === "timeout"
  expect(response.status).toBe(admitted ? 200 : 400)
  expect(database.organization).toHaveLength(admitted ? 1 : 0)
  expect(tx.orgSettings.create).toHaveBeenCalledTimes(admitted ? 1 : 0)
  if (admitted) {
    expect(database.organization[0]!.name).toBe(scenario === "active" ? company.name : "Typed name")
    expect(tx.organizationTaxId.create).toHaveBeenCalledTimes(scenario === "selfhost" ? 0 : 1)
    if (scenario === "unavailable" || scenario === "timeout") expect(tx.organizationCvrVerification.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ cvr: company.cvr, status: "pending" }),
    }))
  } else {
    expect(await response.json()).toMatchObject({ code: `cvr.${scenario}` })
  }
  expect(get).toHaveBeenCalledTimes(scenario === "invalid" || scenario === "selfhost" ? 0 : 1)
})
