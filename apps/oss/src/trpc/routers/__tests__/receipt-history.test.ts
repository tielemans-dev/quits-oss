import { beforeEach, describe, expect, it, vi } from "vitest"
import { Prisma } from "../../../../generated/prisma/client"
import { paymentsRouter } from "../payments"

const queries = vi.hoisted(() => ({
  invoice: vi.fn(),
  invoices: vi.fn(),
  receipts: vi.fn(),
  paymentTotal: vi.fn(),
  refundTotal: vi.fn(),
  transaction: vi.fn(),
  orgSettings: vi.fn(),
  lock: vi.fn(),
  evidenceDecision: vi.fn(),
  events: vi.fn(),
}))

vi.mock("../../../lib/db", () => ({
  prisma: {
    $transaction: queries.transaction,
  },
}))

const db = {
  invoice: { findFirst: queries.invoice, findMany: queries.invoices },
  settlementReceipt: { findMany: queries.receipts },
  payment: { aggregate: queries.paymentTotal },
  settlementRefund: { aggregate: queries.refundTotal },
  orgSettings: { upsert: queries.orgSettings },
  $queryRaw: queries.lock,
  settlementEvidenceDecision: { findFirst: queries.evidenceDecision },
  domainEvent: { findMany: queries.events },
}

vi.mock("../../../domain/user-actor", () => ({
  resolveUserActor: async () => ({
    kind: "user", userId: "reader", organizationId: "org", roles: ["admin"],
  }),
}))

const decimal = (value: string) => new Prisma.Decimal(value)
const now = new Date("2026-10-08T12:00:00Z")

function history(id: string, reversed = false) {
  return {
    id, reference: id, currency: "DKK",
    actorKey: "user:reader", createdAt: now,
    grossAmount: decimal("100"), feeAmount: decimal("2"), netAmount: decimal("98"),
    reversedAt: reversed ? now : null,
    creditReason: "Retain remainder", reason: "Bank statement", evidence: "statement:1",
    payments: [
      // Invoice-side currency/amount differs: the receipt consumed 17.25 DKK, not 100 EUR.
      { id: `${id}-fx`, invoiceId: "invoice", invoice: { number: "INV-1" },
        amount: decimal("100"), receiptAmount: decimal("17.25"), currency: "EUR", voidedAt: null },
      { id: `${id}-active`, invoiceId: "invoice", invoice: { number: "INV-1" },
        amount: decimal("10.10"), receiptAmount: decimal("10.10"), currency: "DKK", voidedAt: null },
      { id: `${id}-void`, invoiceId: "invoice", invoice: { number: "INV-1" },
        amount: decimal("99"), receiptAmount: decimal("99"), currency: "DKK", voidedAt: now },
      { id: `${id}-legacy`, invoiceId: "invoice", invoice: { number: "INV-1" },
        amount: decimal("50"), receiptAmount: null, currency: "DKK", voidedAt: null },
    ],
    refunds: [
      { id: `${id}-refund`, amount: decimal("5.05"), reversedAt: null },
      { id: `${id}-refund-void`, amount: decimal("11"), reversedAt: now },
    ],
  }
}

describe("receipt history query budget", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    queries.transaction.mockImplementation(async (run) => run(db))
    queries.orgSettings.mockResolvedValue({})
    queries.lock.mockResolvedValue([])
    queries.evidenceDecision.mockResolvedValue(null)
    queries.events.mockResolvedValue([])
    queries.invoice.mockResolvedValue({ contactId: "contact" })
    queries.invoices.mockResolvedValue([])
    queries.paymentTotal.mockResolvedValue({ _sum: { receiptAmount: decimal("27.35") } })
    queries.refundTotal.mockResolvedValue({ _sum: { amount: decimal("5.05") } })
  })

  it.each([1, 80])("loads %i receipts without per-receipt balance queries", async (count) => {
    queries.receipts.mockResolvedValue([
      ...Array.from({ length: count }, (_, index) => history(`receipt-${index}`)),
      history("reversed", true),
      { ...history("unused"), payments: [], refunds: [], creditReason: null },
    ])
    const caller = paymentsRouter.createCaller({
      session: {
        user: { id: "reader", name: "Reader", email: "reader@example.test" },
        session: { activeOrganizationId: "org" },
      },
    } as never)
    const result = await caller.receipts({ invoiceId: "invoice" })

    expect(queries.transaction).toHaveBeenCalledTimes(1)
    expect(queries.orgSettings).toHaveBeenCalledWith({
      where: { organizationId: "org" }, create: { organizationId: "org" }, update: {},
    })
    expect(queries.lock).toHaveBeenCalledTimes(1)
    expect(queries.lock.mock.invocationCallOrder[0]).toBeLessThan(queries.invoice.mock.invocationCallOrder[0]!)
    expect(queries.invoice).toHaveBeenCalledTimes(1)
    expect(queries.invoices).toHaveBeenCalledTimes(1)
    expect(queries.receipts).toHaveBeenCalledTimes(1)
    expect(queries.paymentTotal).not.toHaveBeenCalled()
    expect(queries.refundTotal).not.toHaveBeenCalled()
    expect(queries.receipts.mock.calls[0]?.[0].where).toEqual({
      organizationId: "org", contactId: "contact",
    })
    expect(result.receipts).toHaveLength(count + 2)
    for (const receipt of result.receipts.slice(0, count)) {
      expect(receipt).toMatchObject({
        allocated: "27.35", refunded: "5.05", available: "67.60", customerCredit: true,
        provenance: { state: "received", recordedBy: "user:reader", recordedAt: now.toISOString() },
        history: [],
      })
      expect(receipt.allocations).toHaveLength(4)
      expect(receipt.allocations[2]).toMatchObject({ amount: "99.00", reversed: true })
      expect(receipt.refunds[1]).toMatchObject({ amount: "11.00", reversed: true })
    }
    expect(result.receipts[count]).toMatchObject({
      allocated: "27.35", refunded: "5.05", available: "0.00", reversed: true, customerCredit: false,
    })
    expect(result.receipts[count + 1]).toMatchObject({
      allocated: "0.00", refunded: "0.00", available: "100.00", customerCredit: false,
    })
    expect(queries.events).toHaveBeenCalledTimes(count + 2)
    for (const receipt of result.receipts) {
      expect(queries.events).toHaveBeenCalledWith(expect.objectContaining({
        where: {
          organizationId: "org", type: { startsWith: "settlement." },
          payload: { path: ["receiptId"], equals: receipt.id },
        },
        orderBy: { sequence: "asc" },
      }))
    }
  })
})
