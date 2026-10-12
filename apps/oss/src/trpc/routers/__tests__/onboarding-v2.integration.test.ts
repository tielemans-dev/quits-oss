import { newDraft, confirmationPayload } from "../../../components/onboarding-v2/draft"
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
const summary = (): ConfirmOnboardingV2Input => ({ idempotencyKey: randomUUID(), companyName: "Synthetic Test ApS", companyAddress: "Testvej 1, 2. th.\n1000 København", cvr: "24256790", companyForm: "ApS", reklamebeskyttet: false, momsRegistered: true, vatId: "DK24256790" })
async function organization() {
  const id = randomUUID()
  ids.push(id)
  await prisma.organization.create({ data: { id, name: "Before confirm", slug: `qui56-${id}`, createdAt: new Date() } })
  await ensureTestMembership(id, `qui56-${id}`)
  return id
}
async function caller(id: string, requestedOrganizationId?: string) {
  vi.resetModules()
  const { appRouter } = await import("../../router")
  const runtime = await import("../../../lib/runtime/extensions")
  runtime.setRuntimeExtensions([{ id: "v2-test", resolveCapabilities: () => ({ onboardingV2: { enabled: true, nonVatEnabled: true }, onboardingAi: { enabled: true, managed: true } }) }])
  return appRouter.createCaller({ requestedOrganizationId, session: { user: { id: `qui56-${id}`, name: "Test User", email: "signup@example.test" }, session: { activeOrganizationId: id } } } as never)
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
    expect(settings).toMatchObject({ companyName: "Synthetic Test ApS", companyAddress: "Testvej 1, 2. th.\n1000 København", countryCode: "DK", defaultCurrency: "DKK", currency: "DKK", baseCurrency: "DKK", locale: "da-DK", timezone: "Europe/Copenhagen", taxRegime: "eu_vat", pricesIncludeTax: false, paymentTermsDays: 14, invoicePrefix: new Intl.DateTimeFormat("en", { year: "numeric", timeZone: "Europe/Copenhagen" }).format(new Date()), invoiceNextNum: 42, bankAccountHolder: "Synthetic Test ApS", bankRegNumber: "1234", bankAccountNumber: "000123", companyEmail: "signup@example.test", onboardingStatus: "complete", onboardingMethod: "cvr", onboardingVersion: 2 })
    expect(settings.taxRate?.toString()).toBe("25")
    expect(await prisma.organization.findUniqueOrThrow({ where: { id } })).toMatchObject({ name: "Synthetic Test ApS" })
    expect(await prisma.organizationTaxId.findMany({ where: { organizationId: id }, orderBy: { scheme: "asc" }, select: { scheme: true, value: true, countryCode: true, isPrimary: true } })).toEqual([
      { scheme: "cvr", value: "24256790", countryCode: "DK", isPrimary: true },
      { scheme: "vat", value: "DK24256790", countryCode: "DK", isPrimary: false },
    ])
  })
  it.each(["nonmember", "organization-mismatch", "denied-permission"])("rejects %s without saving confirmation", async scenario => {
    const id = await organization()
    if (scenario === "nonmember") await prisma.member.deleteMany({ where: { organizationId: id } })
    if (scenario === "denied-permission") await prisma.member.updateMany({ where: { organizationId: id }, data: { role: "accountant" } })
    const otherId = scenario === "organization-mismatch" ? await organization() : undefined
    const api = await caller(id, otherId)
    await expect(api.onboarding.confirmV2(summary())).rejects.toMatchObject({ code: scenario === "organization-mismatch" ? "CONFLICT" : "FORBIDDEN" })
    expect(await prisma.orgSettings.count({ where: { organizationId: { in: [id, ...(otherId ? [otherId] : [])] } } })).toBe(0)
    expect(await prisma.organizationTaxId.count({ where: { organizationId: id } })).toBe(0)
    expect(await prisma.organization.findUniqueOrThrow({ where: { id } })).toMatchObject({ name: "Before confirm" })
  })
  it.each([true, false])("persists the review registration choice %s for CVR and manual input", async momsRegistered => {
    for (const source of ["cvr", "manual"] as const) {
      const id = await organization()
      const api = await caller(id)
      const draft = newDraft(null, "signup@example.test", false)
      draft.source = source
      Object.assign(draft.values, {
        companyName: "Edited review", companyAddress: "Testvej 1, København",
        cvr: source === "cvr" ? "24256790" : "", momsRegistered,
        invoicePrefix: "REVIEW", defaultCurrency: "EUR", paymentTermsDays: 30,
      })
      await api.onboarding.confirmV2(confirmOnboardingV2Schema.parse(confirmationPayload(draft)))
      expect(await prisma.orgSettings.findUniqueOrThrow({ where: { organizationId: id } })).toMatchObject({
        momsRegistered, onboardingMethod: source, invoicePrefix: "REVIEW",
        defaultCurrency: "EUR", currency: "EUR", baseCurrency: "EUR", paymentTermsDays: 30,
      })
      const saved = await api.settings.get()
      expect(saved.momsRegistered).toBe(momsRegistered)
      expect(Number(saved.taxRate)).toBe(momsRegistered ? 25 : 0)
      expect(await prisma.organizationTaxId.count({ where: { organizationId: id, scheme: "vat" } })).toBe(source === "cvr" && momsRegistered ? 1 : 0)
    }
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
    expect(settings).toMatchObject({ bankRegNumber: null, bankAccountNumber: null, bankAccountHolder: null, bankIban: null, companyEmail: null, companyPhone: null, onboardingInvoicingIdentity: "individual", onboardingMethod: "manual", paymentNote: "Der er ikke beregnet moms, da sælger ikke er momsregistreret.", baseCurrency: "DKK" })
    expect(settings.taxRate?.toString()).toBe("0")
    expect(await api.onboarding.getStatus()).toMatchObject({ isComplete: true, missing: [], bankMissing: true })
  })
  it("saves edited summary defaults in the confirmation transaction", async () => {
    const id = await organization()
    const api = await caller(id)
    const result = await api.onboarding.confirmV2({ ...summary(), settings: {
      countryCode: "DK", defaultCurrency: "EUR", locale: "en-GB", timezone: "Europe/London", taxRate: 20,
      pricesIncludeTax: true, invoicePrefix: "TEST", paymentTermsDays: 30,
    } })
    expect(result.status).toBe("complete")
    const settings = await prisma.orgSettings.findUniqueOrThrow({ where: { organizationId: id } })
    expect(settings).toMatchObject({ currency: "EUR", baseCurrency: "EUR", defaultCurrency: "EUR", locale: "en-GB", timezone: "Europe/London", pricesIncludeTax: true, invoicePrefix: "TEST", paymentTermsDays: 30 })
    expect(settings.taxRate?.toString()).toBe("20")
    expect(await api.paymentDetails.firstSendReadiness()).toEqual({ bankMissing: true })
  })
  it("manual fallback can complete without registry facts, including a CVR number", async () => {
    const id = await organization()
    const api = await caller(id)
    expect(await api.onboarding.confirmV2({ ...summary(), source: "manual", cvr: "", vatId: undefined })).toMatchObject({ status: "complete" })
    expect(await prisma.organizationTaxId.count({ where: { organizationId: id } })).toBe(0)
    expect(await api.onboarding.getStatus()).toMatchObject({ isComplete: true, missing: [] })
  })
  it("does not nudge when the optional bank account is present", async () => {
    const id = await organization()
    const api = await caller(id)
    await api.onboarding.confirmV2({ ...summary(), bank: { regNumber: "1234", accountNumber: "1" } })
    expect(await api.paymentDetails.firstSendReadiness()).toEqual({ bankMissing: false })
  })
  it("rejects invalid payloads before any persistence", async () => {
    const id = await organization()
    const api = await caller(id)
    await expect(api.onboarding.confirmV2({ ...summary(), cvr: "12345678" })).rejects.toMatchObject({ code: "BAD_REQUEST", message: "cvr.invalid" })
    await expect(api.onboarding.confirmV2({ ...summary(), bank: { regNumber: "1234", accountNumber: "12345678901" } })).rejects.toMatchObject({ code: "BAD_REQUEST", message: "save.failed" })
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
  it("injects a read-only CVR provider and hides it without a provider", async () => {
    const id = await organization()
    const api = await caller(id)
    const services = await import("../../../lib/runtime/services")
    expect(await api.cvr.available()).toEqual({ enabled: false, suggestions: false })
    const company = { cvr: "24256790", name: "Test ApS", address: "Testvej 1\n1000 København", companyForm: "ApS", momsRegistered: true, status: "active" as const, statusClass: "active" as const }
    const search = vi.fn(async () => [company])
    services.setRuntimeServices({ cvrLookupProvider: { search, get: async () => company } })
    try {
      expect(await api.cvr.available()).toEqual({ enabled: true, suggestions: false })
      expect(await api.cvr.search({ q: "Test" })).toEqual([company])
      expect(await api.cvr.get({ cvr: "24256790" })).toEqual(company)
      expect(search.mock.calls[0]).toMatchObject(["Test", { userId: `qui56-${id}`, organizationId: id }])
      expect(await prisma.orgSettings.count({ where: { organizationId: id } })).toBe(0)
      expect(await prisma.organizationTaxId.count({ where: { organizationId: id } })).toBe(0)
    } finally { services.resetRuntimeServices() }
  })
  it("replaces mixed-case and duplicate registration IDs while preserving unrelated schemes", async () => {
    const id = await organization()
    await prisma.organizationTaxId.createMany({ data: ["CVR", "cVr", "VAT", "vAt", "Dk_CvR", "dK_VaT", "customer_ref"].map(scheme => ({ organizationId: id, scheme, value: "old", isPrimary: true })) })
    await confirmOnboardingV2(id, confirmOnboardingV2Schema.parse(summary()), "signup@example.test")
    const identifiers = await prisma.organizationTaxId.findMany({ where: { organizationId: id }, orderBy: { scheme: "asc" } })
    expect(identifiers.map(({ scheme, value }) => ({ scheme, value }))).toEqual([
      { scheme: "customer_ref", value: "old" }, { scheme: "cvr", value: "24256790" }, { scheme: "vat", value: "DK24256790" },
    ])
  })
  it.each([["failure", false], ["failure", true], ["timeout", false], ["timeout", true]] as const)("leaves trial %s incomplete with existing settings %s, provisions on retry, and skips completed retries", async (failure, existing) => {
    const id = await organization()
    const api = await caller(id)
    const { setRuntimeServices } = await import("../../../lib/runtime/services")
    if (existing) await prisma.orgSettings.create({ data: { organizationId: id, companyName: "Original incomplete", onboardingStatus: "in_progress", onboardingVersion: 1 } })
    const before = await prisma.orgSettings.findUnique({ where: { organizationId: id } })
    const failureError = failure === "timeout" ? new DOMException("Trial unavailable", "TimeoutError") : new Error("Trial unavailable")
    const startTrial = vi.fn().mockRejectedValueOnce(failureError).mockResolvedValue(undefined)
    setRuntimeServices({ billingProvider: { startTrial, getSubscription: async () => ({ status: "trialing", priceId: null }), assertInvoiceCreationAllowed: async () => {} } })
    const input = summary()
    await expect(api.onboarding.confirmV2(input)).rejects.toThrow("Trial unavailable")
    expect(await prisma.orgSettings.findUnique({ where: { organizationId: id } })).toEqual(before)
    expect(await prisma.organization.findUniqueOrThrow({ where: { id } })).toMatchObject({ name: "Before confirm" })
    expect(await api.onboarding.getStatus()).toMatchObject({ isComplete: false })
    const [result, concurrent] = await Promise.all([api.onboarding.confirmV2(input), api.onboarding.confirmV2(input)])
    expect(concurrent).toEqual(result)
    expect(result.status).toBe("complete")
    expect(await api.onboarding.confirmV2(input)).toEqual(result)
    expect(await api.onboarding.confirmV2({ ...input, idempotencyKey: randomUUID() })).toEqual({ status: "already_complete" })
    expect(startTrial).toHaveBeenCalledTimes(2)
  })
  it("reuses provider-owned provisioning after a confirmation write rolls back", async () => {
    const id = await organization()
    const api = await caller(id)
    const { setRuntimeServices } = await import("../../../lib/runtime/services")
    // MOCK: provider contract fixture retains durable provisioning across OSS rollbacks.
    const provisioned = new Set<string>()
    const provision = vi.fn()
    const startTrial = vi.fn(async (organizationId: string) => {
      if (!provisioned.has(organizationId)) { provisioned.add(organizationId); provision(organizationId) }
    })
    setRuntimeServices({ billingProvider: { startTrial, getSubscription: async () => ({ status: "trialing", priceId: null }), assertInvoiceCreationAllowed: async () => {} } })
    const input = summary()
    const constraint = `qui56_trial_${id.replaceAll("-", "")}`
    await prisma.$executeRawUnsafe(`ALTER TABLE organization_tax_id ADD CONSTRAINT "${constraint}" CHECK ("organizationId" <> '${id}') NOT VALID`)
    try { await expect(api.onboarding.confirmV2(input)).rejects.toThrow() }
    finally { await prisma.$executeRawUnsafe(`ALTER TABLE organization_tax_id DROP CONSTRAINT "${constraint}"`) }
    expect(await prisma.orgSettings.findUnique({ where: { organizationId: id } })).toBeNull()
    expect(await api.onboarding.confirmV2(input)).toMatchObject({ status: "complete" })
    expect(startTrial).toHaveBeenCalledTimes(2)
    expect(provision).toHaveBeenCalledTimes(1)
  })
  it("rolls back an expired confirmation transaction and reuses provisioning on retry", async () => {
    const id = await organization()
    const api = await caller(id)
    await prisma.orgSettings.create({ data: { organizationId: id, companyName: "Original incomplete", onboardingStatus: "in_progress", onboardingVersion: 1 } })
    const before = await prisma.orgSettings.findUniqueOrThrow({ where: { organizationId: id } })
    const { setRuntimeServices } = await import("../../../lib/runtime/services")
    // MOCK: a durable provider provision succeeds once, but its first response exceeds
    // the real PostgreSQL/Prisma confirmation deadline. No external billing requests run.
    const provisioned = new Set<string>()
    const provision = vi.fn()
    const startTrial = vi.fn(async (organizationId: string) => {
      if (!provisioned.has(organizationId)) {
        provisioned.add(organizationId)
        provision(organizationId)
        await new Promise(resolve => setTimeout(resolve, 60_050))
      }
    })
    setRuntimeServices({ billingProvider: { startTrial, getSubscription: async () => ({ status: "trialing", priceId: null }), assertInvoiceCreationAllowed: async () => {} } })
    const input = summary()
    await expect(api.onboarding.confirmV2(input)).rejects.toThrow(/expired|closed|timeout/i)
    expect(await prisma.orgSettings.findUniqueOrThrow({ where: { organizationId: id } })).toEqual(before)
    expect(await prisma.organization.findUniqueOrThrow({ where: { id } })).toMatchObject({ name: "Before confirm" })
    expect(await api.onboarding.getStatus()).toMatchObject({ isComplete: false })
    expect(await api.onboarding.confirmV2(input)).toMatchObject({ status: "complete" })
    expect(startTrial).toHaveBeenCalledTimes(2)
    expect(provision).toHaveBeenCalledTimes(1)
  }, 75_000)
  it.each(["saveDraft", "complete", "completeManual"].flatMap(mutation => [false, true].map(existing => [mutation, existing] as const)))("serializes %s behind v2 with existing settings %s and preserves identifiers", async (mutation, existing) => {
    const id = await organization()
    const api = await caller(id)
    if (existing) await api.onboarding.saveDraft({ primaryTaxId: null, companyName: "Original", companyAddress: "Testvej 1", companyEmail: "test@example.test", countryCode: "DK", invoicingIdentity: "individual", locale: "da-DK", timezone: "Europe/Copenhagen", defaultCurrency: "DKK", taxRegime: "eu_vat", invoicePrefix: "INV", quotePrefix: "QTE" })
    const { setRuntimeServices } = await import("../../../lib/runtime/services")
    let entered!: () => void
    let release!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const blocked = new Promise<void>(resolve => { release = resolve })
    // MOCK: test-only lifecycle barrier holds the real confirmation transaction open.
    const startTrial = vi.fn(async () => { entered(); await blocked })
    setRuntimeServices({ billingProvider: { startTrial, getSubscription: async () => ({ status: "trialing", priceId: null }), assertInvoiceCreationAllowed: async () => {} } })
    const v2 = api.onboarding.confirmV2({ ...summary(), source: "manual", companyEmail: null })
    await started
    const mutate = () => mutation === "saveDraft"
      ? api.onboarding.saveDraft({ primaryTaxId: null, companyName: "Stale company" })
      : mutation === "complete" ? api.onboarding.complete({ profile: "enterprise" })
      : api.onboarding.completeManual({ method: "ai" })
    const legacy = mutate()
    try {
      // Verify the real legacy transaction is waiting on our organization lock.
      await vi.waitFor(async () => {
        const [row] = await prisma.$queryRaw<[{ waiting: boolean }]>`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%organization%' AND pid <> pg_backend_pid()) AS waiting`
        expect(row.waiting).toBe(true)
      })
    } finally { release() }
    const [confirmation, response] = await Promise.all([v2, legacy])
    expect(response).toMatchObject({ version: 2, isComplete: true, missing: [] })
    const settings = await prisma.orgSettings.findUniqueOrThrow({ where: { organizationId: id } })
    const taxIds = await prisma.organizationTaxId.findMany({ where: { organizationId: id }, orderBy: { scheme: "asc" } })
    expect(taxIds.map(tax => tax.scheme)).toEqual(["cvr", "vat"])
    expect(settings).toMatchObject({ onboardingVersion: 2, companyName: "Synthetic Test ApS", companyEmail: null })
    expect(settings.onboardingCompletedAt?.toISOString()).toBe(confirmation.status === "complete" ? confirmation.completedAt : null)
    expect(await mutate()).toMatchObject({ version: 2, isComplete: true, missing: [] })
    expect(await prisma.orgSettings.findUniqueOrThrow({ where: { organizationId: id } })).toEqual(settings)
    expect(await prisma.organizationTaxId.findMany({ where: { organizationId: id }, orderBy: { scheme: "asc" } })).toEqual(taxIds)
    expect(startTrial).toHaveBeenCalledTimes(1)
  })
  it("rolls back legacy draft settings when identifier persistence fails", async () => {
    const id = await organization()
    const api = await caller(id)
    await api.onboarding.saveDraft({ companyName: "Original", primaryTaxId: "Original ID" })
    const settings = await prisma.orgSettings.findUniqueOrThrow({ where: { organizationId: id } })
    const taxIds = await prisma.organizationTaxId.findMany({ where: { organizationId: id } })
    const constraint = `qui56_draft_${id.replaceAll("-", "")}`
    await prisma.$executeRawUnsafe(`ALTER TABLE organization_tax_id ADD CONSTRAINT "${constraint}" CHECK ("organizationId" <> '${id}' OR value <> 'Rejected ID') NOT VALID`)
    try { await expect(api.onboarding.saveDraft({ companyName: "Must roll back", primaryTaxId: "Rejected ID" })).rejects.toThrow() }
    finally { await prisma.$executeRawUnsafe(`ALTER TABLE organization_tax_id DROP CONSTRAINT "${constraint}"`) }
    expect(await prisma.orgSettings.findUniqueOrThrow({ where: { organizationId: id } })).toEqual(settings)
    expect(await prisma.organizationTaxId.findMany({ where: { organizationId: id } })).toEqual(taxIds)
  })
  it.each([true, false, undefined])("scrubs registry contacts when protection metadata is %s", async reklamebeskyttet => {
    const id = await organization()
    const api = await caller(id)
    await api.onboarding.confirmV2({ ...summary(), reklamebeskyttet, companyEmail: "protected@example.test", companyPhone: "12345678" })
    expect(await prisma.orgSettings.findUniqueOrThrow({ where: { organizationId: id } })).toMatchObject({ companyEmail: "signup@example.test", companyPhone: null })
  })
  it("allows manually entered contacts", async () => {
    const id = await organization()
    const api = await caller(id)
    await api.onboarding.confirmV2({ ...summary(), source: "manual", reklamebeskyttet: false, companyEmail: "public@example.test", companyPhone: "12345678" })
    expect(await prisma.orgSettings.findUniqueOrThrow({ where: { organizationId: id } })).toMatchObject({ companyEmail: "public@example.test", companyPhone: "12345678" })
  })
  it("confirms when the runtime trial hook is absent", async () => {
    const id = await organization()
    const api = await caller(id)
    const { setRuntimeServices } = await import("../../../lib/runtime/services")
    setRuntimeServices({ billingProvider: { getSubscription: async () => ({ status: "free", priceId: null }), assertInvoiceCreationAllowed: async () => {} } })
    expect(await api.onboarding.confirmV2(summary())).toMatchObject({ status: "complete" })
  })
  it("rejects hosted non-VAT confirmation and settings changes until the runtime opts in", async () => {
    const id = await organization()
    const api = await caller(id)
    const runtime = await import("../../../lib/runtime/extensions")
    runtime.setRuntimeExtensions([{ id: "v2-only", resolveCapabilities: () => ({ onboardingV2: { enabled: true } }) }])
    const input = { ...summary(), source: "manual" as const, momsRegistered: false, vatId: undefined }
    await expect(api.onboarding.confirmV2(input)).rejects.toMatchObject({ code: "FORBIDDEN", message: "save.failed" })
    await expect(api.settings.update({ momsRegistered: false })).rejects.toMatchObject({ code: "FORBIDDEN", message: "save.failed" })
    expect(await prisma.orgSettings.count({ where: { organizationId: id } })).toBe(0)
    runtime.setRuntimeExtensions([{ id: "v2-non-vat", resolveCapabilities: () => ({ onboardingV2: { enabled: true, nonVatEnabled: true } }) }])
    expect(await api.onboarding.confirmV2(input)).toMatchObject({ status: "complete" })
    expect(await api.settings.update({ momsRegistered: false })).toBeDefined()
  })
  it("allows self-hosted registration and custom VAT rates without a hosted opt-in", async () => {
    const id = await organization()
    vi.stubEnv("QUITS_DISTRIBUTION", "selfhost")
    const api = await caller(id)
    const runtime = await import("../../../lib/runtime/extensions")
    runtime.setRuntimeExtensions([])
    await api.settings.update({ momsRegistered: false, taxRate: 0 })
    await api.settings.update({ momsRegistered: true, taxRate: 17.5 })
    expect(await api.settings.get()).toMatchObject({ momsRegistered: true, taxRate: 17.5 })
  })
  it("serializes confirmation behind a legacy completion without resetting the legacy receipt", async () => {
    const id = await organization()
    const api = await caller(id)
    await api.onboarding.saveDraft({ primaryTaxId: null, companyName: "Original", companyAddress: "Testvej 1", companyEmail: "test@example.test", countryCode: "DK", invoicingIdentity: "individual", locale: "da-DK", timezone: "Europe/Copenhagen", defaultCurrency: "DKK", taxRegime: "eu_vat", invoicePrefix: "INV", quotePrefix: "QTE" })
    const { setRuntimeServices } = await import("../../../lib/runtime/services")
    let entered!: () => void
    let release!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const blocked = new Promise<void>(resolve => { release = resolve })
    // MOCK: hold the legacy trial hook inside the real serialized transaction.
    const startTrial = vi.fn(async () => { entered(); await blocked })
    setRuntimeServices({ billingProvider: { startTrial, getSubscription: async () => ({ status: "trialing", priceId: null }), assertInvoiceCreationAllowed: async () => {} } })
    const legacy = api.onboarding.completeManual({ method: "manual" })
    await started
    const v2 = api.onboarding.confirmV2(summary())
    try {
      await vi.waitFor(async () => {
        const [row] = await prisma.$queryRaw<[{ waiting: boolean }]>`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%organization%' AND pid <> pg_backend_pid()) AS waiting`
        expect(row.waiting).toBe(true)
      })
    } finally { release() }
    const [receipt, confirmation] = await Promise.all([legacy, v2])
    expect(confirmation).toEqual({ status: "already_complete" })
    expect(await api.onboarding.getStatus()).toEqual(receipt)
    expect(startTrial).toHaveBeenCalledTimes(1)

  })
  it("uses current-year defaults for a fresh confirmation but preserves an existing numbering book", async () => {
    const api = await caller(await organization())
    vi.spyOn(Intl, "DateTimeFormat").mockReturnValue({ format: () => "2027" } as Intl.DateTimeFormat)
    expect(await api.onboarding.getDefaultsV2()).toMatchObject({ invoicePrefix: "2027" })
    await api.onboarding.confirmV2(summary())
    expect(await api.settings.get()).toMatchObject({ invoicePrefix: "2027", invoiceNextNum: 1 })
    const id = await organization()
    await prisma.orgSettings.create({ data: { organizationId: id, invoicePrefix: "CUSTOM", invoiceNextNum: 57, quotePrefix: "OFFER", quoteNextNum: 19 } })
    const draft = newDraft(null, "signup@example.test", false)
    Object.assign(draft.values, { companyName: "Edited review", companyAddress: "Testvej 1", invoicePrefix: "RESET", invoiceNextNum: 1 })
    await confirmOnboardingV2(id, confirmOnboardingV2Schema.parse(confirmationPayload(draft)), "signup@example.test")
    expect(await prisma.orgSettings.findUniqueOrThrow({ where: { organizationId: id } })).toMatchObject({ invoicePrefix: "CUSTOM", invoiceNextNum: 57, quotePrefix: "OFFER", quoteNextNum: 19 })
  })
  it.each([false, true])("serializes AI patches after confirmation with existing settings %s", async existing => {
    const id = await organization()
    const api = await caller(id)
    if (existing) await api.onboarding.saveDraft({ companyName: "Original", primaryTaxId: "Original ID" })
    const { setRuntimeServices } = await import("../../../lib/runtime/services")
    let entered!: () => void
    let release!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const blocked = new Promise<void>(resolve => { release = resolve })
    setRuntimeServices({ billingProvider: { startTrial: async () => { entered(); await blocked }, getSubscription: async () => ({ status: "trialing", priceId: null }), assertInvoiceCreationAllowed: async () => {} } })
    const v2 = api.onboarding.confirmV2(summary())
    await started
    const patch = { source: "ai" as const, patch: { companyName: "Stale AI", primaryTaxId: "Stale ID" } }
    // Attach rejection handling before releasing the confirmation transaction.
    const ai = expect(api.onboardingAi.applyOnboardingPatch(patch)).rejects.toMatchObject({ code: "CONFLICT" })
    try {
      await vi.waitFor(async () => {
        const [row] = await prisma.$queryRaw<[{ waiting: boolean }]>`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%organization%' AND pid <> pg_backend_pid()) AS waiting`
        expect(row.waiting).toBe(true)
      })
    } finally { release() }
    await Promise.all([v2, ai])
    const settings = await prisma.orgSettings.findUniqueOrThrow({ where: { organizationId: id } })
    const taxIds = await prisma.organizationTaxId.findMany({ where: { organizationId: id }, orderBy: { scheme: "asc" } })
    expect(settings).toMatchObject({ companyName: "Synthetic Test ApS", onboardingStatus: "complete", onboardingVersion: 2 })
    expect(taxIds.map(({ scheme, value }) => ({ scheme, value }))).toEqual([{ scheme: "cvr", value: "24256790" }, { scheme: "vat", value: "DK24256790" }])
    await expect(api.onboardingAi.applyOnboardingPatch(patch)).rejects.toMatchObject({ code: "CONFLICT" })
    expect(await prisma.orgSettings.findUniqueOrThrow({ where: { organizationId: id } })).toEqual(settings)
    expect(await prisma.organizationTaxId.findMany({ where: { organizationId: id }, orderBy: { scheme: "asc" } })).toEqual(taxIds)
  })
  it("serializes confirmation after an AI patch including its tax identifier write", async () => {
    const id = await organization()
    const api = await caller(id)
    await api.onboarding.saveDraft({ companyName: "Original", primaryTaxId: "Original ID" })
    const name = `qui56_ai_${id.replaceAll("-", "")}`
    // A PostgreSQL advisory barrier holds the actual identifier write before commit.
    await prisma.$executeRawUnsafe(`CREATE FUNCTION "${name}"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."organizationId" = '${id}' THEN PERFORM pg_advisory_xact_lock(hashtext('${id}')); END IF; RETURN NEW; END $$`)
    await prisma.$executeRawUnsafe(`CREATE TRIGGER "${name}" BEFORE INSERT OR UPDATE ON organization_tax_id FOR EACH ROW EXECUTE FUNCTION "${name}"()`)
    let entered!: () => void
    let release!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const blocked = new Promise<void>(resolve => { release = resolve })
    const barrier = prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${id}))::text`
      entered(); await blocked
    }, { timeout: 60_000 })
    await started
    const ai = api.onboardingAi.applyOnboardingPatch({ source: "ai", patch: { companyName: "AI draft", primaryTaxId: "AI draft ID" } })
    let v2: ReturnType<typeof api.onboarding.confirmV2> | undefined
    try {
      await vi.waitFor(async () => {
        const [row] = await prisma.$queryRaw<[{ waiting: boolean }]>`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%organization_tax_id%' AND pid <> pg_backend_pid()) AS waiting`
        expect(row.waiting).toBe(true)
      })
      v2 = api.onboarding.confirmV2(summary())
      await vi.waitFor(async () => {
        const [row] = await prisma.$queryRaw<[{ waiting: boolean }]>`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%FOR NO KEY UPDATE%' AND pid <> pg_backend_pid()) AS waiting`
        expect(row.waiting).toBe(true)
      })
    } finally {
      release()
      await Promise.allSettled([barrier, ai, ...(v2 ? [v2] : [])])
      await prisma.$executeRawUnsafe(`DROP TRIGGER "${name}" ON organization_tax_id`)
      await prisma.$executeRawUnsafe(`DROP FUNCTION "${name}"()`)
    }
    await ai
    expect(await v2).toMatchObject({ status: "complete" })
    expect(await prisma.orgSettings.findUniqueOrThrow({ where: { organizationId: id } })).toMatchObject({ companyName: "Synthetic Test ApS", onboardingStatus: "complete", onboardingVersion: 2 })
    expect((await prisma.organizationTaxId.findMany({ where: { organizationId: id }, orderBy: { scheme: "asc" } })).map(({ scheme, value }) => ({ scheme, value }))).toEqual([{ scheme: "cvr", value: "24256790" }, { scheme: "vat", value: "DK24256790" }])
  })
  it("requires both cloud distribution and an explicit extension flag", async () => {
    const id = await organization()
    const api = await caller(id)
    const runtime = await import("../../../lib/runtime/extensions")
    runtime.setRuntimeExtensions([])
    await expect(api.onboarding.confirmV2(summary())).rejects.toMatchObject({ code: "FORBIDDEN" })
    setRuntimeExtensions([{ id: "enabled", resolveCapabilities: () => ({ onboardingV2: { enabled: true, nonVatEnabled: true } }) }])
    expect(getRuntimeCapabilities({ QUITS_DISTRIBUTION: "selfhost" }).onboardingV2?.enabled).toBe(false)
    vi.stubEnv("QUITS_DISTRIBUTION", "selfhost")
    await expect(api.onboarding.confirmV2(summary())).rejects.toMatchObject({ code: "FORBIDDEN" })
    expect(await prisma.orgSettings.count({ where: { organizationId: id } })).toBe(0)
  })
})
