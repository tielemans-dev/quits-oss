// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { ReceiptsPanel } from "../receipts-panel"
import { ActivityList } from "../../../activity/activity-list"

const api = vi.hoisted(() => ({ receipts: vi.fn(), preview: vi.fn() }))
vi.mock("../../../../trpc/client", () => ({
  trpc: { payments: {
    receipts: { query: api.receipts },
    previewAllocation: { query: api.preview },
  } },
}))
vi.mock("../../../../lib/i18n/react", () => ({
  useI18n: () => ({ t: translate, locale: "en-US" }),
}))
function translate(key: string) { return key }

afterEach(() => { cleanup(); vi.resetAllMocks() })

const safeLink = "https://example.test/statement?sig=intentionally-shared"
async function panel(evidence: string) {
  api.receipts.mockResolvedValue({
    contactId: "contact", canCreate: true, canReverse: false, invoices: [],
    receipts: [{
      id: "receipt", reference: "BANK-1", currency: "DKK", gross: "100.00", fee: "0.00", net: "100.00",
      available: "100.00", allocated: "0.00", refunded: "0.00", reversed: false, customerCredit: false,
      reason: "Bank statement", evidence, allocations: [], refunds: [],
    }],
  })
  render(<ReceiptsPanel invoiceId="invoice" currency="DKK" today="2026-10-08" balanceDue={100} onChanged={async () => undefined} />)
  await screen.findByText("Bank statement")
}

describe("receipt evidence anchors", () => {
  it.each([
    "javascript:alert(1)",
    "https://user:credential@example.test/statement",
    "https://exam\nple.test/statement",
  ])("keeps invalid stored evidence non-navigable (%j)", async (evidence) => {
    await panel(evidence)
    expect(screen.queryByRole("link", { name: "Bank statement" })).toBeNull()
    expect(screen.getByText("Bank statement")).toBeTruthy()

    api.preview.mockResolvedValue({
      customerCreditBefore: { reason: "Retained for later", evidence },
      allocations: [], availableAfter: "100.00",
    })
    fireEvent.click(screen.getByRole("button", { name: "payments.receipts.allocate" }))
    fireEvent.submit(screen.getByRole("button", { name: "payments.receipts.preview" }).closest("form")!)
    await screen.findByText("Retained for later")
    expect(screen.queryAllByRole("link")).toHaveLength(0)
  })

  it("keeps valid intentionally shared links navigable in receipt and classification previews", async () => {
    await panel(safeLink)
    expect(screen.getByRole("link", { name: "Bank statement" }).getAttribute("href")).toBe(safeLink)
    api.preview.mockResolvedValue({
      customerCreditBefore: { reason: "Retained for later", evidence: safeLink },
      allocations: [], availableAfter: "100.00",
    })
    fireEvent.click(screen.getByRole("button", { name: "payments.receipts.allocate" }))
    fireEvent.submit(screen.getByRole("button", { name: "payments.receipts.preview" }).closest("form")!)
    const link = await screen.findByRole("link", { name: safeLink })
    expect(link.getAttribute("href")).toBe(safeLink)
    expect(link.getAttribute("rel")).toBe("noreferrer")
  })

  it.each([safeLink, "https://user:credential@example.test/statement", "https://exam\nple.test/statement"])(
    "uses the same evidence validation in activity (%j)", (evidence) => {
      render(<ActivityList events={[{
        sequence: 1, type: "settlement.changed", aggregateType: "settlement_receipt", aggregateId: "receipt",
        schemaVersion: 1, approvedBy: null, commandId: null,
        occurredAt: "2026-10-08T12:00:00Z", actor: { kind: "user", id: "operator", label: null, name: "Operator" },
        payload: { action: "customer_credit", currency: "DKK", amount: "100.00", reason: "Bank statement", evidence },
      }]} />)
      const link = screen.queryByRole("link", { name: "Bank statement" })
      if (evidence === safeLink) expect(link?.getAttribute("href")).toBe(safeLink)
      else expect(link).toBeNull()
    },
  )
})
