import { beforeEach, describe, expect, it, vi } from "vitest"
import { Prisma } from "../../../../generated/prisma/client"
import { paymentsRouter } from "../payments"
import { InvalidState } from "../../../domain/errors"

const persistence = vi.hoisted(() => ({
  member: vi.fn(),
  transaction: vi.fn(),
  orgSettings: vi.fn(),
  queryRaw: vi.fn(),
  receipt: vi.fn(),
  invoice: vi.fn(),
  paymentTotal: vi.fn(),
  refundTotal: vi.fn(),
}))

vi.mock("../../../lib/db", () => ({
  prisma: {
    member: { findFirst: persistence.member },
    $transaction: persistence.transaction,
  },
}))

// Only persistence is substituted. Callers run real auth, schemas, locking and preview functions.
const db = {
  orgSettings: { upsert: persistence.orgSettings },
  $queryRaw: persistence.queryRaw,
  settlementReceipt: { findFirst: persistence.receipt },
  invoice: { findFirst: persistence.invoice },
  payment: { aggregate: persistence.paymentTotal },
  settlementRefund: { aggregate: persistence.refundTotal },
}
const decimal = (value: string) => new Prisma.Decimal(value)
const evidence = { reason: "Reviewed statement", evidence: "https://example.test/statement" }
const allocation = {
  requestId: "request", receiptId: "receipt", ...evidence,
  allocations: [{ invoiceId: "invoice", receiptAmount: "40", invoiceAmount: "40" }],
}
const change = {
  requestId: "request", action: "refund" as const, receiptId: "receipt", amount: "40", ...evidence,
}

function caller() {
  return paymentsRouter.createCaller({
    session: {
      user: { id: "user", name: "Operator", email: "operator@example.test" },
      session: { activeOrganizationId: "org" },
    },
  } as never)
}

const previews = ["allocation", "change"] as const
function preview(kind: typeof previews[number]) {
  return kind === "allocation"
    ? caller().previewAllocation(allocation)
    : caller().previewReceiptChange(change)
}

describe("receipt preview error boundaries", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    persistence.member.mockResolvedValue({ role: "admin" })
    persistence.transaction.mockImplementation(async (run) => run(db))
    persistence.orgSettings.mockResolvedValue({})
    persistence.queryRaw.mockResolvedValue([])
    persistence.receipt.mockResolvedValue({
      id: "receipt", organizationId: "org", contactId: "contact", currency: "DKK",
      grossAmount: decimal("100"), feeAmount: decimal("2"), netAmount: decimal("98"),
      reversedAt: null, creditReason: null, creditEvidence: null,
    })
    persistence.invoice.mockResolvedValue({
      id: "invoice", contactId: "contact", currency: "DKK", status: "sent", number: "INV-1",
      totalGross: decimal("80"), amountPaid: decimal("0"), amountCredited: decimal("0"),
    })
    persistence.paymentTotal.mockResolvedValue({ _sum: { receiptAmount: null } })
    persistence.refundTotal.mockResolvedValue({ _sum: { amount: null } })
  })

  describe.each(previews)("%s preview", (kind) => {
    it.each(["database", "timeout", "unknown", "lookalike"])(
      "hides internal %s failures with no attached cause",
      async (failure) => {
        const internalMessage = "synthetic internal detail: database host, SQL and server path"
        if (failure === "database") {
          persistence.receipt.mockRejectedValue(new Prisma.PrismaClientKnownRequestError(
            internalMessage, { code: "P2024", clientVersion: "7.4.2" },
          ))
        } else if (failure === "timeout") {
          persistence.transaction.mockRejectedValue(new Error(internalMessage))
        } else if (failure === "lookalike") {
          persistence.receipt.mockRejectedValue({
            _tag: "InvalidState", code: "database_failed", message: internalMessage,
          })
        } else {
          persistence.queryRaw.mockRejectedValue(internalMessage)
        }
        const error = await preview(kind).catch((error: unknown) => error)
        expect(error).toMatchObject({
          code: "INTERNAL_SERVER_ERROR",
          message: kind === "allocation" ? "Could not preview allocation" : "Could not preview change",
        })
        expect(error).toHaveProperty("cause", undefined)
        expect(String(error)).not.toContain(internalMessage)
      },
    )

    it("keeps the public receipt-not-found refusal", async () => {
      persistence.receipt.mockResolvedValue(null)
      await expect(preview(kind)).rejects.toMatchObject({ code: "BAD_REQUEST", message: "Receipt not found" })
    })

    it("keeps actual InvalidState refusals public", async () => {
      persistence.orgSettings.mockRejectedValue(new InvalidState({
        code: "organization_unavailable", message: "The organization is unavailable",
      }))
      await expect(preview(kind)).rejects.toMatchObject({
        code: "BAD_REQUEST", message: "The organization is unavailable",
      })
    })

    it.each([
      "https://user:credential@example.test/statement",
      "\nhttps://example.test/statement",
    ])("refuses unsafe evidence before persistence (%j)", async (link) => {
      const request = kind === "allocation"
        ? caller().previewAllocation({ ...allocation, evidence: link })
        : caller().previewReceiptChange({ ...change, evidence: link })
      await expect(request).rejects.toMatchObject({ code: "BAD_REQUEST" })
      expect(persistence.transaction).not.toHaveBeenCalled()
    })

    it("requires a signed-in organization member", async () => {
      const anonymous = paymentsRouter.createCaller({ session: null })
      await expect(kind === "allocation"
        ? anonymous.previewAllocation(allocation)
        : anonymous.previewReceiptChange(change)).rejects.toMatchObject({ code: "UNAUTHORIZED" })
      persistence.member.mockResolvedValue(null)
      await expect(preview(kind)).rejects.toMatchObject({ code: "FORBIDDEN" })
      expect(persistence.transaction).not.toHaveBeenCalled()
    })

    it("keeps role permissions", async () => {
      persistence.member.mockResolvedValue({ role: "accountant" })
      await expect(preview(kind)).rejects.toMatchObject({ code: "FORBIDDEN" })
      expect(persistence.transaction).not.toHaveBeenCalled()
      persistence.member.mockResolvedValue({ role: "member" })
      if (kind === "allocation") {
        await expect(preview(kind)).resolves.toMatchObject({ availableAfter: "60.00" })
      } else {
        await expect(preview(kind)).rejects.toMatchObject({ code: "FORBIDDEN" })
        expect(persistence.transaction).not.toHaveBeenCalled()
      }
    })

    it("previews valid amounts and retains the reviewed classification", async () => {
      const result = await preview(kind)
      expect(result).toMatchObject({
        receiptId: "receipt", currency: "DKK", availableBefore: "100.00", availableAfter: "60.00",
        customerCreditBefore: { reason: null, evidence: null }, previewToken: expect.stringMatching(/^[a-f0-9]{64}$/),
      })
      if ("allocations" in result) {
        expect(result.allocations).toEqual([{
          invoiceId: "invoice", number: "INV-1", currency: "DKK", invoiceTotal: "80.00",
          receiptAmount: "40.00", invoiceAmount: "40.00", before: "80.00", after: "40.00", exchangeEvidence: null,
        }])
      } else {
        expect(result).toMatchObject({ customerCreditAfter: { reason: null, evidence: null }, invoice: null })
      }
    })
  })

  it("keeps disabled accounting treatments as domain refusals", async () => {
    await expect(caller().previewReceiptChange({
      requestId: "request", action: "writeoff", invoiceId: "invoice", amount: "40", ...evidence,
    })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "Writeoffs and discounts require an approved accounting policy and remain disabled",
    })
  })
})
