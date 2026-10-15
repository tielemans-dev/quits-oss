import { afterEach, beforeEach, expect, it, vi } from "vitest"
import type { CvrCompany } from "@quits/contracts/cvr"
import { companyStarters } from "../company-starters"
import { researchCompany } from "../company-research"

const fake = vi.hoisted(() => ({ complete: vi.fn(), settings: vi.fn(), byok: vi.fn(), managed: vi.fn(),
  subscription: vi.fn(), hosted: false, enabled: true, requiresSubscription: false }))
vi.mock("../../db", () => ({ prisma: { orgSettings: { findUnique: fake.settings } } }))
vi.mock("../../ai/providers", () => ({}))
vi.mock("../../ai/provider", async importOriginal => ({ ...await importOriginal<typeof import("../../ai/provider")>(),
  resolveOrgAiProvider: fake.byok, resolveManagedAiProvider: fake.managed }))
vi.mock("../../payments/stripe", () => ({ usesStripeConnectCheckout: () => fake.hosted }))
vi.mock("../../runtime/extensions", () => ({ getRuntimeCapabilities: () => ({ aiInvoiceDraft: {
  enabled: fake.enabled, managedRequiresSubscription: fake.requiresSubscription } }) }))
vi.mock("../../runtime/services", async importOriginal => ({ ...await importOriginal<typeof import("../../runtime/services")>(),
  getBillingProvider: () => ({ getSubscription: fake.subscription }) }))
const company: CvrCompany = { cvr: "12345678", name: "Test ApS", address: "Testvej 1", companyForm: "ApS",
  industryCode: "620100", status: "active", statusClass: "active", momsRegistered: true }
const extra = { customers: [{ id: "c", label: "Butikker" }], lines: [{ id: "l", description: "Webshop", unit: "each", unitPrice: 0 }] }
const sources = vi.fn(async () => [{ url: "https://example.test", text: "Vi bygger webshops til butikker." }])
const lookup = { get: vi.fn(), search: vi.fn(), researchSources: sources }
const context = { userId: "user", organizationId: "org", signal: new AbortController().signal }
beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv("QUITS_COMPANY_RESEARCH_AI_ENABLED", "true")
  fake.hosted = false; fake.enabled = true; fake.requiresSubscription = false
  fake.settings.mockResolvedValue({ aiDraftsEnabled: true, aiProvider: "openai_compatible", aiModel: "saved-model" })
  fake.subscription.mockResolvedValue({ status: "active" })
  fake.byok.mockReturnValue({ id: "openai_compatible", complete: fake.complete })
  fake.managed.mockReturnValue({ id: "managed", complete: fake.complete, defaultModel: "managed-model" })
  fake.complete.mockResolvedValue(JSON.stringify(extra))
  sources.mockResolvedValue([{ url: "https://example.test", text: "Vi bygger webshops til butikker." }])
})
afterEach(() => vi.unstubAllEnvs())

it("maps only curated industry codes, including legacy code-prefixed industry labels", () => {
  expect(companyStarters(company).lines.map(row => row.description)).toEqual(["Softwareudvikling", "IT-rådgivning"])
  expect(companyStarters({ ...company, industryCode: undefined, industry: "741020 Design" }).lines[0].description).toBe("Designarbejde")
  for (const industryCode of [undefined, "999999"]) expect(companyStarters({ ...company, industryCode }).lines).toEqual([])
  expect(companyStarters({ ...company, status: "ceased" }).lines).toEqual([])
})
it("defaults off and does not load settings, sources or a model", async () => {
  vi.stubEnv("QUITS_COMPANY_RESEARCH_AI_ENABLED", undefined)
  vi.stubEnv("YAIP_COMPANY_RESEARCH_AI_ENABLED", undefined)
  expect(await researchCompany(company, lookup, context)).toEqual(companyStarters(company))
  expect(fake.settings).not.toHaveBeenCalled(); expect(sources).not.toHaveBeenCalled(); expect(fake.complete).not.toHaveBeenCalled()
})
it("uses BYOK and keeps deterministic defaults alongside grounded suggestions", async () => {
  const result = await researchCompany(company, lookup, context)
  expect(result.lines).toHaveLength(3)
  expect(fake.byok).toHaveBeenCalled(); expect(fake.managed).not.toHaveBeenCalled()
  expect(fake.complete.mock.calls[0][0]).toMatchObject({ model: "saved-model" })
  expect(fake.complete.mock.calls[0][0].messages[1].content).toContain("Vi bygger webshops")
})
it("respects hosted drafts settings and subscription eligibility before research", async () => {
  fake.hosted = true
  fake.settings.mockResolvedValueOnce({ aiDraftsEnabled: false })
  await researchCompany(company, lookup, context)
  fake.requiresSubscription = true; fake.subscription.mockResolvedValueOnce({ status: "inactive" })
  await researchCompany(company, lookup, context)
  expect(sources).not.toHaveBeenCalled(); expect(fake.complete).not.toHaveBeenCalled()
  await researchCompany(company, lookup, context)
  expect(fake.complete.mock.calls[0][0].model).toBe("managed-model")
})
it("silently falls back for disabled AI, missing sources, blocked companies, cancellation and failures", async () => {
  fake.enabled = false; await researchCompany(company, lookup, context); fake.enabled = true
  await researchCompany({ ...company, advertisingProtected: true }, lookup, context)
  await researchCompany(company, lookup, { ...context, signal: AbortSignal.abort() })
  expect(sources).not.toHaveBeenCalled()
  sources.mockResolvedValueOnce([]); await researchCompany(company, lookup, context)
  expect(fake.complete).not.toHaveBeenCalled()
  sources.mockRejectedValueOnce(new Error("source unavailable"))
  expect(await researchCompany(company, lookup, context)).toEqual(companyStarters(company))
  const controller = new AbortController()
  fake.complete.mockImplementationOnce(async () => { controller.abort(); return JSON.stringify(extra) })
  expect(await researchCompany(company, lookup, { ...context, signal: controller.signal })).toEqual(companyStarters(company))
  for (const fail of [() => Promise.reject(new Error("unavailable")), async () => "invalid", async () => JSON.stringify({ ...extra, lines: [{ ...extra.lines[0], unitPrice: -1 }] })]) {
    fake.complete.mockImplementationOnce(fail)
    expect(await researchCompany(company, lookup, context)).toEqual(companyStarters(company))
  }
})
