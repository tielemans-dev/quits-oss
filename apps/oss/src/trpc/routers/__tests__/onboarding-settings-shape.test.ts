import { readFileSync } from "node:fs"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Context } from "../../init"
import type { UserActor } from "../../../domain/actor"
import { onboardingRouter } from "../onboarding"
import { onboardingAiRouter } from "../onboarding-ai"
import { confirmOnboardingV2 } from "../../../lib/onboarding/confirm-v2"
import { confirmOnboardingV2Schema } from "@quits/contracts/onboarding"

const mocks = vi.hoisted(() => ({ settings: null as Record<string, unknown> | null, creates: [] as Array<Record<string, unknown>>, baseCurrency: "DKK", v2: false, suggestedValues: {} as Record<string, unknown> }))
vi.mock("../../init", async () => {
  const { initTRPC } = await import("@trpc/server")
  const t = initTRPC.context<Context>().create()
  const actor: UserActor = { kind: "user", organizationId: "org-121", userId: "user-121", roles: ["admin"], label: "Test User" }
  const procedure = t.procedure.use(({ next }) => next({ ctx: {
    organizationId: actor.organizationId,
    user: { id: actor.userId, email: "signup@example.test", name: actor.label },
    actor,
  } }))
  return { router: t.router, authorizedProcedure: () => procedure }
})
vi.mock("../../../lib/distribution", () => ({ isCloudDistribution: true }))
vi.mock("../../../lib/runtime/extensions", () => ({ getRuntimeCapabilities: () => ({ onboardingV2: { enabled: mocks.v2 }, onboardingAi: { enabled: true } }) }))
vi.mock("../../../lib/runtime/services", () => ({ getOnboardingAiService: () => ({ suggestPatch: async (input: { currentValues: Record<string, unknown> }) => { mocks.suggestedValues = input.currentValues; return { patch: { companyName: "Suggested ApS" }, rationale: "Company name only", confidence: 0.9, followupQuestions: [] } } }) }))
vi.mock("../../../lib/billing", () => ({ billingProvider: {} }))
vi.mock("../../../domain/documents/base-currency", () => ({ resolveBaseCurrency: async () => { if (!mocks.settings) throw new Error("Currency resolution needs a saved settings row"); return mocks.baseCurrency }, hasIssuedDocuments: async () => false }))
vi.mock("../../../lib/db", () => {
  // Independent schema keys catch invalid create fields even when upsert updates an existing row.
  const schema = readFileSync(new URL("../../../../prisma/schema.prisma", import.meta.url), "utf8")
  const model = schema.match(/model OrgSettings \{([\s\S]*?)\n\}/)![1]!
  const scalarKeys = new Set([...model.matchAll(/^\s+(\w+)\s+(?:String|Int|Float|Decimal|Boolean|DateTime|Json)\??\s/gm)].map(match => match[1]))
  const db = {
    organization: { update: async () => ({}) },
    invoice: { count: async () => 0 },
    quote: { count: async () => 0 },
    orgSettings: {
      findUnique: async () => mocks.settings,
      findUniqueOrThrow: async () => mocks.settings,
      upsert: async ({ create, update }: { create: Record<string, unknown>; update: Record<string, unknown> }) => {
        for (const key of Object.keys(create)) {
          if (!scalarKeys.has(key)) throw new Error(`Unknown argument ${key} in OrgSettings.create`)
        }
        mocks.creates.push(create)
        mocks.settings = mocks.settings ? { ...mocks.settings, ...update } : { countryCode: "US", defaultCurrency: "USD", baseCurrency: "USD", currency: "USD", locale: "en-US", timezone: "UTC", invoicePrefix: "INV", invoiceNextNum: 1, quotePrefix: "QTE", quoteNextNum: 1, ...create }
        return mocks.settings
      },
    },
    organizationTaxId: { findFirst: async () => null, deleteMany: async () => ({ count: 0 }), updateMany: async () => ({}), createMany: async () => ({}) },
    $queryRaw: async () => [],
    $transaction: async (run: (tx: unknown) => unknown) => run(db),
  }
  return { prisma: db }
})
const caller = () => onboardingRouter.createCaller({ session: null } satisfies Context)
const defaults = { countryCode: "DK", defaultCurrency: "DKK", baseCurrency: "DKK", currency: "DKK", locale: "da-DK", timezone: "Europe/Copenhagen", taxRegime: "eu_vat", pricesIncludeTax: false, taxRate: 25 }

describe("onboarding Prisma create payloads", () => {
  beforeEach(() => { mocks.settings = null; mocks.creates = []; mocks.baseCurrency = "DKK"; mocks.v2 = false })
  it("persists valid Danish defaults on the first legacy status read", async () => {
    const status = await caller().getStatus()
    expect(status.values).toMatchObject({ countryCode: "DK", defaultCurrency: "DKK" })
    expect(mocks.settings).toMatchObject(defaults)
    expect(mocks.creates).toHaveLength(1)
  })
  it("validates draft creates and preserves explicit overrides and resolved non-DK books", async () => {
    mocks.baseCurrency = "EUR"
    await caller().saveDraft({ countryCode: "DE", locale: "en-US", defaultCurrency: "EUR", pricesIncludeTax: true, primaryTaxId: undefined })
    expect(mocks.creates).toHaveLength(3)
    expect(mocks.creates[1]).toMatchObject({ ...defaults, countryCode: "DE", locale: "en-US", defaultCurrency: "EUR", baseCurrency: "EUR", pricesIncludeTax: true })
    expect(mocks.settings).toMatchObject({ countryCode: "DE", baseCurrency: "EUR", defaultCurrency: "EUR", pricesIncludeTax: true })
  })
  it("validates profile completion creates even with an existing row", async () => {
    await caller().getStatus()
    await caller().complete({ profile: "smb" })
    expect(mocks.creates).toHaveLength(4)
    expect(mocks.creates[2]).toMatchObject({ countryCode: "DK", baseCurrency: "DKK", currency: "DKK", defaultCurrency: "DKK", taxRegime: "eu_vat" })
  })
})

const aiCaller = () => onboardingAiRouter.createCaller({ session: null } satisfies Context)
const confirmInput = () => confirmOnboardingV2Schema.parse({ companyName: "Test ApS", companyAddress: "Testvej 1, 1000 København", companyForm: "ApS", momsRegistered: true, cvr: "24256790", vatId: "DK24256790", idempotencyKey: "4a8d7e5c-b2f1-4f72-8ba3-b58e21b55d45" })

describe("v2 with onboarding AI Danish defaults", () => {
  beforeEach(() => { mocks.settings = null; mocks.creates = []; mocks.baseCurrency = "DKK"; mocks.v2 = true })
  it("keeps Danish values and numbering through initial read, sparse AI apply and confirmation", async () => {
    const status = await caller().getStatus()
    expect(mocks.settings).toBeNull()
    const state = await aiCaller().getOnboardingState()
    expect(state.values).toMatchObject({ countryCode: "DK", defaultCurrency: "DKK", invoicePrefix: status.values.invoicePrefix })
    const suggestion = await aiCaller().suggestOnboardingPatch({ userMessage: "Set my company name" })
    expect(mocks.suggestedValues).toMatchObject({ countryCode: "DK", defaultCurrency: "DKK", invoicePrefix: status.values.invoicePrefix })
    const applied = await aiCaller().applyOnboardingPatch({ patch: suggestion.patch, source: "ai" })
    expect(applied.values).toMatchObject({ countryCode: "DK", defaultCurrency: "DKK", invoicePrefix: status.values.invoicePrefix })
    await confirmOnboardingV2("org-121", confirmInput(), "signup@example.test")
    expect(mocks.settings).toMatchObject({ ...defaults, invoicePrefix: status.values.invoicePrefix, invoiceNextNum: 1 })
  })
  it("uses Danish create defaults for a sparse AI apply before any read", async () => {
    const applied = await aiCaller().applyOnboardingPatch({ patch: { companyName: "Sparse ApS" }, source: "ai" })
    expect(applied.values).toMatchObject({ countryCode: "DK", defaultCurrency: "DKK" })
    expect(mocks.settings).toMatchObject(defaults)
  })
  it("preserves saved overrides and book through AI reads, sparse patches and confirmation", async () => {
    mocks.settings = { ...defaults, invoicePrefix: "BOOK", invoiceNextNum: 42, quotePrefix: "OFF", quoteNextNum: 8, locale: "en-US", pricesIncludeTax: true }
    const state = await aiCaller().getOnboardingState()
    expect(state.values).toMatchObject({ invoicePrefix: "BOOK", locale: "en-US", pricesIncludeTax: true })
    await aiCaller().applyOnboardingPatch({ patch: { companyName: "Edited ApS" }, source: "ai" })
    expect(mocks.settings).toMatchObject({ invoicePrefix: "BOOK", invoiceNextNum: 42, locale: "en-US", pricesIncludeTax: true })
    await confirmOnboardingV2("org-121", confirmInput(), "signup@example.test")
    expect(mocks.settings).toMatchObject({ invoicePrefix: "BOOK", invoiceNextNum: 42, quotePrefix: "OFF", quoteNextNum: 8 })
  })
})
