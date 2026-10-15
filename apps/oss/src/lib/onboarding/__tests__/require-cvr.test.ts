import { describe, expect, it, vi } from "vitest"
import { buildQuitsAuthOptions } from "../../runtime/auth-config"

const company = { cvr: "24256790", name: "Registered business", address: "Testvej 1" }
describe("B2B organization admission cleanup", () => {
  it.each(["settings", "tax ID"])("deletes the new organization when its %s write fails, releasing the slug for retry", async failure => {
    const error = new Error("synthetic persistence failure")
    const tx = { orgSettings: { create: vi.fn(async () => { if (failure === "settings") throw error }) },
      organizationTaxId: { create: vi.fn(async () => { if (failure === "tax ID") throw error }) } }
    const prisma = { $transaction: async (save: (tx: unknown) => unknown) => save(tx),
      organization: { delete: vi.fn() } }
    const hook = buildQuitsAuthOptions({ prisma: prisma as never, env: { getEnv: () => undefined } }).plugins[0].options.organizationHooks!.afterCreateOrganization!
    await expect(hook({ organization: { id: "org", name: company.name, metadata: { cvr: company.cvr } } } as never)).rejects.toMatchObject({ body: { code: "cvr.unavailable" } })
    expect(prisma.organization.delete).toHaveBeenCalledExactlyOnceWith({ where: { id: "org" } })
  })
  it("persists the admitted CVR and registry address", async () => {
    const tx = { orgSettings: { create: vi.fn() }, organizationTaxId: { create: vi.fn() } }
    const prisma = { $transaction: async (save: (tx: unknown) => unknown) => save(tx) }
    const hook = buildQuitsAuthOptions({ prisma: prisma as never, env: { getEnv: () => undefined } }).plugins[0].options.organizationHooks!.afterCreateOrganization!
    await hook({ organization: { id: "org", name: company.name, metadata: { cvr: company.cvr, onboardingCompany: company } } } as never)
    expect(tx.orgSettings.create).toHaveBeenCalledWith({ data: expect.objectContaining({ organizationId: "org", companyName: company.name, companyAddress: company.address }) })
    expect(tx.organizationTaxId.create).toHaveBeenCalledWith({ data: expect.objectContaining({ value: company.cvr, scheme: "cvr", isPrimary: true }) })
  })
})
