// @vitest-environment jsdom
import fixture from "../../../domain/agreements/__tests__/fixtures/offer-v2.json"
import { describe, expect, it } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import { agreementOfferSnapshotV2Schema } from "@quits/contracts/agreements"
import { agreementVatPresentation } from "../vat-presentation"
import { AgreementPdf } from "../../agreement-pdf"
import { I18nProvider } from "../../i18n/react"
import { PublicAgreementPage } from "../../../components/agreements/public-agreement-page"
import type { PublicAgreementDto } from "../public"
const snapshot = agreementOfferSnapshotV2Schema.parse({ ...fixture.snapshot, buyerSnapshot: { ...fixture.snapshot.buyerSnapshot, address: "Frozen buyer road 2", zip: "2200", city: "København N", country: "DK" } })
describe("v2 offer rendering", () => {
  it("uses frozen v2 groups and leaves v1 totals unchanged", () => {
    const { offerFormatVersion: _version, calculationVersion: _calculation, serviceTotal: _total, paymentSchedule: _schedule, originalInputs: _inputs, vatGroups, scheduleVatGroups: _groups, ...v1 } = snapshot
    expect(agreementVatPresentation(v1).totals).toBeNull()
    expect(agreementVatPresentation(snapshot).totals?.lines).toEqual(expect.arrayContaining([expect.objectContaining({ label: "Moms 25 %", amount: "0.01" })]))
    const zero = { ...snapshot, vatGroups: vatGroups.map(group => ({ ...group, rate: "0", treatment: "out_of_scope" as const, tax: "0" })) }
    expect(agreementVatPresentation(zero, "en-US").totals?.lines[1]).toMatchObject({ label: "Tax 0%", reason: "Outside the scope of VAT" })
    expect(agreementVatPresentation(zero, "en-US").totals?.note).toBe("No VAT is charged. The supply is outside the scope of VAT.")
    expect(agreementVatPresentation(zero, "en-US").lineLabel("0")).toBe("0% tax")
  })
  it("keeps agreement exemption evidence off standard rows and preserves unlike zero bases", () => {
    const groups = [
      { ...snapshot.vatGroups[0]!, rate: "0.25", treatment: "standard" as const, reasonCode: null, net: "100", tax: "25", gross: "125" },
      { ...snapshot.vatGroups[0]!, rate: "0", treatment: "exempt" as const, reasonCode: "health", net: "20", tax: "0", gross: "20" },
      { ...snapshot.vatGroups[0]!, rate: "0", treatment: "export" as const, reasonCode: "goods", net: "30", tax: "0", gross: "30" },
    ].map(group => ({ ...group, evidence: { statementText: "Synthetic exemption statement" } }))
    const rows = agreementVatPresentation({ ...snapshot, vatGroups: groups } as typeof snapshot, "en-US").totals!.lines
    expect(rows.filter(row => row.reason?.includes("Synthetic exemption statement"))).toHaveLength(2)
    expect(rows.find(row => row.label.includes("25%"))?.reason).toBeUndefined()
    expect(rows.filter(row => row.label.includes("0%"))).toHaveLength(2)
  })
  it("shows the service total and VAT basis of the schedule on the page and PDF", () => {
    const document = { snapshot, number: "AGR-1", status: "sent", expectedDates: [], acceptance: null } as unknown as PublicAgreementDto
    const page = renderToStaticMarkup(<I18nProvider><PublicAgreementPage seller={{ name: null, logo: null }} document={document} scope="read" depositsEnabled={true} token="fixture" name="" onNameChange={() => {}} confirmed={false} onConfirmedChange={() => {}} reason="" onReasonChange={() => {}} onDecision={() => {}} busy={false} error={null} /></I18nProvider>)
    expect(page).toContain("Rounding"); expect(page).toContain("Service total"); expect(page).toContain("Payment schedule"); expect(page).toContain("including VAT"); expect(page).toContain("On agreement acceptance")
    expect(page).not.toContain("included in the total")
    const pdf = renderToStaticMarkup(<AgreementPdf snapshot={snapshot} number="AGR-1" />)
    expect(pdf).toContain("Afrunding"); expect(pdf).toContain("Service total"); expect(pdf).toContain("Payment schedule"); expect(pdf).toContain("20.00"); expect(pdf).toContain("including VAT")
    expect(pdf).not.toContain("deposit included in total")
    for (const output of [page, pdf]) { expect(output).toContain("Frozen buyer road 2"); expect(output).toContain("2200 København N") }
  })
})
