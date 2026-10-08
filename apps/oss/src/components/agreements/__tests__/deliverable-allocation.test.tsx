import { describe, expect, it, vi } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"

vi.mock("../../../lib/i18n/react", () => ({
  useI18n: () => ({ locale: "en-US", t: (key: string, values?: Record<string, string | number>) => values ? `${key} ${JSON.stringify(values)}` : key }),
}))
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, params }: { children: React.ReactNode; params: { invoiceId: string } }) => <a href={`/invoices/${params.invoiceId}`}>{children}</a>,
}))
vi.mock("../../../trpc/client", () => ({ trpc: {} }))

import { DeliverableAllocation } from "../deliverable-allocation"

type Props = Parameters<typeof DeliverableAllocation>[0]
const base = { state: "unbilled", generation: 0, holder: null, creditedQuantity: "0", quantity: "1", invoiceHasUntiedCredit: false, creditNotes: [], rebill: { eligible: false, blocker: "not_invoiced" }, rebills: [] }
const render = (allocation: Record<string, unknown>, capabilities: Record<string, boolean> = { releaseReservation: true, authorizeRebill: true }) =>
  renderToStaticMarkup(<DeliverableAllocation
    agreement={{ id: "agreement-1" } as Props["agreement"]}
    line={{ id: "line-1", title: "Design", allocation: { ...base, ...allocation } } as unknown as Props["line"]}
    capabilities={capabilities as Props["capabilities"]} onChanged={async () => {}} onError={() => {}} />)

describe("deliverable allocation", () => {
  it("names the draft that holds reserved work, links it and offers release to those who may", () => {
    const html = render({ state: "reserved", holder: { invoiceId: "draft-1", number: null, status: "draft" } })
    expect(html).toContain("agreements.allocation.heldBy")
    expect(html).toContain('href="/invoices/draft-1"')
    expect(html).toContain("invoices.number.draft")
    expect(html).toContain("agreements.allocation.release")
    expect(render({ state: "reserved", holder: { invoiceId: "draft-1", number: null, status: "draft" } }, {})).not.toContain("agreements.allocation.release")
  })
  it("says the holder is hidden instead of linking when the reader cannot open invoices", () => {
    const html = render({ state: "reserved" })
    expect(html).toContain("agreements.allocation.heldHidden")
    expect(html).not.toContain("href=")
    expect(html).not.toContain("agreements.allocation.release")
  })
  it("states that a partial credit does not release work and offers no rebill", () => {
    const html = render({ state: "partially_credited", holder: { invoiceId: "inv-1", number: "INV-0001", status: "sent" }, creditedQuantity: "0.5" })
    expect(html).toContain("agreements.allocation.partialCredit")
    expect(html).toContain("agreements.allocation.creditDoesNotRelease")
    expect(html).not.toContain("agreements.allocation.allowRebill")
  })
  it("offers a rebill decision only for fully credited work, and only to those who may decide", () => {
    const credited = { state: "credited", holder: { invoiceId: "inv-1", number: "INV-0001", status: "sent" }, creditNotes: [{ id: "cn-1", number: "CN-0001" }], rebill: { eligible: true, blocker: null } }
    expect(render(credited)).toContain("agreements.allocation.allowRebill")
    expect(render(credited, { releaseReservation: true })).not.toContain("agreements.allocation.allowRebill")
  })
  it("explains why credited work on a closed agreement cannot be rebilled", () => {
    const html = render({ state: "credited", creditNotes: [{ id: "cn-1", number: "CN-0001" }], rebill: { eligible: false, blocker: "agreement_not_accepted" } })
    expect(html).toContain("agreements.allocation.rebillAgreementClosed")
    expect(html).not.toContain("agreements.allocation.allowRebill")
  })
})
