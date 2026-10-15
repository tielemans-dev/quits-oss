import { afterEach, describe, expect, it, vi } from "vitest"
import { requireOnboardingCvr } from "../require-cvr"
import { resetRuntimeServices, setRuntimeServices } from "../../runtime/services"
import { buildQuitsAuthOptions } from "../../runtime/auth-config"
import { setupInitializeSchema } from "../../setup/validators"

const company = { cvr: "24256790", name: "Registered business", address: "Testvej 1",
  companyForm: "Enkeltmandsvirksomhed", status: "active" as const, statusClass: "active" as const, momsRegistered: false }
const get = vi.fn()
const input = { cvr: company.cvr, userId: "user", cloud: true }
function creation(cloud: boolean) {
  return buildQuitsAuthOptions({ prisma: {} as never, env: { getEnv: name =>
    name === "QUITS_DISTRIBUTION" ? (cloud ? "cloud" : "selfhost") : undefined } })
    .plugins[0].options.organizationHooks!.beforeCreateOrganization!
}
afterEach(() => { resetRuntimeServices(); get.mockReset() })
describe("B2B organization admission", () => {
  it.each([undefined, "", "00000000", "12345678", "2425679", "242567901", "DK24256790"])("refuses malformed CVR %s before lookup", async cvr => {
    setRuntimeServices({ cvrLookupProvider: { get, search: vi.fn() } })
    await expect(requireOnboardingCvr({ ...input, cvr })).rejects.toMatchObject({ message: "cvr.invalid" })
    expect(get).not.toHaveBeenCalled()
    await expect(creation(true)({ organization: { name: "Test", slug: "test", metadata: { cvr } }, user: { id: "user" } } as never)).rejects.toMatchObject({ body: { code: "cvr.invalid" } })
    expect(setupInitializeSchema.shape.organization.safeParse({ name: "Test", slug: "test", cvr }).success).toBe(cvr == null || cvr === "")
  })
  it("allows checksum-valid self-hosted businesses without registry access", async () => {
    await expect(requireOnboardingCvr({ ...input, cloud: false })).resolves.toBeNull()
    await expect(creation(false)({ organization: { name: "Test", slug: "test", metadata: { cvr: company.cvr } }, user: { id: "user" } } as never)).resolves.toMatchObject({ data: { name: "Test" } })
  })
  it.each([undefined, ""])("keeps self-hosted CVR optional: %s", async cvr => {
    await expect(creation(false)({ organization: { name: "Test", slug: "test", metadata: { cvr } }, user: { id: "user" } } as never)).resolves.toMatchObject({ data: { name: "Test" } })
  })
  it.each(["settings", "tax ID"])("deletes the new organization when its %s write fails, releasing the slug for retry", async failure => {
    const error = new Error("synthetic persistence failure")
    const orgs = new Set(["org"])
    const tx = { orgSettings: { create: vi.fn(async () => { if (failure === "settings") throw error }) },
      organizationTaxId: { create: vi.fn(async () => { if (failure === "tax ID") throw error }) } }
    const prisma = { $transaction: async (save: (tx: unknown) => unknown) => save(tx),
      organization: { delete: vi.fn(async ({ where }: { where: { id: string } }) => orgs.delete(where.id)) } }
    const hook = buildQuitsAuthOptions({ prisma: prisma as never, env: { getEnv: () => undefined } }).plugins[0].options.organizationHooks!.afterCreateOrganization!
    await expect(hook({ organization: { id: "org", name: company.name, metadata: { cvr: company.cvr } } } as never)).rejects.toMatchObject({ body: { code: "cvr.unavailable" } })
    expect(prisma.organization.delete).toHaveBeenCalledExactlyOnceWith({ where: { id: "org" } })
    expect(orgs.size).toBe(0)
  })
  it("fails closed when hosted lookup is absent or unavailable", async () => {
    await expect(requireOnboardingCvr(input)).rejects.toMatchObject({ message: "cvr.unavailable" })
    setRuntimeServices({ cvrLookupProvider: { get, search: vi.fn() } })
    get.mockRejectedValue(new Error("synthetic outage"))
    await expect(requireOnboardingCvr(input)).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: "cvr.unavailable" })
    await expect(creation(true)({ organization: { name: "Test", slug: "test", metadata: { cvr: company.cvr } }, user: { id: "user" } } as never)).rejects.toMatchObject({ body: { code: "cvr.unavailable" } })
  })
  it.each([null, { ...company, cvr: "45676102" }, { ...company, status: "ceased", statusClass: "blocked" }, { ...company, status: "liquidation", statusClass: "warn" }])("refuses unknown, mismatched or inactive businesses", async result => {
    get.mockResolvedValue(result)
    setRuntimeServices({ cvrLookupProvider: { get, search: vi.fn() } })
    await expect(requireOnboardingCvr(input)).rejects.toMatchObject({ message: "cvr.inactive" })
  })
  it("persists the admitted CVR and registry address", async () => {
    const tx = { orgSettings: { create: vi.fn() }, organizationTaxId: { create: vi.fn() } }
    const prisma = { $transaction: async (save: (tx: unknown) => unknown) => save(tx) }
    const hook = buildQuitsAuthOptions({ prisma: prisma as never, env: { getEnv: () => undefined } }).plugins[0].options.organizationHooks!.afterCreateOrganization!
    await hook({ organization: { id: "org", name: company.name, metadata: { cvr: company.cvr, onboardingCompany: company } } } as never)
    expect(tx.orgSettings.create).toHaveBeenCalledWith({ data: expect.objectContaining({ organizationId: "org", companyName: company.name, companyAddress: company.address }) })
    expect(tx.organizationTaxId.create).toHaveBeenCalledWith({ data: expect.objectContaining({ value: company.cvr, scheme: "cvr", isPrimary: true }) })
  })
  it("uses registry name/address before creation and accepts active non-VAT businesses", async () => {
    get.mockResolvedValue(company)
    setRuntimeServices({ cvrLookupProvider: { get, search: vi.fn() } })
    await expect(creation(true)({ organization: { name: "Untrusted", slug: "test", metadata: { cvr: company.cvr } }, user: { id: "user" } } as never)).resolves.toMatchObject({ data: { name: company.name, metadata: { onboardingCompany: { cvr: company.cvr, name: company.name, address: company.address } } } })
    expect(get).toHaveBeenCalledWith(company.cvr, expect.objectContaining({ userId: "user", signal: expect.any(AbortSignal) }))
  })
})
