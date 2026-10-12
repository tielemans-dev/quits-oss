import { describe, expect, it, vi } from "vitest"
import { Prisma } from "../../../../generated/prisma/client"
import { invoiceFixture } from "../../accounting/__tests__/fixtures"
import { loadDocumentView } from "../view"

const { transaction } = vi.hoisted(() => ({ transaction: vi.fn() }))
vi.mock("../../../lib/db", () => ({ prisma: { $transaction: transaction } }))

const dec = (value: string) => new Prisma.Decimal(value)
function item(id: string, sortOrder: number, gross: string) {
  return {
    id, sortOrder, description: id, quantity: dec("1"), quantityInput: null,
    unitPriceInput: null, unitPriceNet: dec("999"), unitPriceGross: dec("999"),
    taxRate: dec("0"), vatTreatment: "standard", vatRateInput: null, vatCountry: null,
    vatReasonCode: null, lineNet: dec(gross), lineTax: dec("0"), lineGross: dec(gross),
  }
}

describe("persisted document line order", () => {
  for (const kind of ["invoice", "quote", "creditNote"] as const) {
    for (const reverse of [false, true]) {
      it(`orders historical ${kind} rows by position then ID (reverse retrieval: ${reverse})`, async () => {
        // IDs deliberately disagree with position; two legacy lines share a position.
        const rows = [item("z-first", 0, "12.50"), item("b-tied", 1, "124.99"), item("a-tied", 1, "10.00")]
        const snapshot = invoiceFixture()
        if (reverse) rows.reverse()
        const findFirst = vi.fn(async ({ include }: {
          include: { items: { orderBy: Record<string, "asc"> | Record<string, "asc">[] } }
        }) => {
          // Model a database returning tied rows in either physical order unless ordered explicitly.
          const orderBy = Array.isArray(include.items.orderBy) ? include.items.orderBy : [include.items.orderBy]
          const items = [...rows].sort((a, b) => {
            for (const order of orderBy) {
              const comparison = order.sortOrder ? a.sortOrder - b.sortOrder : a.id.localeCompare(b.id)
              if (comparison) return comparison
            }
            return 0
          })
          return {
            items, status: "sent", number: "INV-1", locale: "en-US", timezone: "UTC",
            currency: "USD", pricesIncludeTax: false, calculationVersion: "legacy_per_line",
            sellerSnapshot: null, buyerSnapshot: null, vatEvidence: null, contactId: "contact",
            notes: null, issueDate: new Date("2026-10-08T00:00:00Z"), lastEmailAttemptOutcome: null,
            subtotalNet: dec("147.49"), totalTax: dec("0"), totalGross: dec("147.49"),
            issuanceSnapshot: { ...snapshot, lines: [{ ...snapshot.lines[0], vat: null }] },
          }
        })
        transaction.mockImplementation(async run => run({
          [kind]: { findFirst }, orgSettings: { findUnique: async () => null },
          issuanceCandidate: { findFirst: async () => null },
        }))

        const result = await loadDocumentView({ kind: "system", organizationId: "org", reason: "migration", label: "Test" }, kind, "document")
        expect(result?.historical).toBe(kind !== "quote")
        expect(result?.view.lines.map(line => [line.id, line.gross])).toEqual([
          ["z-first", "12.50"], ["a-tied", "10.00"], ["b-tied", "124.99"],
        ])
        expect(result?.view.totals.gross).toBe("147.49")
        expect(findFirst).toHaveBeenCalledWith({ where: { id: "document", organizationId: "org" },
          include: { items: { orderBy: [{ sortOrder: "asc" }, { id: "asc" }] } },
        })
      })
    }
  }
})
