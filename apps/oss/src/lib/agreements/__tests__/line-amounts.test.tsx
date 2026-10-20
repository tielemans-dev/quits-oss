// @vitest-environment jsdom
import { describe, expect, it } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import { AgreementPdf } from "../../agreement-pdf"
import { I18nProvider } from "../../i18n/react"
import { PublicAgreementPage } from "../../../components/agreements/public-agreement-page"
import { buildOfferSnapshot } from "../../../domain/agreements/snapshot"
import { v2Fixture } from "../../../domain/agreements/__tests__/v2-fixture"
import { agreementLineAmounts } from "../offer-totals"
import type { PublicAgreementDto } from "../public"

const offer = (pricesIncludeTax: boolean, unitPrice: string) => buildOfferSnapshot(v2Fixture({
  currency: "DKK", pricesIncludeTax, taxRate: "25",
  deliverables: [{ title: "Website", description: "Design and build", quantity: "1", unitPrice }],
}))
const page = (snapshot: ReturnType<typeof offer>) => renderToStaticMarkup(<I18nProvider locale="da-DK">
  <PublicAgreementPage seller={{ name: null, logo: null }} document={{ snapshot, number: "AGR-0001", status: "sent", expectedDates: [], acceptance: null } as unknown as PublicAgreementDto}
    scope="read" depositsEnabled={true} token="fixture" name="" onNameChange={() => {}} confirmed={false} onConfirmedChange={() => {}}
    reason="" onReasonChange={() => {}} onDecision={() => {}} busy={false} error={null} />
</I18nProvider>)
const pdf = (snapshot: ReturnType<typeof offer>) => renderToStaticMarkup(<AgreementPdf snapshot={snapshot} number="AGR-0001" />)
// Formatted amounts separate digits and currency with non-breaking spaces.
const text = (html: string) => html.replace(/ /g, " ")

describe("agreement line amounts", () => {
  it("states a line priced excluding VAT net, so the lines add up to the subtotal", () => {
    const snapshot = offer(false, "18000")
    expect(snapshot.deliverables[0]).toMatchObject({ unitPriceNet: "18000.00", lineNet: "18000.00", lineTax: "4500.00", lineGross: "22500.00" })
    expect(snapshot).toMatchObject({ serviceTotal: { net: "18000.00", tax: "4500.00", gross: "22500.00" } })
    expect(agreementLineAmounts(snapshot, snapshot.deliverables[0]!)).toEqual({ unitPrice: "18000.00", amount: "18000.00" })
    for (const output of [text(page(snapshot)), text(pdf(snapshot))]) {
      expect(output).toContain("1 × 18.000,00 kr. = 18.000,00 kr.")
      expect(output).toContain("4.500,00 kr.")
      expect(output).toContain("22.500,00 kr.")
      expect(output).not.toContain("= 22.500,00 kr.")
    }
  })
  it("states a line priced including VAT gross, so the lines add up to the total", () => {
    const snapshot = offer(true, "22500")
    expect(snapshot.deliverables[0]).toMatchObject({ lineNet: "18000.00", lineGross: "22500.00" })
    expect(agreementLineAmounts(snapshot, snapshot.deliverables[0]!)).toEqual({ unitPrice: "22500.00", amount: "22500.00" })
    for (const output of [text(page(snapshot)), text(pdf(snapshot))]) expect(output).toContain("1 × 22.500,00 kr. = 22.500,00 kr.")
  })
})
