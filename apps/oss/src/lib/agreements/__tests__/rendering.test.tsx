// @vitest-environment jsdom
import { describe, expect, it } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import { renderToBuffer } from "@react-pdf/renderer"
import { AgreementPdf, agreementTermsText } from "../../agreement-pdf"
import { I18nProvider } from "../../i18n/react"
import { PublicAgreementPage } from "../../../components/agreements/public-agreement-page"
import { composeAgreementEmail } from "../../../domain/documents/agreement-email"
import { renderAgreementMarkdown } from "../markdown"
import { hostileAgreementMarkdown } from "./fixtures"
import type { AgreementOfferSnapshot } from "@quits/contracts/agreements"

export function renderingSnapshot(termsHtml: string): AgreementOfferSnapshot {
  return {
    title: "Safe offer",
    summary: "Scope",
    sellerSnapshot: { companyName: "Seller" },
    buyerSnapshot: { name: "Buyer" },
    termsHtml,
    validUntil: "2027-03-28T00:00:00.000Z",
    timezone: "UTC",
    currency: "USD",
    countryCode: "US",
    locale: "en-US",
    taxRegime: "us_sales_tax",
    taxRate: "0.00",
    pricesIncludeTax: false,
    dueInDays: 30,
    billingTrigger: "on_acceptance",
    subtotalNet: "100.00",
    totalTax: "0.00",
    totalGross: "100.00",
    deliverables: [
      {
        title: "Work",
        description: "Build",
        quantity: "1.00",
        unitPriceNet: "100.00",
        unitPriceGross: "100.00",
        lineNet: "100.00",
        lineTax: "0.00",
        lineGross: "100.00",
        taxRate: "0.00",
        taxCategory: "standard",
        taxCode: null,
        agreedDate: null,
        isDeposit: false,
        sortOrder: 0,
      },
    ],
  }
}
const settings = {
  companyName: "Seller",
  companyEmail: "seller@example.test",
  locale: "en-US",
  timezone: "UTC",
  stripePublishableKey: null,
  stripeSecretKeyEnc: null,
  stripeWebhookSecretEnc: null,
}
function assertSafeHtml(html: string) {
  const document = new DOMParser().parseFromString(html, "text/html")
  expect(document.querySelector("script,img,svg,iframe,style,math,object,embed")).toBeNull()
  for (const element of document.querySelectorAll("*"))
    expect(element.getAttributeNames().some((key) => key.startsWith("on"))).toBe(false)
  for (const link of document.querySelectorAll("a"))
    expect(link.getAttribute("href")).toMatch(/^(https?:\/\/|mailto:|\/a\/)/)
}
describe("agreement page, PDF and email share the restricted terms", () => {
  it.each(hostileAgreementMarkdown)("renders hostile corpus safely: %j", async (source) => {
    const snapshot = renderingSnapshot(renderAgreementMarkdown(source))
    const page = renderToStaticMarkup(
      <I18nProvider>
        <PublicAgreementPage
          seller={{ name: null, logo: null }}
          document={{
            expectedDates: [],
            number: "AGR-1",
            status: "sent",
            offerRevision: 1,
            issueDate: null,
            expiresAt: null,
            snapshot,
            acceptance: null,
            declinedAt: null,
            declineReason: null,
          }}
          scope="decide"
          token="synthetic"
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
      </I18nProvider>,
    )
    const email = composeAgreementEmail({
      snapshot,
      number: "AGR-1",
      locale: "en-US",
      settings,
      recipient: "customer@example.test",
      url: "https://quits.example/a/synthetic",
    })
    assertSafeHtml(page)
    assertSafeHtml(email.html)
    expect(agreementTermsText(snapshot.termsHtml)).not.toContain("<p>")
    const pdf = await renderToBuffer(<AgreementPdf snapshot={snapshot} number="AGR-1" />)
    expect(pdf.subarray(0, 4).toString()).toBe("%PDF")
    expect(pdf.toString("latin1")).not.toMatch(/\/JavaScript|\/JS\b|\/URI\s*\(javascript:/i)
  })
})
