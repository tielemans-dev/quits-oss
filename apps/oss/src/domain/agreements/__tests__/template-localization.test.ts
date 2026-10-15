import { describe, expect, it, vi } from "vitest"
import type { Prisma } from "../../../../generated/prisma/client"
import { defaultAgreementTemplates, presentAgreementTemplate, seedAgreementTemplates } from "../templates"

// MOCK: only synthetic template storage; no database or user data is changed.
function database(locale: string, seeded = false) {
  return {
    $queryRaw: vi.fn(),
    organization: { findUniqueOrThrow: vi.fn().mockResolvedValue({ agreementTemplatesSeeded: seeded, settings: { locale } }), update: vi.fn() },
    agreementTemplate: { upsert: vi.fn(), findFirst: vi.fn().mockResolvedValue({ id: "existing-default" }), update: vi.fn() },
  }
}
describe("agreement template language", () => {
  it.each(["da-DK", "en-US"])("seeds new templates in %s, preserving placeholders and existing data", async locale => {
    const db = database(locale)
    await seedAgreementTemplates(db as unknown as Prisma.TransactionClient, "synthetic-org")
    const templates = defaultAgreementTemplates(locale)
    expect(db.agreementTemplate.upsert.mock.calls.map(([args]) => args.create.name)).toEqual(templates.map(template => template.name))
    for (const [args] of db.agreementTemplate.upsert.mock.calls) {
      expect(args.update).toEqual({})
      expect(args.create.termsMarkdown).toContain("{{seller.name}}")
      expect(args.create.termsMarkdown).toContain("{{agreement.total}}")
    }
    expect(templates[0]!.name).toBe(locale === "da-DK" ? "Projekt med fast omfang" : "Fixed-scope project")
  })
  it("does not reseed an existing organization", async () => {
    const db = database("da-DK", true)
    await seedAgreementTemplates(db as unknown as Prisma.TransactionClient, "synthetic-org")
    expect(db.agreementTemplate.upsert).not.toHaveBeenCalled()
  })
  it("presents untouched legacy seeds in Danish without mutating them", () => {
    const seed = { id: "saved", ...defaultAgreementTemplates("en")[0]!, isDefault: true }
    const original = structuredClone(seed)
    expect(presentAgreementTemplate(seed, "da-DK")).toEqual({ ...seed, ...defaultAgreementTemplates("da")[0]! })
    expect(seed).toEqual(original)
  })
  it("preserves renamed or edited templates verbatim", () => {
    const seed = defaultAgreementTemplates("en")[0]!
    for (const custom of [{ ...seed, name: "My project" }, { ...seed, termsMarkdown: `${seed.termsMarkdown}\nMy terms` }]) {
      expect(presentAgreementTemplate(custom, "da")).toBe(custom)
    }
  })
})
