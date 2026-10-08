// @vitest-environment jsdom
import { describe, expect, it } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import { LocalizedDocument } from "../../documents/localized-document"
import type { ClientActionPage } from "../../../lib/client-actions/page"
import { ClientActionHub } from "../client-action-hub"

const page: ClientActionPage = {
  kind: "ready",
  locale: "da-DK",
  timezone: "Europe/Copenhagen",
  seller: { name: "Acme ApS", logo: null },
  recipientName: "Pia",
  expiresAt: "2026-11-08T12:00:00.000Z",
  verification: { required: true, verified: false, emailHint: "p•••@example.dk" },
  attention: 3,
  items: [
    { kind: "agreement", recordId: "a1", locale: "da-DK", number: "AGR-1", title: "Hjemmeside", state: "open", offerRevision: 1, expiresAt: "2026-12-01T00:00:00.000Z", acceptedAt: null, canApprove: true, download: true },
    { kind: "deliverable", recordId: "d1", locale: "da-DK", title: "Design", agreementNumber: "AGR-2", agreementTitle: "Logo", state: "awaiting", deliveryRevision: 2, acceptedRevision: null, deliveredAt: null, canApprove: true },
    { kind: "invoice", recordId: "i1", locale: "da-DK", number: "INV-1", state: "payable", currency: "DKK", timezone: "Europe/Copenhagen", totalGross: 1250, amountPaid: 250, amountCredited: 0, balanceDue: 1000, dueDate: "2026-11-01T00:00:00.000Z", overdue: true, canPay: true, download: true },
    { kind: "invoice", recordId: "i2", locale: "da-DK", number: "INV-0", state: "paid", currency: "DKK", timezone: "Europe/Copenhagen", totalGross: 500, amountPaid: 500, amountCredited: 0, balanceDue: 0, dueDate: "2026-10-01T00:00:00.000Z", overdue: false, canPay: true, download: false },
    { kind: "inactive", recordKind: "agreement", recordId: "a2", state: "withdrawn" },
  ],
}

function render(props: Partial<React.ComponentProps<typeof ClientActionHub>> = {}) {
  return renderToStaticMarkup(
    <LocalizedDocument locale={page.locale}>
      <ClientActionHub page={page} hrefFor={(ref) => `/c/t?item=${ref.kind}:${ref.recordId}`} downloadHref={(ref) => `/c/t/download/${ref.kind}/${ref.recordId}`} {...props} />
    </LocalizedDocument>,
  )
}

describe("client action page", () => {
  it("speaks the language of its documents and groups the records", () => {
    const html = render()
    expect(html).toContain("Dine dokumenter fra Acme ApS")
    expect(html).toContain("Venter på dig: 3")
    for (const heading of ["Aftaler", "Leverancer til godkendelse", "Fakturaer"]) expect(html).toContain(heading)
    expect(html).toContain("Afventer din beslutning")
    expect(html).toContain("Forfalden")
    expect(html).toContain("Adgang ændret")
    expect(html).not.toContain("Waiting for you")
  })

  it("shows the balance owed, not the total, and what was already paid", () => {
    const html = render()
    expect(html).toMatch(/Skyldigt beløb 1\.000,00\s*kr\./)
    expect(html).toMatch(/Betalt indtil nu 250,00\s*kr\./)
    expect(html).toMatch(/Betal 1\.000,00\s*kr\./)
    // A paid invoice offers no payment and no balance.
    const paid = html.slice(html.indexOf("INV-0"))
    expect(paid).toContain("Betalt")
    expect(paid).not.toContain("Betal 0")
  })

  it("renders every action as a native, labelled control that the keyboard can reach", () => {
    const html = render()
    expect(html).toContain('href="/c/t?item=agreement:a1"')
    expect(html).toContain('href="/c/t/download/invoice/i1"')
    expect(html).toContain('<section aria-labelledby="client-actions-invoice"')
    expect(html).toContain("<h1")
    expect(html).not.toContain('tabindex="-1"')
    expect(html).not.toMatch(/<div[^>]*onclick/i)
  })

  it("shows a withdrawn record without any detail of it", () => {
    const html = render()
    const start = html.indexOf('data-state="withdrawn"')
    const withdrawn = html.slice(start, html.indexOf("</article>", start))
    expect(withdrawn).toContain("Adgang ændret")
    expect(withdrawn).not.toContain("AGR-")
    expect(withdrawn).not.toContain("<a ")
  })

  it("keeps every control inert in the seller's preview", () => {
    const html = render({ preview: true })
    expect(html).not.toContain('href="/c/t?item=')
    expect(html).not.toContain('href="/c/t/download/')
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Betal 1\.000,00/)
    expect(html).toContain("Dine dokumenter fra Acme ApS")
  })

  it("can sit inside the seller's page without a second main landmark", () => {
    expect(render()).toContain("<main")
    expect(render({ embedded: true })).not.toContain("<main")
  })
})
