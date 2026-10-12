// MOCK: synthetic stored quote rows and settings; exercises the real view loader.
import { beforeEach, describe, expect, it, vi } from "vitest"
import { Effect } from "effect"
import { Prisma } from "../../../../generated/prisma/client"
import { loadDocumentView } from "../view"

const db = vi.hoisted(() => ({ quote: { findFirst: vi.fn() }, orgSettings: { findUnique: vi.fn() } }))
vi.mock("../../../lib/db", () => ({ prisma: { $transaction: (read: (db: unknown) => unknown) => read(db) } }))
vi.mock("../numbering", () => ({ peekNextDocumentNumber: () => Effect.succeed("Q-1") }))
const decimal = (value: string) => new Prisma.Decimal(value)
const actor = { kind: "system", reason: "migration", organizationId: "synthetic-org", label: "Synthetic" } as const
function quote(registered: boolean, status: string) {
  return { id: "quote", status, number: status === "draft" ? null : "Q-1", currency: "DKK", locale: "da-DK", timezone: "Europe/Copenhagen",
    pricesIncludeTax: false, calculationVersion: "v2", sellerSnapshot: { companyName: "Frozen seller", momsRegistered: registered }, buyerSnapshot: null,
    contactId: "buyer", notes: null, vatEvidence: {}, issueDate: new Date("2026-10-12T12:00:00Z"), expiryDate: new Date("2026-11-12T12:00:00Z"),
    subtotalNet: decimal("100"), totalTax: decimal("0"), totalGross: decimal("100"), items: [{
      id: "line", description: "Synthetic service", sortOrder: 0, quantity: decimal("1"), quantityInput: "1", unitPriceInput: "100", inputPrecision: "string",
      unitPriceNet: decimal("100"), unitPriceGross: decimal("100"), lineNet: decimal("100"), lineTax: decimal("0"), lineGross: decimal("100"),
      taxRate: decimal("0"), vatTreatment: "out_of_scope", vatRateInput: "0", vatCountry: null, vatReasonCode: null,
    }] }
}
beforeEach(() => vi.clearAllMocks())
describe("quote view effective registration", () => {
  it.each([true, false])("refreshes draft registration from %s without changing rows", async registered => {
    const stored = quote(registered, "draft")
    db.quote.findFirst.mockResolvedValue(stored)
    db.orgSettings.findUnique.mockResolvedValue({ momsRegistered: !registered })
    const result = await loadDocumentView(actor, "quote", "quote")
    expect(result?.view.seller.momsRegistered).toBe(!registered)
    expect(result?.view.totals?.gross).toBe("100.00")
    expect(stored.sellerSnapshot.momsRegistered).toBe(registered)
  })
  it.each([true, false])("keeps issued registration %s frozen after settings change", async registered => {
    db.quote.findFirst.mockResolvedValue(quote(registered, "sent"))
    db.orgSettings.findUnique.mockResolvedValue({ momsRegistered: !registered })
    const result = await loadDocumentView(actor, "quote", "quote")
    expect(result?.view.seller.momsRegistered).toBe(registered)
    expect(result?.view.state).toBe("issued")
    expect(result?.view.totals?.gross).toBe("100.00")
  })
})
