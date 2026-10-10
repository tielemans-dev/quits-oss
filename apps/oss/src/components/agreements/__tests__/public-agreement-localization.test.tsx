// @vitest-environment jsdom
import { describe, expect, it } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import type { AgreementOfferSnapshot } from "@quits/contracts/agreements"
import { LocalizedDocument } from "../../documents/localized-document"
import type { PublicAgreementDto, PublicDeliverableDto } from "../../../lib/agreements/public"
import type { ComponentProps } from "react"
import { AgreementActions } from "../agreement-actions"
import { PublicAgreementPage } from "../public-agreement-page"
import { PublicDeliverablePage } from "../public-deliverable-page"

const snapshot: AgreementOfferSnapshot = {
  title: "Hjemmeside",
  summary: "Ny hjemmeside",
  sellerSnapshot: { companyName: "Acme ApS" },
  buyerSnapshot: { name: "Kunde" },
  termsHtml: "<p>Vilkår</p>",
  validUntil: "2027-03-28T00:00:00.000Z",
  timezone: "Europe/Copenhagen",
  currency: "DKK",
  countryCode: "DK",
  locale: "da-DK",
  taxRegime: "eu_vat",
  taxRate: "25.00",
  pricesIncludeTax: false,
  dueInDays: 14,
  billingTrigger: "on_acceptance",
  subtotalNet: "1000.00",
  totalTax: "250.00",
  totalGross: "1250.00",
  deliverables: [
    {
      title: "Design",
      description: "Layout",
      quantity: "1.50",
      unitPriceNet: "400.00",
      unitPriceGross: "500.00",
      lineNet: "600.00",
      lineTax: "150.00",
      lineGross: "750.00",
      taxRate: "25.00",
      taxCategory: "standard",
      taxCode: null,
      agreedDate: "2027-03-01T00:00:00.000Z",
      isDeposit: false,
      sortOrder: 0,
    },
  ],
}

const document: PublicAgreementDto = {
  number: "AGR-1",
  status: "sent",
  offerRevision: 1,
  issueDate: null,
  expiresAt: null,
  snapshot,
  expectedDates: ["2027-04-15T00:00:00.000Z"],
  acceptance: null,
  declinedAt: null,
  declineReason: null,
}

const seller = { name: "Acme ApS", logo: "/a/fixture/logo" }

function agreementPage(locale: string, doc: PublicAgreementDto = document, depositsEnabled = true, scope: "read" | "decide" = "read") {
  return renderToStaticMarkup(
    <LocalizedDocument locale={locale}>
      <PublicAgreementPage
        seller={seller}
        document={doc}
        scope={scope}
        depositsEnabled={depositsEnabled}
        token="fixture"
        name=""
        onNameChange={() => {}}
        confirmed={false}
        onConfirmedChange={() => {}}
        reason=""
        onReasonChange={() => {}}
        onDecision={() => {}}
        busy={false}
        error={null}
      />
    </LocalizedDocument>
  )
}

describe("public agreement page in Danish", () => {
  it.each(["da-DK", "en-US"])("suppresses disabled advance acceptance in %s while keeping terms, decline and PDF", locale => {
    const doc = { ...document, snapshot: { ...snapshot, deliverables: snapshot.deliverables.map(line => ({ ...line, isDeposit: true })) } }
    const disabled = agreementPage(locale, doc, false, "decide")
    expect(disabled).not.toContain('id="accepted-name"')
    expect(disabled).toContain('id="decline-reason"')
    expect(disabled).toContain("/a/fixture/pdf")
    expect(disabled).toContain("Vilkår")
    expect(disabled).toContain("Design")
    expect(agreementPage(locale, doc, true, "decide")).toContain('id="accepted-name"')
    expect(agreementPage(locale, document, false, "decide")).toContain('id="accepted-name"')
  })

  it("writes dates, quantities and money the Danish way, not as raw stored values", () => {
    const html = agreementPage("da-DK")

    expect(html).toContain("Gyldig til: 28. marts 2027")
    expect(html).toContain("Aftalt dato: 1. marts 2027")
    expect(html).toContain("Forventet dato: 15. april 2027")
    expect(html).toContain("1,5\u00a0×\u00a0500,00 kr. = 750,00 kr.")
    expect(html).toContain("1.250,00 kr.")
    expect(html).not.toContain("2027-03-28")
    expect(html).not.toContain("1.50\u00a0×\u00a0500.00")
  })

  it("shows the status in words instead of the stored value", () => {
    expect(agreementPage("da-DK")).toContain("<p>Sendt</p>")
    expect(agreementPage("en-US")).toContain("<p>Sent</p>")
    expect(agreementPage("da-DK", { ...document, status: "completed" })).toContain("<p>Gennemført</p>")
  })

  it("shows the seller's logo and name above the agreement", () => {
    const html = agreementPage("da-DK")

    expect(html).toContain('src="/a/fixture/logo"')
    expect(html.indexOf("/a/fixture/logo")).toBeLessThan(html.indexOf("Hjemmeside"))
  })

  it("shows a status the contract does not know as stored rather than failing", () => {
    expect(agreementPage("da-DK", { ...document, status: "archived" })).toContain("<p>archived</p>")
  })

  it("uses the same layout in English with US formats", () => {
    const html = agreementPage("en-US", {
      ...document,
      snapshot: { ...snapshot, currency: "USD", locale: "en-US" },
    })

    expect(html).toContain("Valid until: March 28, 2027")
    expect(html).toContain("1.5\u00a0×\u00a0$500.00 = $750.00")
  })
})

describe("internal acceptance control", () => {
  it("checks frozen offer terms while retaining the PDF action", () => {
    function actions(deposit: boolean, enabled: boolean) {
      const agreement = { id: "fixture", status: "sent", acceptedAt: null, offerSnapshot: { ...snapshot, deliverables: snapshot.deliverables.map(line => ({ ...line, isDeposit: deposit })) } } as unknown as ComponentProps<typeof AgreementActions>["agreement"]
      const capabilities = { accept: true, depositsEnabled: enabled } as ComponentProps<typeof AgreementActions>["capabilities"]
      return renderToStaticMarkup(<LocalizedDocument locale="en-US"><AgreementActions agreement={agreement} capabilities={capabilities} onChanged={async () => {}} onError={() => {}} /></LocalizedDocument>)
    }
    expect(actions(true, false)).not.toContain('id="internal-name"')
    expect(actions(true, false)).toContain("/api/agreements/fixture/pdf")
    expect(actions(true, true)).toContain('id="internal-name"')
    expect(actions(false, false)).toContain('id="internal-name"')
  })
})

describe("public deliverable page", () => {
  const deliverable: PublicDeliverableDto = {
    agreementNumber: "AGR-1",
    agreementTitle: "Hjemmeside",
    title: "Design",
    description: "Layout",
    status: "delivered",
    deliveryRevision: 1,
    deliveredAt: "2027-04-10T09:00:00.000Z",
    acceptedAt: null,
    acceptedRevision: null,
    changeRequestNote: null,
    agreedDate: "2027-03-01T00:00:00.000Z",
    expectedDate: "2027-04-15T00:00:00.000Z",
  }

  it("writes the agreed and expected dates in the agreement's language", () => {
    const html = renderToStaticMarkup(
      <LocalizedDocument locale="da-DK">
        <PublicDeliverablePage token="fixture" initial={deliverable} seller={seller} />
      </LocalizedDocument>
    )

    expect(html).toContain("Aftalt dato: 1. marts 2027")
    expect(html).toContain("Forventet dato: 15. april 2027")
    expect(html).toContain("Leveret")
    expect(html).not.toContain("2027-03-01")
  })

  it("shows the seller's logo and name above the delivery", () => {
    const html = renderToStaticMarkup(
      <LocalizedDocument locale="da-DK">
        <PublicDeliverablePage token="fixture" initial={deliverable} seller={seller} />
      </LocalizedDocument>
    )

    expect(html).toContain('src="/a/fixture/logo"')
    expect(html).toContain("Acme ApS")
  })
})
