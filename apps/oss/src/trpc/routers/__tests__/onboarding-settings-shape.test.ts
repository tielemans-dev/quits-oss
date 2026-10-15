import { readFileSync } from "node:fs"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Context } from "../../init"
import type { UserActor } from "../../../domain/actor"
import { nonVatStatement } from "../../../lib/documents/non-vat-note"
import { invoiceTaxIds } from "../../../lib/documents/invoice-identity"
import { settingsRouter } from "../settings"
import { buildSellerSnapshot } from "../../../domain/documents/snapshots"
import { buildUblDocument, validateEinvoice, type EinvoiceDocument } from "../../../lib/exports/ubl"
import { buildSellerParty } from "../../../lib/exports/einvoice"
import { onboardingRouter } from "../onboarding"
import { onboardingAiRouter } from "../onboarding-ai"
import { confirmOnboardingV2 } from "../../../lib/onboarding/confirm-v2"
import { confirmOnboardingV2Schema } from "@quits/contracts/onboarding"

const mocks = vi.hoisted(() => ({ cloud: true, cvrGet: vi.fn(async (cvr: string) => ({ cvr, status: "active", statusClass: "active" })), nonVatAllowed: true, taxIds: [] as Array<{ id: string; scheme: string; value: string; countryCode: string | null; isPrimary: boolean }>, settings: null as Record<string, unknown> | null, creates: [] as Array<Record<string, unknown>>, baseCurrency: "DKK", v2: false, suggestedValues: {} as Record<string, unknown>, barrier: null as null | { arrivals: number; ready: Promise<void>; release: () => void }, databaseError: null as Error | null }))
vi.mock("../../init", async () => {
  const { initTRPC } = await import("@trpc/server")
  const t = initTRPC.context<Context>().create()
  const actor: UserActor = { kind: "user", organizationId: "org-121", userId: "user-121", roles: ["admin"], label: "Test User" }
  const procedure = t.procedure.use(({ next }) => next({ ctx: {
    organizationId: actor.organizationId,
    user: { id: actor.userId, email: "signup@example.test", name: actor.label },
    actor, session: { session: { id: "session" } },
  } }))
  return { router: t.router, authorizedProcedure: () => procedure, protectedProcedure: procedure }
})
vi.mock("../../../lib/distribution", () => ({ get isCloudDistribution() { return mocks.cloud } }))
vi.mock("../../../lib/runtime/extensions", () => ({ getRuntimeExtensions: () => [], isNonVatRegistrationAllowed: () => mocks.nonVatAllowed, getRuntimeCapabilities: () => ({ onboardingV2: { enabled: mocks.v2 }, onboardingAi: { enabled: true }, payments: { enabled: false, managed: false, provider: null } }) }))
vi.mock("../../../lib/runtime/services", () => ({ getCvrLookupProvider: () => ({ get: mocks.cvrGet }), getOnboardingAiService: () => ({ suggestPatch: async (input: { currentValues: Record<string, unknown> }) => { mocks.suggestedValues = input.currentValues; return { patch: { companyName: "Suggested ApS" }, rationale: "Company name only", confidence: 0.9, followupQuestions: [] } } }) }))
vi.mock("../../../lib/billing", () => ({ billingProvider: {} }))
vi.mock("../../../domain/documents/base-currency", () => ({ resolveBaseCurrency: async () => { if (!mocks.settings) throw new Error("Currency resolution needs a saved settings row"); return mocks.baseCurrency }, hasIssuedDocuments: async () => false }))
vi.mock("../../../lib/db", () => {
  // Independent schema keys catch invalid create fields even when upsert updates an existing row.
  const schema = readFileSync(new URL("../../../../prisma/schema.prisma", import.meta.url), "utf8")
  const model = schema.match(/model OrgSettings \{([\s\S]*?)\n\}/)![1]!
  const scalarKeys = new Set([...model.matchAll(/^\s+(\w+)\s+(?:String|Int|Float|Decimal|Boolean|DateTime|Json)\??\s/gm)].map(match => match[1]))
  const rendezvous = async () => {
    if (!mocks.barrier) return
    const barrier = mocks.barrier
    if (++barrier.arrivals === 2) { mocks.barrier = null; barrier.release() }
    await barrier.ready
  }
  const validateCreate = (create: Record<string, unknown>) => {
    for (const key of Object.keys(create)) {
      if (!scalarKeys.has(key)) throw new Error(`Unknown argument ${key} in OrgSettings.create`)
    }
    mocks.creates.push(create)
  }
  const db = {
    organizationCvrVerification: { upsert: vi.fn(), findUnique: vi.fn() },
    organization: { update: async () => ({}) },
    invoice: { count: async () => 0 },
    quote: { count: async () => 0 },
    orgSettings: {
      findUnique: async () => mocks.settings,
      findUniqueOrThrow: async () => mocks.settings,
      upsert: async ({ create, update }: { create: Record<string, unknown>; update: Record<string, unknown> }) => {
        if (mocks.databaseError) throw mocks.databaseError
        validateCreate(create)
        // Model Prisma's client upsert: both callers observe absence before either inserts.
        const missing = !mocks.settings
        await rendezvous()
        if (missing && mocks.settings) throw new Error('Unique constraint failed on the fields: (`"organizationId"`)')
        mocks.settings = mocks.settings ? { ...mocks.settings, ...update } : { countryCode: "US", defaultCurrency: "USD", baseCurrency: "USD", currency: "USD", locale: "en-US", timezone: "UTC", invoicePrefix: "INV", invoiceNextNum: 1, quotePrefix: "QTE", quoteNextNum: 1, ...create }
        return mocks.settings
      },
      createMany: async ({ data, skipDuplicates }: { data: Record<string, unknown>; skipDuplicates: boolean }) => {
        if (mocks.databaseError) throw mocks.databaseError
        validateCreate(data)
        await rendezvous()
        if (mocks.settings) {
          if (!skipDuplicates) throw new Error('Unique constraint failed on the fields: (`"organizationId"`)')
          return { count: 0 }
        }
        mocks.settings = { ...data }
        return { count: 1 }
      },
    },
    organizationTaxId: {
      findFirst: async () => mocks.taxIds.find(id => id.isPrimary) ?? mocks.taxIds[0] ?? null,
      findMany: async () => mocks.taxIds,
      deleteMany: async ({ where }: { where: { id?: { in: string[] }; OR?: Array<{ scheme: { equals: string } }>; AND?: unknown } }) => {
        const before = mocks.taxIds.length
        mocks.taxIds = mocks.taxIds.filter(id => where.id ? !where.id.in.includes(id.id) : (where.AND && id.countryCode != null && id.countryCode !== "DK") || !where.OR?.some(clause => clause.scheme.equals.toLowerCase() === id.scheme.toLowerCase()))
        return { count: before - mocks.taxIds.length }
      },
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        for (const id of mocks.taxIds) {
          if (where.isPrimary === true && !id.isPrimary) continue
          if (typeof where.value === "string" && id.value !== where.value) continue
          if (where.countryCode && id.countryCode !== where.countryCode) continue
          if (where.AND && !(id.countryCode == null || id.countryCode === "DK")) continue
          if (where.AND && !["vat", "dk_vat"].includes(id.scheme.toLowerCase())) continue
          if (Array.isArray(where.OR) && !where.OR.some((clause: { scheme: { equals: string } }) => clause.scheme.equals.toLowerCase() === id.scheme.toLowerCase())) continue
          Object.assign(id, data)
        }
        return { count: 1 }
      },
      create: async ({ data }: { data: Omit<typeof mocks.taxIds[number], "id"> }) => { const id = { ...data, id: "tax-new" }; mocks.taxIds.push(id); return id },
      createMany: async ({ data }: { data: Array<Omit<typeof mocks.taxIds[number], "id">> }) => { mocks.taxIds.push(...data.map((id, i) => ({ ...id, id: `tax-${i}` }))); return { count: data.length } },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => { const id = mocks.taxIds.find(id => id.id === where.id)!; Object.assign(id, data); return id },
    },
    $queryRaw: async () => [],
    $transaction: async (run: (tx: unknown) => unknown, options?: { timeout?: number }) => {
      const started = Date.now()
      const result = await run(db)
      if (Date.now() - started > (options?.timeout ?? 5_000)) throw new Error("Transaction expired")
      return result
    },
  }
  return { prisma: db }
})
const caller = () => onboardingRouter.createCaller({ session: null } satisfies Context)
const defaults = { countryCode: "DK", defaultCurrency: "DKK", baseCurrency: "DKK", currency: "DKK", locale: "da-DK", timezone: "Europe/Copenhagen", taxRegime: "eu_vat", pricesIncludeTax: false, taxRate: 25 }

function overlapInitializations() {
  let release!: () => void
  const ready = new Promise<void>(resolve => { release = resolve })
  mocks.barrier = { arrivals: 0, ready, release }
}

beforeEach(() => { mocks.cloud = true; mocks.cvrGet.mockReset().mockImplementation(async (cvr: string) => ({ cvr, status: "active", statusClass: "active" })); mocks.taxIds = []; mocks.barrier = null; mocks.databaseError = null; mocks.nonVatAllowed = true })

describe("concurrent onboarding settings initialization", () => {
  beforeEach(() => { mocks.settings = null; mocks.creates = []; mocks.v2 = false; mocks.barrier = null; mocks.databaseError = null })
  it.each(["status", "ai"])("returns the same saved Danish defaults to overlapping status and %s reads", async read => {
    overlapInitializations()
    const [first, second] = await Promise.all([
      caller().getStatus(),
      read === "status" ? caller().getStatus() : aiCaller().getOnboardingState(),
    ])
    expect(first.values).toEqual(second.values)
    const numbering = { invoicePrefix: new Intl.DateTimeFormat("en", { year: "numeric", timeZone: "Europe/Copenhagen" }).format(new Date()), invoiceNextNum: 1, quotePrefix: "QTE", quoteNextNum: 1 }
    expect(first.values).toMatchObject({ countryCode: "DK", defaultCurrency: "DKK", taxRegime: "eu_vat", pricesIncludeTax: false, ...numbering })
    expect(mocks.settings).toMatchObject({ ...defaults, ...numbering })
  })
  it("leaves saved overrides, books and moms untouched on overlapping reads", async () => {
    const saved = { ...defaults, countryCode: "DE", locale: "en-US", baseCurrency: "EUR", currency: "EUR", defaultCurrency: "EUR", invoicePrefix: "BOOK", invoiceNextNum: 42, quotePrefix: "OFF", quoteNextNum: 8, momsRegistered: false, taxRate: 0, pricesIncludeTax: true, paymentNote: "Saved note" }
    mocks.settings = { ...saved }
    overlapInitializations()
    await Promise.all([caller().getStatus(), aiCaller().getOnboardingState()])
    expect(mocks.settings).toEqual(saved)
  })
  it.each(["status", "ai"])("propagates unrelated database errors from %s reads", async read => {
    const error = new Error("Database connection unavailable")
    mocks.databaseError = error
    await expect(read === "status" ? caller().getStatus() : aiCaller().getOnboardingState()).rejects.toMatchObject({ cause: error })
    expect(mocks.settings).toBeNull()
  })
})

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
    expect(mocks.creates[1]).toMatchObject({ ...defaults, taxRate: null, countryCode: "DE", locale: "en-US", currency: "EUR", defaultCurrency: "EUR", baseCurrency: "EUR", pricesIncludeTax: true })
    expect(mocks.settings).toMatchObject({ countryCode: "DE", baseCurrency: "EUR", currency: "EUR", defaultCurrency: "EUR", pricesIncludeTax: true, taxRate: null })
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

const settingsCaller = () => settingsRouter.createCaller({ session: null } satisfies Context)
describe("atomic Settings Danish VAT repairs", () => {
  beforeEach(() => { mocks.settings = { ...defaults, momsRegistered: false }; mocks.taxIds = []; mocks.creates = []; mocks.baseCurrency = "DKK" })
  it.each([undefined, false])("normalizes non-VAT tax defaults with registration %s", async momsRegistered => {
    mocks.taxIds = [{ id: "primary", scheme: "cvr", value: "24256790", countryCode: "DK", isPrimary: true }]
    await settingsCaller().update({ taxRate: 25, ...(momsRegistered === undefined ? {} : { momsRegistered }) })
    expect(mocks.settings).toMatchObject({ momsRegistered: false, taxRate: 0 })
    await settingsCaller().update({ companyName: "Edited seller" })
    expect(mocks.settings).toMatchObject({ momsRegistered: false, taxRate: 0 })
  })
  it.each([undefined, "", "00000000", "12345678", "DE123456789"])("rejects explicit non-VAT status without a valid CVR: %s", async primaryTaxId => {
    const before = { ...mocks.settings }
    await expect(settingsCaller().update({ momsRegistered: false, companyName: "Must not save", primaryTaxId, primaryTaxIdScheme: "cvr" })).rejects.toMatchObject({ code: "BAD_REQUEST" })
    expect(mocks.settings).toEqual(before)
    expect(mocks.taxIds).toEqual([])
  })
  it.each([true, false])("accepts a submitted CVR with an existing identifier: %s", async existing => {
    mocks.taxIds = existing ? [{ id: "primary", scheme: "vat", value: "DK24256790", countryCode: "DK", isPrimary: true }] : []
    await settingsCaller().update({ momsRegistered: false, primaryTaxId: "24256790", primaryTaxIdScheme: "cvr" })
    expect(mocks.settings).toMatchObject({ momsRegistered: false, taxRate: 0 })
    expect(mocks.taxIds[0]).toMatchObject({ scheme: "cvr", value: "24256790" })
  })
  it("preserves chosen tax rates for registered and foreign sellers", async () => {
    await settingsCaller().update({ momsRegistered: true, taxRate: 25 })
    expect(mocks.settings).toMatchObject({ momsRegistered: true, taxRate: 25 })
    await settingsCaller().update({ countryCode: "DE", taxRate: 19 })
    expect(mocks.settings).toMatchObject({ momsRegistered: null, taxRate: 19 })
  })

  it.each([{ countryCode: "DE" }, { taxRegime: "custom" }, { taxRegime: "us_sales_tax" }] as const)("clears hidden registration on scope departure %o even if a client omits status", async input => {
    await settingsCaller().update(input)
    expect(mocks.settings?.momsRegistered).toBeNull()
  })
  it.each([{ countryCode: "DE" }, { taxRegime: "custom" }] as const)("removes only generated declarations on scope departure %o", async input => {
    mocks.settings = { ...defaults, momsRegistered: false, paymentNote: `Custom bank instructions\n${nonVatStatement("da")}\n${nonVatStatement("en")}` }
    await settingsCaller().update(input)
    expect(mocks.settings).toMatchObject({ momsRegistered: null, paymentNote: "Custom bank instructions" })
  })
  it.each(["da", "en"] as const)("preserves deliberately saved %s declarations on unrelated saves outside VAT scope", async language => {
    mocks.settings = { ...defaults, countryCode: "DE", momsRegistered: null, paymentNote: `Custom instructions\n${nonVatStatement(language)}` }
    const note = mocks.settings.paymentNote
    await settingsCaller().update({ companyName: "Edited GmbH" })
    expect(mocks.settings?.paymentNote).toBe(note)
    await settingsCaller().update({ companyName: "Edited again" })
    expect(mocks.settings?.paymentNote).toBe(note)
  })
  it.each(["vat", "DK_VAT"])("normalizes a legacy Danish %s primary ID for non-VAT output", async scheme => {
    mocks.taxIds = [{ id: "primary", scheme, value: "24256790", countryCode: null, isPrimary: true }, { id: "foreign", scheme: "vat", value: "DE123456789", countryCode: "DE", isPrimary: false }]
    await settingsCaller().update({ momsRegistered: false, taxRate: 0 })
    expect(mocks.taxIds[0]).toMatchObject({ scheme: "cvr", value: "24256790", countryCode: "DK", isPrimary: true })
    expect(invoiceTaxIds(mocks.taxIds)).toEqual(["CVR-nr. 24256790"])
    expect(mocks.taxIds[1]).toMatchObject({ scheme: "vat", value: "DE123456789", countryCode: "DE" })
  })
  it("leaves an explicitly foreign primary ID unchanged", async () => {
    mocks.taxIds = [{ id: "primary", scheme: "vat", value: "12345678", countryCode: "DE", isPrimary: true }]
    await expect(settingsCaller().update({ momsRegistered: false })).rejects.toMatchObject({ code: "BAD_REQUEST" })
    await settingsCaller().update({ companyName: "Edited seller" })
    expect(mocks.taxIds[0]).toMatchObject({ scheme: "vat", countryCode: "DE" })
  })
  it("omits unchanged registration in scope and permits unrelated non-DK saves", async () => {
    await settingsCaller().update({ companyName: "Edited ApS" })
    expect(mocks.settings?.momsRegistered).toBe(false)
    mocks.settings = { ...defaults, countryCode: "DE", momsRegistered: null }
    await settingsCaller().update({ companyName: "Edited GmbH" })
    expect(mocks.settings?.momsRegistered).toBeNull()
  })
  it.each([true, false, null])("preserves an explicit in-scope status %s", async momsRegistered => {
    mocks.taxIds = [{ id: "primary", scheme: "cvr", value: "24256790", countryCode: "DK", isPrimary: true }]
    await settingsCaller().update({ momsRegistered })
    expect(mocks.settings?.momsRegistered).toBe(momsRegistered)
  })
  it("keeps unsupported hosted non-VAT choices gated, while non-DK saves clear status", async () => {
    mocks.nonVatAllowed = false
    await expect(settingsCaller().update({ momsRegistered: false })).rejects.toMatchObject({ code: "FORBIDDEN" })
    await settingsCaller().update({ countryCode: "DE", momsRegistered: false })
    expect(mocks.settings?.momsRegistered).toBeNull()
  })
  it.each(["DE", null])("preserves foreign VAT registrations with country %s while replacing the Danish pair during confirmation", async countryCode => {
    mocks.settings = null
    mocks.taxIds = [
      { id: "foreign", scheme: "vat", value: "DE123456789", countryCode, isPrimary: true },
      { id: "old-dk", scheme: "DK_VAT", value: "DK11111111", countryCode: null, isPrimary: false },
    ]
    await confirmOnboardingV2("org-121", confirmInput(), "signup@example.test")
    expect(mocks.taxIds.find(id => id.id === "foreign")).toMatchObject({ value: "DE123456789", countryCode, isPrimary: false })
    expect(mocks.taxIds.find(id => id.id === "old-dk")).toBeUndefined()
    expect(mocks.taxIds.filter(id => id.countryCode === "DK").map(id => id.value)).toEqual(["24256790", "DK24256790"])
  })
  it("updates a replaced primary identity's country when moving a self-hosted organization", async () => {
    mocks.cloud = false
    mocks.settings = null
    await confirmOnboardingV2("org-121", confirmInput(), "signup@example.test")
    await settingsCaller().update({ countryCode: "DE", primaryTaxIdScheme: "vat", primaryTaxId: "123456789" })
    expect(mocks.taxIds.find(id => id.isPrimary)).toMatchObject({ countryCode: "DE", scheme: "vat", value: "123456789" })
    const seller = buildSellerSnapshot(mocks.settings as never, mocks.taxIds)
    expect(buildSellerParty({ snapshot: seller, settings: null, taxIds: [], documentCountryCode: "DE" }).vatId).toBe("DE123456789")
  })
  it.each(["cvr", "DK_CVR", "vat", "DK_VAT"])("updates the paired Danish VAT after registered confirmation and %s edit, preserving other IDs and frozen history", async scheme => {
    mocks.cloud = false
    mocks.settings = null
    await confirmOnboardingV2("org-121", confirmInput(), "signup@example.test")
    mocks.taxIds.push({ id: "foreign", scheme: "vat", value: "DE123456789", countryCode: "DE", isPrimary: false }, { id: "other", scheme: "other", value: "secondary", countryCode: "DK", isPrimary: false })
    // Make the historical VAT row precede CVR, reproducing unordered VAT resolution.
    mocks.taxIds.unshift(mocks.taxIds.splice(1, 1)[0]!)
    const frozen = buildSellerSnapshot(mocks.settings as never, structuredClone(mocks.taxIds))
    const frozenBefore = JSON.stringify(frozen)
    const fixture = JSON.parse(readFileSync(new URL("../../../lib/exports/__tests__/fixtures/legacy-ubl-input.json", import.meta.url), "utf8")) as EinvoiceDocument
    const historicalDocument = { ...fixture, seller: buildSellerParty({ snapshot: frozen, settings: null, taxIds: [], documentCountryCode: "DK" }) }
    const historicalUbl = buildUblDocument(historicalDocument)
    const value = ["vat", "DK_VAT"].includes(scheme) ? "DK87654321" : "87654321"
    await settingsCaller().update({ primaryTaxId: value, primaryTaxIdScheme: scheme })
    expect(mocks.taxIds.find(id => id.id === "tax-1")).toMatchObject({ scheme: "vat", value: "DK87654321", countryCode: "DK", isPrimary: false })
    expect(mocks.taxIds.find(id => id.id === "tax-0")).toMatchObject({ scheme, value, isPrimary: true })
    expect(mocks.taxIds.find(id => id.id === "foreign")?.value).toBe("DE123456789")
    expect(mocks.taxIds.find(id => id.id === "other")?.value).toBe("secondary")
    const future = buildSellerSnapshot(mocks.settings as never, mocks.taxIds)
    expect(buildSellerParty({ snapshot: future, settings: null, taxIds: [], documentCountryCode: "DK" }).vatId).toBe("DK87654321")
    const futureDocument = { ...fixture, seller: buildSellerParty({ snapshot: future, settings: null, taxIds: [], documentCountryCode: "DK" }) }
    expect(validateEinvoice(futureDocument)).toEqual([])
    expect(buildUblDocument(futureDocument)).toContain("DK87654321")
    expect(buildUblDocument(futureDocument)).not.toContain("DK24256790")
    expect(JSON.stringify(frozen)).toBe(frozenBefore)
    expect(buildUblDocument(historicalDocument)).toBe(historicalUbl)
    expect(historicalUbl).toContain("DK24256790")
    // The reverse VAT-to-CVR switch must keep the same pair synchronized too.
    await settingsCaller().update({ primaryTaxId: "12345678", primaryTaxIdScheme: "cvr" })
    expect(mocks.taxIds.find(id => id.id === "tax-1")?.value).toBe("DK12345678")
    expect(mocks.taxIds.find(id => id.id === "foreign")?.value).toBe("DE123456789")
    const nextSeller = buildSellerSnapshot(mocks.settings as never, mocks.taxIds)
    expect(buildSellerParty({ snapshot: nextSeller, settings: null, taxIds: [], documentCountryCode: "DK" }).vatId).toBe("DK12345678")
    expect(buildUblDocument(historicalDocument)).toBe(historicalUbl)
  })
})

const updateTaxId = (route: string, patch: { primaryTaxId: string; primaryTaxIdScheme?: string }) =>
  route === "draft" ? caller().saveDraft(patch) : route === "settings" ? settingsCaller().update(patch)
    : aiCaller().applyOnboardingPatch({ patch, source: "manual" })

describe("hosted CVR admission remains enforced", () => {
  beforeEach(() => { mocks.settings = { ...defaults }; mocks.v2 = false; mocks.taxIds = [{ id: "primary", scheme: "cvr", value: "24256790", countryCode: "DK", isPrimary: true }] })
  it("preserves the admitted CVR when a draft omits the optional tax ID", async () => {
    await caller().saveDraft({ primaryTaxId: undefined })
    expect(mocks.taxIds[0]?.value).toBe("24256790")
    expect(mocks.cvrGet).not.toHaveBeenCalled()
  })
  it.each(["outage", "ceased"])("saves unrelated Settings edits with an unchanged CVR during %s", async state => {
    if (state === "outage") mocks.cvrGet.mockRejectedValue(new Error("synthetic outage"))
    else mocks.cvrGet.mockResolvedValue({ cvr: "24256790", status: "ceased", statusClass: "blocked" })
    await settingsCaller().update({ primaryTaxId: "24256790", primaryTaxIdScheme: "cvr", companyLogo: "https://example.test/logo.png" })
    expect(mocks.settings?.companyLogo).toBe("https://example.test/logo.png")
    expect(mocks.cvrGet).not.toHaveBeenCalled()
  })
  it("revalidates an unchanged CVR submitted without its scheme", async () => {
    mocks.cvrGet.mockRejectedValue(new Error("synthetic outage"))
    await expect(settingsCaller().update({ primaryTaxId: "24256790" })).rejects.toMatchObject({ message: "cvr.unavailable" })
    expect(mocks.cvrGet).toHaveBeenCalledOnce()
    expect(mocks.taxIds[0]).toMatchObject({ scheme: "cvr", value: "24256790" })
  })
  it("saves a valid replacement when the registry takes longer than five seconds", async () => {
    vi.useFakeTimers()
    try {
      mocks.cvrGet.mockImplementation(async cvr => {
        await new Promise(resolve => setTimeout(resolve, 6_000))
        return { cvr, status: "active", statusClass: "active" }
      })
      const saved = settingsCaller().update({ primaryTaxId: "45676102", primaryTaxIdScheme: "cvr" }).then(() => "saved", (error: Error) => error.message)
      await vi.advanceTimersByTimeAsync(6_000)
      expect(await saved).toBe("saved")
      expect(mocks.taxIds[0]?.value).toBe("45676102")
    } finally { vi.useRealTimers() }
  })
  it.each(["draft", "settings", "ai"])("rejects clearing, invalid replacement and scheme bypass in %s", async route => {
    for (const patch of [{ primaryTaxId: "" }, { primaryTaxId: "12345678" }, { primaryTaxId: "24256790", primaryTaxIdScheme: "other" }]) {
      await expect(updateTaxId(route, patch)).rejects.toMatchObject({ code: "BAD_REQUEST" })
      expect(mocks.taxIds[0]?.value).toBe("24256790")
    }
  })
  it.each(["draft", "settings", "ai"])("refuses an inactive replacement and accepts a revalidated replacement in %s", async route => {
    const patch = { primaryTaxId: "45676102", primaryTaxIdScheme: "cvr" }
    mocks.cvrGet.mockResolvedValueOnce({ cvr: patch.primaryTaxId, status: "ceased", statusClass: "blocked" })
    await expect(updateTaxId(route, patch)).rejects.toMatchObject({ message: "cvr.inactive" })
    expect(mocks.taxIds[0]?.value).toBe("24256790")
    await updateTaxId(route, patch)
    expect(mocks.taxIds[0]?.value).toBe(patch.primaryTaxId)
  })
  it.each([true, false])("replays a completed confirmation during registry outage, same key: %s", async sameKey => {
    const result = { status: "complete", version: 2, completedAt: "2026-10-15T10:00:00.000Z", bankMissing: true }
    mocks.settings = { ...defaults, onboardingStatus: "complete", onboardingV2Key: sameKey ? confirmInput().idempotencyKey : "another-key", onboardingV2Result: result }
    mocks.cvrGet.mockRejectedValue(new Error("synthetic outage"))
    await expect(confirmOnboardingV2("org-121", confirmInput(), "signup@example.test")).resolves.toEqual(sameKey ? result : { status: "already_complete" })
    expect(mocks.cvrGet).not.toHaveBeenCalled()
  })
})
