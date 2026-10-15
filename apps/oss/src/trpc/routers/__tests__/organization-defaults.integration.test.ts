import { randomUUID } from "node:crypto"
import { Effect } from "effect"
import { afterEach, describe, expect, it, vi } from "vitest"
import { prisma } from "../../../lib/db"
import { initializeDkSettings } from "../../../lib/onboarding/initialize-settings"
import { lockArtifactOrganization } from "../../../domain/documents/artifacts"
import { loadDocumentContext } from "../../../domain/documents/context"
import { allocateDocumentNumber } from "../../../domain/documents/numbering"
import { appendEvents } from "../../../domain/events"
import { Command, Db, type CommandScope } from "../../../domain/services"
import { cleanupTestOrganizations, createTestOrganization, hasTestDatabase } from "../../../test-utils/organization"
import { ensureTestMembership } from "../../../test-utils/membership"

const ids: string[] = []
async function fixture() {
  const id = randomUUID()
  ids.push(id)
  await prisma.organization.create({ data: { id, name: "Defaults test", slug: `qui36-${id}`, createdAt: new Date() } })
  await ensureTestMembership(id, `qui36-${id}`)
  vi.resetModules()
  vi.stubEnv("QUITS_DISTRIBUTION", "cloud")
  const { appRouter } = await import("../../router")
  const api = appRouter.createCaller({ session: { user: { id: `qui36-${id}`, email: "defaults@example.test" }, session: { activeOrganizationId: id } } } as never)
  const command: CommandScope = { organizationId: id, commandId: randomUUID(), actor: { kind: "system", organizationId: id, reason: "migration", label: "Test" }, now: new Date(), approvedByUserId: null, emit() {}, enqueue() {} }
  return { id, api, command }
}

;(hasTestDatabase ? describe : describe.skip)("organization creation defaults", () => {
  afterEach(async () => {
    vi.unstubAllEnvs()
    for (const id of ids.splice(0)) await cleanupTestOrganizations({ where: { id } })
  })

  it.each([undefined, null, 0, 10])("keeps the shared US fixture's tax rate at %s", async taxRate => {
    const { organizationId } = await createTestOrganization({ settings: { taxRate } })
    ids.push(organizationId)
    const settings = await prisma.orgSettings.findUniqueOrThrow({ where: { organizationId } })

    expect(settings).toMatchObject({ countryCode: "US", taxRegime: "us_sales_tax", currency: "USD" })
    expect(settings.taxRate?.toNumber() ?? null).toBe(taxRate ?? null)
  })

  it.each(["Prisma", "SQL", "Settings", "Settings update", "initializer", "onboarding", "draft", "profile", "AI", "AI patch", "artifact", "context", "numbering", "payment", "reminders", "events"])("defaults to Danish settings through %s", async path => {
    const { id, api, command } = await fixture()
    if (path === "Prisma") await prisma.orgSettings.create({ data: { organizationId: id } })
    if (path === "SQL") await prisma.$executeRaw`INSERT INTO org_settings (id, "organizationId", "updatedAt") VALUES (${randomUUID()}, ${id}, NOW())`
    if (path === "Settings") await api.settings.get()
    if (path === "Settings update") await api.settings.update({ companyName: "New company" })
    if (path === "initializer") await initializeDkSettings(id, prisma)
    if (path === "onboarding") await api.onboarding.getStatus()
    if (path === "draft") await api.onboarding.saveDraft({ companyName: "New company", primaryTaxId: undefined })
    if (path === "profile") await api.onboarding.complete({ profile: "smb" })
    if (path === "AI") await api.onboardingAi.getOnboardingState()
    if (path === "AI patch") await api.onboardingAi.applyOnboardingPatch({ source: "manual", patch: { companyName: "New company" } })
    if (path === "artifact") await prisma.$transaction(tx => lockArtifactOrganization(tx, id))
    if (path === "context") await Effect.runPromise(loadDocumentContext.pipe(Effect.provideService(Db, prisma), Effect.provideService(Command, command)))
    if (path === "numbering") await Effect.runPromise(allocateDocumentNumber("invoice").pipe(Effect.provideService(Db, prisma), Effect.provideService(Command, command)))
    if (path === "payment") await api.paymentDetails.update({ note: "Pay on time" })
    if (path === "reminders") await api.reminders.updatePolicy({ enabled: false, offsetsDays: [7] })
    if (path === "events") await prisma.$transaction(tx => appendEvents(tx, { ...command, occurredAt: command.now, events: [{ aggregateType: "invoice", aggregateId: "synthetic", type: "invoice.draft_deleted", payload: { number: null } }] }))
    const settings = await prisma.orgSettings.findUniqueOrThrow({ where: { organizationId: id } })
    expect(settings).toMatchObject({ countryCode: "DK", locale: "da-DK", timezone: "Europe/Copenhagen", defaultCurrency: "DKK", currency: "DKK", baseCurrency: "DKK", taxRegime: "eu_vat", momsRegistered: null })
    expect(settings.taxRate?.toString()).toBe("25")
    expect(new Intl.NumberFormat(settings.locale, { style: "currency", currency: settings.currency }).format(1000)).toContain("1.000,00")
    expect(new Intl.DateTimeFormat(settings.locale, { timeZone: settings.timezone }).format(new Date("2026-10-15T12:00:00Z"))).toBe("15.10.2026")
  })

  it.each(["draft", "AI patch", "Settings"])("keeps explicit country choices through %s", async path => {
    const { id, api } = await fixture()
    const choices = { countryCode: "US", locale: "en-US", timezone: "America/New_York", defaultCurrency: "USD", taxRegime: "us_sales_tax" as const }
    if (path === "draft") await api.onboarding.saveDraft({ ...choices, primaryTaxId: undefined })
    else if (path === "Settings") await api.settings.update({ ...choices, currency: "USD" })
    else await api.onboardingAi.applyOnboardingPatch({ source: "manual", patch: choices })
    const settings = await prisma.orgSettings.findUniqueOrThrow({ where: { organizationId: id } })
    expect(settings).toMatchObject({ ...choices, currency: "USD", baseCurrency: "USD", taxRate: null })
    await prisma.orgSettings.update({ where: { organizationId: id }, data: { taxRate: 10 } })
    if (path === "draft") await api.onboarding.saveDraft({ ...choices, primaryTaxId: undefined })
    else if (path === "Settings") await api.settings.update({ ...choices, currency: "USD" })
    else await api.onboardingAi.applyOnboardingPatch({ source: "manual", patch: choices })
    expect((await prisma.orgSettings.findUniqueOrThrow({ where: { organizationId: id } })).taxRate?.toString()).toBe("10")
  })

  it.each([
    { momsRegistered: true, savedRate: 25, taxRate: undefined, expectedRate: null },
    { momsRegistered: false, savedRate: 0, taxRate: undefined, expectedRate: null },
    { momsRegistered: true, savedRate: 25, taxRate: 0, expectedRate: 0 },
    { momsRegistered: true, savedRate: 25, taxRate: 10, expectedRate: 10 },
  ])("updates an existing DK row to US with $momsRegistered registration and $taxRate explicit tax", async ({ momsRegistered, savedRate, taxRate, expectedRate }) => {
    const { id, api } = await fixture()
    const before = await prisma.orgSettings.create({ data: { organizationId: id, momsRegistered, taxRate: savedRate } })
    expect(before).toMatchObject({ countryCode: "DK", currency: "DKK", defaultCurrency: "DKK", baseCurrency: "DKK", taxRegime: "eu_vat" })
    expect(before.taxRate?.toNumber()).toBe(savedRate)

    await api.settings.update({ countryCode: "US", currency: "USD", defaultCurrency: "USD", taxRegime: "us_sales_tax", taxRate })

    const settings = await prisma.orgSettings.findUniqueOrThrow({ where: { organizationId: id } })
    expect(settings).toMatchObject({ id: before.id, countryCode: "US", currency: "USD", defaultCurrency: "USD", baseCurrency: "USD", taxRegime: "us_sales_tax", momsRegistered: null, pricesIncludeTax: false })
    expect(settings.taxRate?.toNumber() ?? null).toBe(expectedRate)
    expect(await api.settings.get()).toMatchObject({ countryCode: "US", currency: "USD", defaultCurrency: "USD", baseCurrency: "USD", taxRegime: "us_sales_tax", momsRegistered: null, taxRate: expectedRate })
  })

  it.each(["foreign", "non-VAT"])("never resets saved %s settings on initialization or reads", async scenario => {
    const { id, api } = await fixture()
    await prisma.orgSettings.create({ data: { organizationId: id, companyName: "Saved company", ...(scenario === "foreign"
      ? { countryCode: "US", locale: "en-US", currency: "USD", defaultCurrency: "USD", baseCurrency: "USD", taxRegime: "us_sales_tax", taxRate: 10 }
      : { momsRegistered: false, taxRate: 0 }) } })
    const before = await prisma.orgSettings.findUniqueOrThrow({ where: { organizationId: id } })
    await initializeDkSettings(id, prisma)
    await api.settings.get()
    await api.onboarding.getStatus()
    await api.onboardingAi.getOnboardingState()
    expect(await prisma.orgSettings.findUniqueOrThrow({ where: { organizationId: id } })).toEqual(before)
    await api.onboardingAi.applyOnboardingPatch({ source: "manual", patch: { companyName: "Saved company" } })
    expect(await prisma.orgSettings.findUniqueOrThrow({ where: { organizationId: id } })).toMatchObject({ countryCode: before.countryCode, locale: before.locale, currency: before.currency, defaultCurrency: before.defaultCurrency, baseCurrency: before.baseCurrency, taxRate: before.taxRate, momsRegistered: before.momsRegistered })
  })
})
