import { describe, expect, it } from "vitest"
import { confirmOnboardingV2Schema, isValidDanishCvr } from "@quits/contracts/onboarding"
import { formatDocumentNumber } from "@quits/shared/documents"
import { buildDkPresets } from "../onboarding/dk-presets"
import { nonVatStatement, withNonVatStatement, localizedNonVatPaymentNote } from "../documents/non-vat-note"
import { getCloudOnboardingState } from "../cloud-onboarding"

const company = { companyName: "Test ApS", companyAddress: "Testvej 1, 2. th.\n1000 København", companyForm: "ApS", momsRegistered: true }
const input = { ...company, idempotencyKey: "4a8d7e5c-b2f1-4f72-8ba3-b58e21b55d45", cvr: "24256790", vatId: "DK24256790" }

describe("Danish onboarding v2", () => {
  it("sets every Danish default explicitly for CVR and manual summaries", () => {
    const settings = buildDkPresets(company, "signup@example.test")
    expect(settings).toMatchObject({ countryCode: "DK", locale: "da-DK", timezone: "Europe/Copenhagen", defaultCurrency: "DKK", currency: "DKK", baseCurrency: "DKK", taxRegime: "eu_vat", taxRate: 25, pricesIncludeTax: false, paymentTermsDays: 14, invoicePrefix: "2026", invoiceNextNum: 1, companyEmail: "signup@example.test", companyPhone: null })
    expect(formatDocumentNumber(settings.invoicePrefix, settings.invoiceNextNum)).toBe("2026-0001")
    expect(buildDkPresets(confirmOnboardingV2Schema.parse({ ...input, source: "manual", invoiceNextNum: 42 }))).toMatchObject({ invoiceNextNum: 42, baseCurrency: "DKK" })
  })
  it("maps sole traders to the existing individual identity and adds a non-VAT note", () => {
    expect(buildDkPresets({ ...company, companyForm: "Enkeltmandsvirksomhed", momsRegistered: false })).toMatchObject({ onboardingInvoicingIdentity: "individual", taxRegime: "eu_vat", taxRate: 0, pricesIncludeTax: false, paymentNote: "Virksomheden er ikke momsregistreret." })
  })
  it.each([ ["da-DK", "Virksomheden er ikke momsregistreret."], ["en-US", "The company is not VAT registered."] ])("translates the non-VAT statement for %s and preserves custom notes", (locale, statement) => {
    expect(nonVatStatement(locale)).toBe(statement)
    expect(withNonVatStatement("Invoice note", false, locale)).toBe(`Invoice note\n${statement}`)
    expect(withNonVatStatement(statement, false, locale)).toBe(statement)
    expect(withNonVatStatement(null, true, locale)).toBeNull()
    expect(withNonVatStatement(null, undefined, locale)).toBeNull()
    expect(localizedNonVatPaymentNote("Virksomheden er ikke momsregistreret.", false, locale)).toBe(statement)
    expect(localizedNonVatPaymentNote("Pay by bank transfer", false, locale)).toBe("Pay by bank transfer")
  })
  it("does not preset protected register contacts", () => {
    expect(buildDkPresets({ ...company, companyEmail: "public@example.test", companyPhone: "12345678", reklamebeskyttet: true }, "signup@example.test")).toMatchObject({ companyEmail: "signup@example.test", companyPhone: null })
  })
  it.each(["12345678", "00000000", "2425679", "242567901", "DK24256790", "abcdefgh"])("rejects invalid CVR %s", cvr => {
    expect(isValidDanishCvr(cvr)).toBe(false)
    expect(confirmOnboardingV2Schema.safeParse({ ...input, cvr }).success).toBe(false)
  })
  it("accepts a checksum-valid CVR and optional contacts/bank", () => {
    expect(isValidDanishCvr(input.cvr)).toBe(true)
    expect(confirmOnboardingV2Schema.safeParse(input).success).toBe(true)
    expect(confirmOnboardingV2Schema.safeParse({ ...input, companyEmail: null, companyPhone: null, bank: { regNumber: "1234", accountNumber: "000001" } }).success).toBe(true)
  })
  it.each([
    { bank: { regNumber: "123", accountNumber: "1" } },
    { bank: { regNumber: "1234", accountNumber: "12345678901" } },
    { bank: { regNumber: "1234" } },
    { bank: { accountNumber: "1" } },
    { bank: { regNumber: "12 34", accountNumber: "1" } },
    { companyAddress: "a".repeat(241) },
    { companyEmail: "bad" },
    { companyPhone: "abc" },
    { invoiceNextNum: 0 },
    { invoiceNextNum: 1.5 },
    { vatId: "DK12345678" },
    { vatId: undefined },
    { momsRegistered: false },
  ])("rejects malformed summary %j", patch => {
    expect(confirmOnboardingV2Schema.safeParse({ ...input, ...patch }).success).toBe(false)
  })
  it("allows v2 completion without public email while preserving v1 email requirements", () => {
    const settings = { ...buildDkPresets({ ...company, companyEmail: null }), onboardingProfile: null, onboardingVersion: 2, onboardingCompletedAt: new Date(), onboardingStatus: "complete", primaryTaxId: input.cvr }
    expect(getCloudOnboardingState(settings).isComplete).toBe(true)
    expect(getCloudOnboardingState({ ...settings, onboardingVersion: 1 }).isComplete).toBe(false)
  })
})
