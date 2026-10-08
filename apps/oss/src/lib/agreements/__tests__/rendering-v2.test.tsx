// @vitest-environment jsdom
import fixture from "../../../domain/agreements/__tests__/fixtures/offer-v2.json"
import { describe, expect, it } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import { readAgreementOfferSnapshot } from "@quits/contracts/agreements"
import { AgreementPdf } from "../../agreement-pdf"
import { I18nProvider } from "../../i18n/react"
import { PublicAgreementPage } from "../../../components/agreements/public-agreement-page"
import type { PublicAgreementDto } from "../public"
const snapshot = readAgreementOfferSnapshot(fixture.snapshot)
describe("v2 offer rendering", () => {
  it("shows the service total and VAT basis of the schedule on the page and PDF", () => {
    const document = { snapshot, number: "AGR-1", status: "sent", expectedDates: [], acceptance: null } as unknown as PublicAgreementDto
    const page = renderToStaticMarkup(<I18nProvider><PublicAgreementPage seller={{ name: null, logo: null }} document={document} scope="read" token="fixture" name="" onNameChange={() => {}} confirmed={false} onConfirmedChange={() => {}} reason="" onReasonChange={() => {}} onDecision={() => {}} busy={false} error={null} /></I18nProvider>)
    expect(page).toContain("Payable rounding"); expect(page).toContain("Service total"); expect(page).toContain("Payment schedule"); expect(page).toContain("including VAT"); expect(page).toContain("On agreement acceptance")
    expect(page).not.toContain("included in the total")
    const pdf = renderToStaticMarkup(<AgreementPdf snapshot={snapshot} number="AGR-1" />)
    expect(pdf).toContain("Payable rounding"); expect(pdf).toContain("Service total"); expect(pdf).toContain("Payment schedule"); expect(pdf).toContain("20.00"); expect(pdf).toContain("including VAT")
    expect(pdf).not.toContain("deposit included in total")
  })
})
