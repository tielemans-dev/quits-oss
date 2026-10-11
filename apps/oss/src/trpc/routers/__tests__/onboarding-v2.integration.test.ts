import { randomUUID } from "node:crypto"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { confirmOnboardingV2Schema, type ConfirmOnboardingV2Input } from "@quits/contracts/onboarding"
import { prisma } from "../../../lib/db"
import { confirmOnboardingV2 } from "../../../lib/onboarding/confirm-v2"
import { cleanupTestOrganizations, hasTestDatabase } from "../../../test-utils/organization"
import { ensureTestMembership } from "../../../test-utils/membership"
import { bootstrapQuitsRuntime } from "../../../lib/runtime/bootstrap"
import { setRuntimeExtensions, getRuntimeCapabilities } from "../../../lib/runtime/extensions"

const ids: string[] = []
const summary = (): ConfirmOnboardingV2Input => ({ idempotencyKey: randomUUID(), companyName: "Synthetic Test ApS", companyAddress: "Testvej 1, 2. th.\n1000 København", cvr: "24256790", companyForm: "ApS", momsRegistered: true, vatId: "DK24256790" })
async function organization() {
  const id = randomUUID()
  ids.push(id)
  await prisma.organization.create({ data: { id, name: "Before confirm", slug: `qui56-${id}`, createdAt: new Date() } })
  await ensureTestMembership(id, `qui56-${id}`)
  return id
}
async function caller(id: string) {
  vi.resetModules()
  const { appRouter } = await import("../../router")
  const runtime = await import("../../../lib/runtime/extensions")
  runtime.setRuntimeExtensions([{ id: "v2-test", resolveCapabilities: () => ({ onboardingV2: { enabled: true } }) }])
  return appRouter.createCaller({ session: { user: { id: `qui56-${id}`, name: "Test User", email: "signup@example.test" }, session: { activeOrganizationId: id } } } as never)
}

;(hasTestDatabase ? describe : describe.skip)("onboarding v2 confirmation", () => {
  beforeEach(() => { bootstrapQuitsRuntime({}); vi.stubEnv("QUITS_DISTRIBUTION", "cloud") })
  afterEach(async () => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    setRuntimeExtensions([])
    for (const id of ids.splice(0)) await cleanupTestOrganizations({ where: { id } })
  })
  it("reads Danish defaults without persisting anything and saves the complete summary", async () => {
    const id = await organization()
    const api = await caller(id)
    expect(await api.onboarding.getDefaultsV2()).toMatchObject({ countryCode: "DK", country: "Danmark", defaultCurrency: "DKK", taxRate: 25, pricesIncludeTax: false })
    expect(await api.onboarding.getStatus()).toMatchObject({ status: "not_started", bankMissing: true, values: { countryCode: "DK", locale: "da-DK", defaultCurrency: "DKK" } })
    expect(await prisma.orgSettings.count({ where: { organizationId: id } })).toBe(0)
    const result = await api.onboarding.confirmV2({ ...summary(), invoiceNextNum: 42, bank: { regNumber: "1234", accountNumber: "000123" } })
    expect(result).toMatchObject({ status: "complete", version: 2, bankMissing: false })
    const settings = await prisma.orgSettings.findUniqueOrThrow({ where: { organizationId: id } })
    expect(settings).toMatchObject({ companyName: "Synthetic Test ApS", companyAddress: "Testvej 1, 2. th.\n1000 København", countryCode: "DK", defaultCurrency: "DKK", currency: "DKK", baseCurrency: "DKK", locale: "da-DK", timezone: "Europe/Copenhagen", taxRegime: "eu_vat", pricesIncludeTax: false, paymentTermsDays: 14, invoicePrefix: "2026", invoiceNextNum: 42, bankAccountHolder: "Synthetic Test ApS", bankRegNumber: "1234", bankAccountNumber: "000123", companyEmail: "signup@example.test", onboardingStatus: "complete", onboardingMethod: "cvr", onboardingVersion: 2 })
    expect(settings.taxRate?.toString()).toBe("25")
    expect(await prisma.organization.findUniqueOrThrow({ where: { id } })).toMatchObject({ name: "Synthetic Test ApS" })
    expect(await prisma.organizationTaxId.findMany({ where: { organizationId: id }, orderBy: { scheme: "asc" }, select: { scheme: true, value: true, countryCode: true, isPrimary: true } })).toEqual([
      { scheme: "cvr", value: "24256790", countryCode: "DK", isPrimary: true },
      { scheme: "vat", value: "DK24256790", countryCode: "DK", isPrimary: false },
    ])
  })
  it("serializes double submits, returns the original response, and never writes on retry", async () => {
    const id = await organization()
    const input = confirmOnboardingV2Schema.parse(summary())
    const [first, second] = await Promise.all([confirmOnboardingV2(id, input, "signup@example.test"), confirmOnboardingV2(id, input, "signup@example.test")])
    expect(second).toEqual(first)
    const before = await prisma.orgSettings.findUniqueOrThrow({ where: { organizationId: id } })
    const taxIds = await prisma.organizationTaxId.findMany({ where: { organizationId: id } })
    // A retry still returns its receipt after settings edits and does not reset them.
    await prisma.orgSettings.update({ where: { organizationId: id }, data: { invoiceNextNum: 8 } })
    const edited = await prisma.orgSettings.findUniqueOrThrow({ where: { organizationId: id } })
    expect(await confirmOnboardingV2(id, { ...input, companyName: "Changed retry" }, "signup@example.test")).toEqual(first)
    expect(await prisma.orgSettings.findUniqueOrThrow({ where: { organizationId: id } })).toEqual(edited)
    expect(await prisma.organizationTaxId.findMany({ where: { organizationId: id } })).toEqual(taxIds)
    expect(before.onboardingCompletedAt?.toISOString()).toBe(first.status === "complete" ? first.completedAt : null)
    expect(await confirmOnboardingV2(id, { ...input, idempotencyKey: randomUUID() }, "signup@example.test")).toEqual({ status: "already_complete" })
    expect(await prisma.orgSettings.findUniqueOrThrow({ where: { organizationId: id } })).toEqual(edited)
  })
  it.each([false, true])("rolls back a mid-transaction failure with existing settings %s", async existing => {
    const id = await organization()
    if (existing) {
      await prisma.orgSettings.create({ data: { organizationId: id, companyName: "Original", bankRegNumber: "9999", bankAccountNumber: "1" } })
      await prisma.organizationTaxId.create({ data: { organizationId: id, scheme: "cvr", value: "Old value", isPrimary: true } })
    }
    const settingsBefore = await prisma.orgSettings.findUnique({ where: { organizationId: id } })
    const taxBefore = await prisma.organizationTaxId.findMany({ where: { organizationId: id } })
    // Fail the tax-ID insert after the organization/settings writes, inside PostgreSQL.
    // The constraint applies only to this fixture's UUID and is removed even if the test fails.
    const constraint = `qui56_fail_${id.replaceAll("-", "")}`
    await prisma.$executeRawUnsafe(`ALTER TABLE organization_tax_id ADD CONSTRAINT "${constraint}" CHECK ("organizationId" <> '${id}' OR value <> '24256790') NOT VALID`)
    try {
      await expect(confirmOnboardingV2(id, confirmOnboardingV2Schema.parse(summary()), "signup@example.test")).rejects.toThrow()
    } finally {
      await prisma.$executeRawUnsafe(`ALTER TABLE organization_tax_id DROP CONSTRAINT "${constraint}"`)
    }
    expect(await prisma.orgSettings.findUnique({ where: { organizationId: id } })).toEqual(settingsBefore)
    expect(await prisma.organizationTaxId.findMany({ where: { organizationId: id } })).toEqual(taxBefore)
    expect(await prisma.organization.findUniqueOrThrow({ where: { id } })).toMatchObject({ name: "Before confirm" })
    expect(await confirmOnboardingV2(id, confirmOnboardingV2Schema.parse(summary()), "signup@example.test")).toMatchObject({ status: "complete" })
  })
  it("saves the manual non-VAT path with optional bank and contacts and keeps the reminder", async () => {
    const id = await organization()
    const api = await caller(id)
    const input = { ...summary(), source: "manual" as const, momsRegistered: false, vatId: undefined, companyForm: "Enkeltmandsvirksomhed", companyEmail: null, companyPhone: null }
    expect(await api.onboarding.confirmV2(input)).toMatchObject({ status: "complete", bankMissing: true })
    const settings = await prisma.orgSettings.findUniqueOrThrow({ where: { organizationId: id } })
    expect(settings).toMatchObject({ bankRegNumber: null, bankAccountNumber: null, bankAccountHolder: null, bankIban: null, companyEmail: null, companyPhone: null, onboardingInvoicingIdentity: "individual", onboardingMethod: "manual", paymentNote: "Virksomheden er ikke momsregistreret.", baseCurrency: "DKK" })
    expect(settings.taxRate?.toString()).toBe("0")
    expect(await api.onboarding.getStatus()).toMatchObject({ isComplete: true, missing: [], bankMissing: true })
  })
  it("rejects invalid payloads before any persistence", async () => {
    const id = await organization()
    const api = await caller(id)
    await expect(api.onboarding.confirmV2({ ...summary(), cvr: "12345678" })).rejects.toMatchObject({ code: "BAD_REQUEST" })
    await expect(api.onboarding.confirmV2({ ...summary(), bank: { regNumber: "1234", accountNumber: "12345678901" } })).rejects.toMatchObject({ code: "BAD_REQUEST" })
    expect(await prisma.orgSettings.count({ where: { organizationId: id } })).toBe(0)
    expect(await prisma.organizationTaxId.count({ where: { organizationId: id } })).toBe(0)
  })
  it("saves only accepted invoice-line suggestions once in the same transaction", async () => {
    const id = await organization()
    const input = confirmOnboardingV2Schema.parse({ ...summary(), catalogSuggestions: [{ name: "Designarbejde", defaultUnitPrice: 850 }] })
    const first = await confirmOnboardingV2(id, input, "signup@example.test")
    expect(await confirmOnboardingV2(id, input, "signup@example.test")).toEqual(first)
    expect(await prisma.catalogItem.count({ where: { organizationId: id } })).toBe(1)
    expect(await prisma.catalogItem.findFirstOrThrow({ where: { organizationId: id } })).toMatchObject({ name: "Designarbejde", isActive: true })
  })
  it("rolls back identity and settings when accepted suggestions fail to save", async () => {
    const id = await organization()
    await prisma.catalogItem.create({ data: { organizationId: id, name: "Designarbejde", defaultUnitPrice: 1 } })
    const input = confirmOnboardingV2Schema.parse({ ...summary(), catalogSuggestions: [{ name: "Designarbejde", defaultUnitPrice: 850 }] })
    await expect(confirmOnboardingV2(id, input, "signup@example.test")).rejects.toMatchObject({ code: "P2002" })
    expect(await prisma.orgSettings.count({ where: { organizationId: id } })).toBe(0)
    expect(await prisma.organizationTaxId.count({ where: { organizationId: id } })).toBe(0)
    expect(await prisma.organization.findUniqueOrThrow({ where: { id } })).toMatchObject({ name: "Before confirm" })
    expect(await prisma.catalogItem.count({ where: { organizationId: id } })).toBe(1)
  })
  it("requires both cloud distribution and an explicit extension flag", async () => {
    const id = await organization()
    const api = await caller(id)
    const runtime = await import("../../../lib/runtime/extensions")
    runtime.setRuntimeExtensions([])
    await expect(api.onboarding.confirmV2(summary())).rejects.toMatchObject({ code: "FORBIDDEN" })
    setRuntimeExtensions([{ id: "enabled", resolveCapabilities: () => ({ onboardingV2: { enabled: true } }) }])
    expect(getRuntimeCapabilities({ QUITS_DISTRIBUTION: "selfhost" }).onboardingV2?.enabled).toBe(false)
    vi.stubEnv("QUITS_DISTRIBUTION", "selfhost")
    await expect(api.onboarding.confirmV2(summary())).rejects.toMatchObject({ code: "FORBIDDEN" })
    expect(await prisma.orgSettings.count({ where: { organizationId: id } })).toBe(0)
  })
})
