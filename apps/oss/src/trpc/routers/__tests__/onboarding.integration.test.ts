import { cleanupTestOrganizations } from "../../../test-utils/organization"
import "dotenv/config"
import { randomUUID } from "node:crypto"
import { afterEach, describe, expect, it, vi } from "vitest"
import { prisma } from "../../../lib/db"
import { ensureTestMembership } from "../../../test-utils/membership"

const hasDatabaseUrl = Boolean(process.env.DATABASE_URL)
const describeIfDatabase = hasDatabaseUrl ? describe : describe.skip

type CallerLike = {
  onboardingAi: {
    getOnboardingState: () => Promise<{ values: Record<string, unknown> }>
  }
  onboarding: {
    getStatus: () => Promise<{
      status: string
      isComplete: boolean
      missing: string[]
      values: Record<string, unknown>
    }>
    saveDraft: (input: Record<string, unknown>) => Promise<{
      status: string
      isComplete: boolean
      missing: string[]
      values: Record<string, unknown>
    }>
    completeManual: (input: { method?: "manual" | "ai" }) => Promise<{
      status: string
      isComplete: boolean
      missing: string[]
      values: Record<string, unknown>
    }>
  }
}

// Both RPCs expose these settings; only status includes onboardingMethod in values.
function sharedSettingsValues(values: Record<string, unknown>) {
  return {
    companyName: values.companyName,
    companyAddress: values.companyAddress,
    companyEmail: values.companyEmail,
    countryCode: values.countryCode,
    invoicingIdentity: values.invoicingIdentity,
    locale: values.locale,
    timezone: values.timezone,
    defaultCurrency: values.defaultCurrency,
    taxRegime: values.taxRegime,
    pricesIncludeTax: values.pricesIncludeTax,
    invoicePrefix: values.invoicePrefix,
    invoiceNextNum: values.invoiceNextNum,
    quotePrefix: values.quotePrefix,
    quoteNextNum: values.quoteNextNum,
    primaryTaxId: values.primaryTaxId,
    primaryTaxIdScheme: values.primaryTaxIdScheme,
  }
}

async function createCloudCaller() {
  vi.resetModules()
  process.env.QUITS_DISTRIBUTION = "cloud"

  const { appRouter } = await import("../../router")
  const { setRuntimeServices } = await import("../../../lib/runtime/services")
  setRuntimeServices({ cvrLookupProvider: {
    search: async () => [], get: async cvr => ({ cvr, name: "Synthetic business", address: "Testvej 1", companyForm: "ApS", status: "active", statusClass: "active", momsRegistered: true }),
  } })

  const orgId = randomUUID()
  const slug = `onboarding-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`

  await prisma.organization.create({
    data: {
      id: orgId,
      name: "Onboarding Org",
      slug,
      createdAt: new Date(),
      subscriptionStatus: "pro",
    },
  })
  await ensureTestMembership(orgId, "onboarding-user")

  const caller = appRouter.createCaller({
    session: {
      user: {
        id: "onboarding-user",
        email: "onboarding@example.com",
        name: "Onboarding User",
      },
      session: {
        activeOrganizationId: orgId,
      },
    },
  } as never) as unknown as CallerLike

  return {
    orgId,
    caller,
  }
}

describeIfDatabase("onboarding router integration", () => {
  afterEach(async () => {
    process.env.QUITS_DISTRIBUTION = "selfhost"
  })

  it.each(["US", "DE"])("clears the Danish rate when generic onboarding moves to %s", async countryCode => {
    const { orgId, caller } = await createCloudCaller()
    try {
      await caller.onboarding.getStatus()
      expect(Number((await prisma.orgSettings.findUniqueOrThrow({ where: { organizationId: orgId } })).taxRate)).toBe(25)
      await caller.onboarding.saveDraft({ countryCode, taxRegime: countryCode === "US" ? "us_sales_tax" : "eu_vat" })
      expect((await prisma.orgSettings.findUniqueOrThrow({ where: { organizationId: orgId } })).taxRate).toBeNull()
      await prisma.orgSettings.update({ where: { organizationId: orgId }, data: { taxRate: 19 } })
      await caller.onboarding.saveDraft({ countryCode, companyName: "Edited company" })
      expect(Number((await prisma.orgSettings.findUniqueOrThrow({ where: { organizationId: orgId } })).taxRate)).toBe(19)
      await caller.onboarding.saveDraft({ countryCode: "DK", taxRegime: "eu_vat" })
      expect(Number((await prisma.orgSettings.findUniqueOrThrow({ where: { organizationId: orgId } })).taxRate)).toBe(25)
    } finally {
      await cleanupTestOrganizations({ where: { id: orgId } })
    }
  })

  it.each(["status", "ai"])("initializes one saved Danish row for concurrent status and %s reads", async read => {
    const { orgId, caller } = await createCloudCaller()
    const readPair = () => Promise.all([
      caller.onboarding.getStatus(),
      read === "status" ? caller.onboarding.getStatus() : caller.onboardingAi.getOnboardingState(),
    ])
    try {
      expect(await prisma.orgSettings.count({ where: { organizationId: orgId } })).toBe(0)
      const [first, second] = await readPair()
      expect(sharedSettingsValues(first.values)).toEqual(sharedSettingsValues(second.values))
      expect(first.values).toHaveProperty("onboardingMethod", null)
      if (read === "status") expect(second.values).toHaveProperty("onboardingMethod", null)
      else expect(second.values).not.toHaveProperty("onboardingMethod")
      const numbering = { invoicePrefix: new Intl.DateTimeFormat("en", { year: "numeric", timeZone: "Europe/Copenhagen" }).format(new Date()), invoiceNextNum: 1, quotePrefix: "QTE", quoteNextNum: 1 }
      expect(first.values).toMatchObject({ countryCode: "DK", defaultCurrency: "DKK", taxRegime: "eu_vat", pricesIncludeTax: false, ...numbering })
      expect(await prisma.orgSettings.count({ where: { organizationId: orgId } })).toBe(1)
      const saved = await prisma.orgSettings.findUniqueOrThrow({ where: { organizationId: orgId } })
      expect(sharedSettingsValues(first.values)).toEqual(sharedSettingsValues({
        ...saved,
        invoicingIdentity: saved.onboardingInvoicingIdentity,
        primaryTaxId: null,
        primaryTaxIdScheme: null,
      }))
      expect(saved).toMatchObject({ countryCode: "DK", defaultCurrency: "DKK", baseCurrency: "DKK", currency: "DKK", locale: "da-DK", timezone: "Europe/Copenhagen", taxRegime: "eu_vat", pricesIncludeTax: false, momsRegistered: null, ...numbering })
      expect(Number(saved.taxRate)).toBe(25)

      const overridden = await prisma.orgSettings.update({
        where: { organizationId: orgId },
        data: { countryCode: "DE", defaultCurrency: "EUR", baseCurrency: "EUR", currency: "EUR", locale: "en-US", invoicePrefix: "BOOK", invoiceNextNum: 42, quotePrefix: "OFF", quoteNextNum: 8, momsRegistered: false, taxRate: 0, pricesIncludeTax: true, paymentNote: "Saved note" },
      })
      const [existingFirst, existingSecond] = await readPair()
      expect(sharedSettingsValues(existingFirst.values)).toEqual(sharedSettingsValues(existingSecond.values))
      expect(sharedSettingsValues(existingFirst.values)).toEqual(sharedSettingsValues({
        ...overridden,
        invoicingIdentity: overridden.onboardingInvoicingIdentity,
        primaryTaxId: null,
        primaryTaxIdScheme: null,
      }))
      expect(existingFirst.values).toHaveProperty("onboardingMethod", overridden.onboardingMethod)
      if (read === "status") expect(existingSecond.values).toHaveProperty("onboardingMethod", overridden.onboardingMethod)
      else expect(existingSecond.values).not.toHaveProperty("onboardingMethod")
      expect(existingFirst.values).toMatchObject({ countryCode: "DE", defaultCurrency: "EUR", locale: "en-US", invoicePrefix: "BOOK", invoiceNextNum: 42, quotePrefix: "OFF", quoteNextNum: 8, pricesIncludeTax: true })
      expect(await prisma.orgSettings.count({ where: { organizationId: orgId } })).toBe(1)
      expect(await prisma.orgSettings.findUniqueOrThrow({ where: { organizationId: orgId } })).toEqual(overridden)
    } finally {
      await cleanupTestOrganizations({ where: { id: orgId } })
    }
  })

  it("returns status/missing/values and supports draft+complete flow", async () => {
    const { orgId, caller } = await createCloudCaller()

    try {
      const initial = await caller.onboarding.getStatus()
      expect(initial.values).toMatchObject({ countryCode: "DK", defaultCurrency: "DKK", taxRegime: "eu_vat", locale: "da-DK", timezone: "Europe/Copenhagen" })
      const storedDefaults = await prisma.orgSettings.findUniqueOrThrow({ where: { organizationId: orgId } })
      expect(storedDefaults).toMatchObject({ baseCurrency: "DKK", currency: "DKK" })
      expect(Number(storedDefaults.taxRate)).toBe(25)
      expect(initial.status).toBe("not_started")
      expect(initial.isComplete).toBe(false)
      expect(initial.missing).toEqual(
        expect.arrayContaining(["companyName", "companyAddress", "companyEmail"])
      )

      const draft = await caller.onboarding.saveDraft({
        companyName: "Acme ApS",
        companyAddress: "Main St 1",
        companyEmail: "billing@acme.example",
        countryCode: "DK",
        invoicingIdentity: "registered_business",
        locale: "da-DK",
        timezone: "Europe/Copenhagen",
        defaultCurrency: "DKK",
        taxRegime: "eu_vat",
        pricesIncludeTax: true,
        invoicePrefix: "INV",
        quotePrefix: "QTE",
        primaryTaxId: "24256790",
        primaryTaxIdScheme: "DK_CVR",
      })
      expect(draft.status).toBe("in_progress")
      expect(draft.missing).toEqual([])
      expect(draft.values.invoicingIdentity).toBe("registered_business")

      const completed = await caller.onboarding.completeManual({ method: "manual" })
      expect(completed.status).toBe("complete")
      expect(completed.isComplete).toBe(true)
      expect(completed.missing).toEqual([])
    } finally {
      await cleanupTestOrganizations({ where: { id: orgId } })
    }
  })

  it("requires a CVR for Danish sole traders", async () => {
    const { orgId, caller } = await createCloudCaller()

    try {
      const draft = await caller.onboarding.saveDraft({
        companyName: "Freelance Norden",
        companyAddress: "Main St 1",
        companyEmail: "billing@acme.example",
        countryCode: "DK",
        invoicingIdentity: "individual",
        primaryTaxId: "24256790", primaryTaxIdScheme: "cvr",
        locale: "da-DK",
        timezone: "Europe/Copenhagen",
        defaultCurrency: "DKK",
        taxRegime: "eu_vat",
        pricesIncludeTax: true,
        invoicePrefix: "INV",
        quotePrefix: "QTE",
      })

      expect(draft.missing).toEqual([])
      expect(draft.values.invoicingIdentity).toBe("individual")

      const completed = await caller.onboarding.completeManual({ method: "manual" })
      expect(completed.isComplete).toBe(true)
    } finally {
      await cleanupTestOrganizations({ where: { id: orgId } })
    }
  })
})
