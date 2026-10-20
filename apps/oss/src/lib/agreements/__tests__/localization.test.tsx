// @vitest-environment jsdom
import { describe, expect, it } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import { agreementCreateDraftDecimalInputSchema } from "@quits/contracts/agreements"
import { AgreementPdf } from "../../agreement-pdf"
import { I18nProvider } from "../../i18n/react"
import { translate } from "../../i18n/translate"
import { formatTaxIds } from "../../documents/tax-ids"
import { AcceptanceRecord } from "../../../components/agreements/acceptance-record"
import { defaultAgreementTemplates, presentAgreementTemplate } from "../../../domain/agreements/templates"
import { agreementTermsAmounts, omitSentencesNaming, renderAgreementMarkdown } from "../markdown"
import { agreementEmailReasonKey } from "../email-reason"
import { agreementDraftFieldErrors } from "../draft-validation"
import type { AgreementOfferSnapshot } from "@quits/contracts/agreements"

const nbsp = (text: string) => text.replace(/ /g, " ")
const money = { subtotalNet: "100.00", totalTax: "0.00", totalGross: "100.00" }
const danish: AgreementOfferSnapshot = { title: "Safe offer", summary: "Scope", termsHtml: "<p>Vilkår</p>", sellerSnapshot: { companyName: "Seller" },
  buyerSnapshot: { name: "Kunde", country: "DK", taxIds: [{ scheme: "VAT", value: "12345678", countryCode: "DK" }] },
  validUntil: "2026-10-30T00:00:00.000Z", timezone: "Europe/Copenhagen", currency: "DKK", countryCode: "DK", locale: "da-DK", taxRegime: "eu_vat",
  taxRate: "0.00", pricesIncludeTax: false, dueInDays: 30, billingTrigger: "on_acceptance", ...money,
  deliverables: [{ title: "Work", description: "Build", quantity: "1.00", unitPriceNet: "100.00", unitPriceGross: "100.00", lineNet: "100.00", lineTax: "0.00",
    lineGross: "100.00", taxRate: "0.00", taxCategory: "standard", taxCode: null, agreedDate: null, isDeposit: false, sortOrder: 0 }] }
const acceptance = { name: "Kunde", intendedRecipient: null, at: "2026-10-20T13:07:20.959Z", method: "customer_link", revision: 1, hash: "a".repeat(64) }
const terms = defaultAgreementTemplates("da-DK")[0]!.termsMarkdown

describe("agreement localization", () => {
  it("writes the PDF in the offer's language and leaves out empty sections", () => {
    const pdf = nbsp(renderToStaticMarkup(<AgreementPdf snapshot={danish} number="AGR-0001" issueDate="2026-10-20T13:00:00.000Z" acceptance={acceptance} />))
    for (const text of ["Aftale AGR-0001", "Kunde: Kunde", "CVR-nr. 12345678", "Udstedt: 20. okt. 2026", "Gyldig til: 30. okt. 2026", "Leverancer",
      "Subtotal: 100,00 kr.", "I alt: 100,00 kr.", "Betalingsfrist: 30 dage", "Kan faktureres når: Accepteret", "Vilkår",
      "Accepteret af: Kunde", "Accepteret den: 20. okt. 2026, 15.07", "Aftalens kontrolsum"]) expect(pdf).toContain(text)
    for (const text of ["Agreement", "Customer", "Issued", "Valid until", "Deliverables", "Payment", "Billing", "Momsnr.", "Betalingsplan", "2026-10"]) expect(pdf).not.toContain(text)
  })
  it("states the terms' total and date per locale, as the agreement, and only once the date exists", () => {
    const values = agreementTermsAmounts({ total: "22500.00", currency: "DKK", validUntil: "2026-10-30", locale: "da-DK" })
    expect(nbsp(renderAgreementMarkdown(terms, values))).toContain("Det aftalte beløb er 22.500,00 kr. Aftalen er gyldig til 30. oktober 2026.")
    const draft = renderAgreementMarkdown(omitSentencesNaming(terms, ["agreement.validUntil"]), { ...values, "agreement.validUntil": "" })
    expect(nbsp(draft)).toContain("Det aftalte beløb er 22.500,00 kr.</p>")
    expect(draft).not.toContain("gyldig til")
    // Seeded copies of the earlier wording are still the untouched built-in template.
    const seeded = { name: defaultAgreementTemplates("da-DK")[0]!.name, termsMarkdown: terms.replace("Aftalen er gyldig til", "Tilbuddet er gyldigt til") }
    expect(presentAgreementTemplate(seeded, "da-DK").termsMarkdown).toBe(terms)
  })
  it("shows acceptance in the reader's language and Danish time, with the full hash kept out of the reading flow", () => {
    const html = nbsp(renderToStaticMarkup(<I18nProvider locale="da-DK"><AcceptanceRecord record={acceptance} /></I18nProvider>))
    expect(html).toContain("Accepteret den: 20. okt. 2026, 15.07")
    expect(html).toContain("Aftalerevision: 1")
    expect(html).toContain(`<details class="text-xs text-muted-foreground"><summary class="cursor-pointer">Aftalens kontrolsum: <span class="font-mono">aaaaaaaaaaaa…</span></summary>`)
    expect(html).not.toContain("2026-10-20T13:07")
  })
  it("labels a bare Danish CVR as CVR and a DK-prefixed number as VAT", () => {
    expect(formatTaxIds([{ scheme: "VAT", value: "12345678", countryCode: "DK" }], "da-DK")).toEqual(["CVR-nr. 12345678"])
    expect(formatTaxIds([{ scheme: "VAT", value: "DK12345678", countryCode: "DK" }], "da-DK")).toEqual(["Momsnr. DK12345678"])
  })
  it("states the email attempt and draft errors in the reader's language", () => {
    expect(translate(agreementEmailReasonKey({ lastEmailAttemptOutcome: "sent", lastEmailAttemptCode: "sent" })!, "da-DK")).toBe("E-mailen med aftalen er sendt.")
    expect(agreementEmailReasonKey({ lastEmailAttemptOutcome: "failed", lastEmailAttemptCode: "email_provider_refused" })).toBeNull()
    const parsed = agreementCreateDraftDecimalInputSchema.safeParse({ contactId: "contact", title: "Website", validUntil: "" })
    expect(parsed.success).toBe(false)
    const errors = agreementDraftFieldErrors(parsed.error!.issues)
    expect(errors).toEqual({ validUntil: "agreements.validation.validUntil" })
    expect(translate(errors.validUntil!, "da-DK")).toBe("Vælg, hvilken dato aftalen er gyldig til")
  })
})
