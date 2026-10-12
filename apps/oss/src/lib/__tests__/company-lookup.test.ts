import { afterEach, describe, expect, it, vi } from "vitest"
import { lookupOnboardingCompany } from "../runtime/company-lookup"
import { setRuntimeExtensions } from "../runtime/extensions"
const input = { query: "Synthetic", organizationId: "org", userId: "user", sessionId: "session" }
const lookup = vi.fn()
function enable() {
  vi.stubEnv("QUITS_DISTRIBUTION", "cloud")
  setRuntimeExtensions([{ id: "operator", companyLookup: { lookup }, resolveCapabilities: () => ({ onboardingV2: { enabled: true }, sellerVatConfirmation: { enabled: true } }) }])
}
afterEach(() => { setRuntimeExtensions([]); vi.unstubAllEnvs(); vi.clearAllMocks() })
describe("company lookup extension", () => {
  it("passes authenticated actor and strips registry VAT and contacts", async () => {
    enable()
    lookup.mockResolvedValue({ unavailable: false, companies: [{ cvr: "24256790", companyName: "Synthetic", companyAddress: "Testvej 1", companyForm: "ApS", statusText: "UKENDT", presetsAllowed: false, momsRegistered: true, email: "private@example.test" }] })
    const result = await lookupOnboardingCompany(input)
    expect(lookup).toHaveBeenCalledWith(input)
    expect(result.companies[0]).not.toHaveProperty("momsRegistered")
    expect(result.companies[0]).not.toHaveProperty("email")
    expect(result.companies[0]?.presetsAllowed).toBe(false)
  })
  it("never calls the provider for self-hosting", async () => {
    enable(); vi.stubEnv("QUITS_DISTRIBUTION", "selfhost")
    await expect(lookupOnboardingCompany(input)).rejects.toMatchObject({ code: "FORBIDDEN" })
    expect(lookup).not.toHaveBeenCalled()
  })
  it("returns manual fallback without a provider and rejects malformed facts", async () => {
    enable(); setRuntimeExtensions([{ id: "missing", resolveCapabilities: () => ({ onboardingV2: { enabled: true }, sellerVatConfirmation: { enabled: true } }) }])
    expect(await lookupOnboardingCompany(input)).toEqual({ companies: [], unavailable: true })
    enable(); lookup.mockResolvedValue({ companies: [{ cvr: "wrong" }], unavailable: false })
    await expect(lookupOnboardingCompany(input)).rejects.toThrow()
  })
})
