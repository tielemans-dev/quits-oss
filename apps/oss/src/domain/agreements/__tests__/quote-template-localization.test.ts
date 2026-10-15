import { Effect } from "effect"
import { describe, expect, it, vi } from "vitest"
import { Prisma } from "../../../../generated/prisma/client"
import { Command, Db } from "../../services"
import { resolveQuoteDraft } from "../quote-draft"
import { defaultAgreementTemplates } from "../templates"

// Exercise the conversion resolver with synthetic storage, including its real quote lock.
describe("quote conversion template terms", () => {
  it.each(["da-DK", "en-US"])("resolves legacy seeds and preserves overrides in %s", async locale => {
    const quote = {
      id: "quote", contactId: "contact", number: "Q-1", status: "accepted",
      invoices: [], agreement: null, lastEmailAttemptOutcome: null,
      currency: "DKK", notes: "Saved quote notes", supplyDate: new Date("2020-01-01"), pricesIncludeTax: false,
      items: [{ description: "Saved work", quantity: new Prisma.Decimal(2), unitPriceNet: new Prisma.Decimal(100), unitPriceGross: new Prisma.Decimal(125), taxRate: new Prisma.Decimal(25), quantityInput: null, unitPriceInput: null, inputPrecision: null, vatRateInput: "0.25", vatTreatment: "standard", vatCountry: "DK", vatReasonCode: null }],
    }
    const db = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      quote: { findFirst: vi.fn().mockResolvedValue(quote) },
      organization: { findUniqueOrThrow: vi.fn().mockResolvedValue({ agreementTemplatesSeeded: true }), update: vi.fn() },
      orgSettings: { findUnique: vi.fn().mockResolvedValue({ locale }) },
      agreementTemplate: { findFirst: vi.fn(), update: vi.fn(), upsert: vi.fn() },
    }
    const originalQuote = structuredClone({ ...quote, items: undefined })
    const convert = (overrides = {}) => Effect.runPromise(resolveQuoteDraft({ sourceQuoteId: "quote", validUntil: "2020-02-01", ...overrides }).pipe(
      Effect.provideService(Db, db as unknown as Prisma.TransactionClient),
      Effect.provideService(Command, { organizationId: "org" } as never),
    ))
    for (const [index, seed] of defaultAgreementTemplates("en").entries()) {
      const template = { id: "template", ...seed, isDefault: true }
      db.agreementTemplate.findFirst.mockResolvedValue(template)
      const expected = defaultAgreementTemplates(locale)[index]!.termsMarkdown
      const result = await convert()
      expect(result.input.termsMarkdown).toBe(expected)
      expect(result.input.templateId).toBe("template")
      expect(result.input.deliverables[0]).toMatchObject({ quantity: "2", unitPrice: "100", agreedDate: "2020-01-01", vat: { treatment: "standard", rate: "0.25", country: "DK" } })
      expect((await convert({ templateId: "template" })).input.termsMarkdown).toBe(expected)
      for (const termsMarkdown of ["Explicit customer terms", "", seed.termsMarkdown]) {
        expect((await convert({ termsMarkdown })).input.termsMarkdown).toBe(termsMarkdown)
      }
      for (const edited of [{ ...template, name: "Custom name" }, { ...template, termsMarkdown: `${seed.termsMarkdown}\nCustom terms` }]) {
        db.agreementTemplate.findFirst.mockResolvedValue(edited)
        expect((await convert()).input.termsMarkdown).toBe(edited.termsMarkdown)
      }
      expect(template).toEqual({ id: "template", ...seed, isDefault: true })
    }
    expect((await convert({ templateId: null })).input.termsMarkdown).toBe("")
    expect({ ...quote, items: undefined }).toEqual(originalQuote)
    expect(db.agreementTemplate.update).not.toHaveBeenCalled()
    expect(db.agreementTemplate.upsert).not.toHaveBeenCalled()
    expect(db.organization.update).not.toHaveBeenCalled()
  })
})
