import { afterEach, describe, expect, it, vi } from "vitest"
import { setRuntimeExtensions } from "../../../lib/runtime/extensions"
const save = vi.hoisted(() => vi.fn(async () => ({ status: "complete" })))
// MOCK: authentication/persistence are covered by integration tests. Input parsing,
// capability selection and the real onboarding route handler remain active.
vi.mock("../../../lib/db", () => ({ prisma: {} }))
vi.mock("../../../lib/distribution", () => ({ isCloudDistribution: true }))
vi.mock("../../../lib/onboarding/confirm-v2", () => ({ confirmOnboardingV2: save }))
vi.mock("../../init", async () => {
  const { initTRPC } = await import("@trpc/server")
  const t = initTRPC.create()
  return { router: t.router, authorizedProcedure: () => t.procedure, protectedProcedure: t.procedure }
})
import { onboardingRouter } from "../onboarding"
const actor = { organizationId: "org", user: { id: "user", email: "signup@example.test" }, session: { session: { id: "session" } } }
const caller = onboardingRouter.createCaller(actor as never)
const manual = { idempotencyKey: "4a8d7e5c-b2f1-4f72-8ba3-b58e21b55d45", source: "manual" as const,
  companyName: "Synthetic Seller", companyAddress: "Testvej 1", companyForm: "ApS", cvr: "", momsRegistered: false }
function capabilities(confirmation: boolean) {
  vi.stubEnv("QUITS_DISTRIBUTION", "cloud")
  setRuntimeExtensions([{ id: "synthetic", resolveCapabilities: () => ({ onboardingV2: { enabled: true, nonVatEnabled: true }, sellerVatConfirmation: { enabled: confirmation } }) }])
}
afterEach(() => { setRuntimeExtensions([]); vi.unstubAllEnvs(); vi.clearAllMocks() })
describe("manual v2 CVR validation at the server boundary", () => {
  it.each([true, false])("rejects empty CVR before persistence with required confirmation and choice %s", async momsRegistered => {
    capabilities(true)
    await expect(caller.confirmV2({ ...manual, momsRegistered })).rejects.toMatchObject({ code: "BAD_REQUEST", message: "cvr.invalid" })
    expect(save).not.toHaveBeenCalled()
  })
  it("preserves valid empty-CVR manual setup without confirmation", async () => {
    capabilities(false)
    await expect(caller.confirmV2(manual)).resolves.toMatchObject({ status: "complete" })
    expect(save).toHaveBeenCalledWith("org", expect.objectContaining({ cvr: "", momsRegistered: false }), "signup@example.test", expect.objectContaining({ userId: "user", sessionId: "session" }))
  })
  it.each([true, false])("passes valid reviewed CVR, choice %s and token to transactional confirmation", async momsRegistered => {
    capabilities(true)
    const input = { ...manual, cvr: "24256790", momsRegistered, ...(momsRegistered ? { vatId: "DK24256790" } : {}), sellerVatConfirmationToken: "signed-reviewed-identity" }
    await caller.confirmV2(input)
    expect(save).toHaveBeenCalledWith("org", expect.objectContaining(input), "signup@example.test", expect.objectContaining({ userId: "user", sessionId: "session" }))
  })
})
