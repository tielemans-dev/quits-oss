import { randomUUID } from "node:crypto"
import { PrismaPg } from "@prisma/adapter-pg"
import { afterEach, describe, expect, it, vi } from "vitest"
import { DASHBOARD_ACTIVITY_EVENT_TYPES, dashboardSummarySchema, type DashboardTotal } from "@quits/contracts/dashboard"
import { type ReceiptRecordInput, type ReceiptAllocateInput, type ReceiptActionInput } from "@quits/contracts/payments"
import { Prisma, PrismaClient } from "../../../../generated/prisma/client"
import { prisma } from "../../../lib/db"
import { executeCommand } from "../../../domain/execute"
import { markOrganizationInvoicesOverdue } from "../../../domain/features/overdue"
import { dashboardSummary } from "../../../lib/dashboard/summary"
import { createTestOrganization, hasTestDatabase } from "../../../test-utils/organization"
import { appRouter } from "../../router"
import { eventRegistry } from "../../../domain/events/registry"
import { fetchRequestHandler } from "@trpc/server/adapters/fetch"
import superjson, { type SuperJSONResult } from "superjson"

const receiptEvidence = { reason: "Bank statement reconciled", evidence: "https://evidence.example.test/statement" }
const decision = () => ({ requestId: randomUUID(), ...receiptEvidence })
const NOW = new Date("2026-10-08T12:00:00Z")
const zero = { count: 0, buckets: [], unvalued: [] }
const amount = (total: DashboardTotal, currency = "DKK") => total.buckets.find(bucket => bucket.currency === currency)?.amount ?? "0.00"

describe.skipIf(!hasTestDatabase)("dashboard.summary", () => {
  const cleanups: Array<() => Promise<void>> = []
  afterEach(async () => {
    vi.unstubAllEnvs()
    while (cleanups.length) await cleanups.pop()!()
  })

  function caller(organizationId: string, userId: string) {
    return appRouter.createCaller({ session: {
      user: { id: userId, name: userId, email: `${userId}@example.com` },
      session: { activeOrganizationId: organizationId },
    } } as never)
  }

  async function setup() {
    const org = await createTestOrganization({ roles: ["admin", "member", "accountant"], settings: { currency: "DKK", timezone: "Europe/Copenhagen" } })
    cleanups.push(org.cleanup)
    const contact = await prisma.contact.create({ data: { organizationId: org.organizationId, name: "Kvit buyer", email: "buyer@example.com" } })
    const admin = caller(org.organizationId, org.actors.admin.userId)
    const seed = (overrides: Partial<Prisma.InvoiceUncheckedCreateInput> = {}) => prisma.invoice.create({ data: {
      organizationId: org.organizationId, contactId: contact.id, number: `INV-${randomUUID()}`, status: "sent",
      currency: "DKK", timezone: "Europe/Copenhagen", dueDate: new Date("2026-10-15T00:00:00Z"),
      totalGross: "100.00", subtotalNet: "100.00", ...overrides,
    } })
    const payment = (invoiceId: string, paidAt: string, value = "10.00", currency = "DKK", voidedAt: Date | null = null) => prisma.payment.create({ data: {
      organizationId: org.organizationId, invoiceId, paidAt: new Date(paidAt), amount: value, currency, method: "bank_transfer", source: "user", voidedAt,
    } })
    const receipt = (netAmount: string, overrides: Partial<ReceiptRecordInput> = {}) => admin.payments.recordReceipt({
      ...decision(), contactId: contact.id, currency: "DKK", netAmount, feeAmount: "0",
      paidAt: "2026-10-04", reference: randomUUID(), method: "bank_transfer", ...overrides,
    })
    const allocate = async (receiptId: string, allocations: ReceiptAllocateInput["allocations"]) => {
      const input = { ...decision(), receiptId, allocations }
      const preview = await admin.payments.previewAllocation(input)
      return admin.payments.allocateReceipt({ ...input, previewToken: preview.previewToken })
    }
    const change = async (input: ReceiptActionInput) => {
      const preview = await admin.payments.previewReceiptChange(input)
      return admin.payments.changeReceipt({ ...input, previewToken: preview.previewToken })
    }
    return { ...org, contact, admin, seed, payment, receipt, allocate, change, summary: (now = NOW) => dashboardSummary(prisma, org.actors.admin, now) }
  }

  it("returns empty results for every invoice-reading role without writes", async () => {
    const org = await setup()
    await prisma.orgSettings.delete({ where: { organizationId: org.organizationId } })
    for (const role of ["admin", "member", "accountant"] as const) {
      const result = await caller(org.organizationId, org.actors[role].userId).dashboard.summary()
      expect(result).toMatchObject({ currencyMode: "per_currency", timezone: "UTC", baseCurrency: "USD", outstanding: zero, overdue: { ...zero, oldestDaysOverdue: 0 }, paidThisMonth: zero, hasOtherCurrencies: false, streak: 0, attention: [], incoming: [], activity: [] })
      expect(result.receivedByMonth).toHaveLength(12)
      expect(result.receivedByMonth.every(row => row.count === 0 && row.buckets.length === 0)).toBe(true)
    }
    expect(await prisma.orgSettings.count({ where: { organizationId: org.organizationId } })).toBe(0)
    await expect(caller(org.organizationId, "not-a-member").dashboard.summary()).rejects.toMatchObject({ code: "FORBIDDEN" })
    await expect(appRouter.createCaller({ session: null }).dashboard.summary()).rejects.toMatchObject({ code: "UNAUTHORIZED" })
  })

  it("reconciles payment and credit commands with both lists, including a void", async () => {
    const org = await setup()
    const invoice = await org.admin.invoices.create({ contactId: org.contact.id, currency: "DKK", dueDate: "2026-10-15", items: [{ description: "Work", quantity: 1, unitPrice: 100 }] })
    await org.admin.invoices.send({ id: invoice.id, allowSendWithoutEmail: true })
    const recorded = await org.admin.payments.record({ invoiceId: invoice.id, amount: 30.25, paidAt: "2026-10-01", method: "bank_transfer" })
    await org.admin.creditNotes.issue({ invoiceId: invoice.id, mode: "amount", amount: 20.15, reason: "Partial return" })
    await org.seed({ status: "draft", number: null, totalGross: "999.99" })
    const second = await org.seed({ currency: "EUR", totalGross: "12.34" })
    const check = async (expected: string) => {
      const list = await org.admin.invoices.list()
      const summary = await org.summary()
      expect(dashboardSummarySchema.safeParse(summary).success).toBe(true)
      for (const bucket of summary.outstanding.buckets) {
        const sum = list.filter(row => row.status !== "draft" && row.currency === bucket.currency)
          .reduce((total, row) => total.plus(String(row.balanceDue)), new Prisma.Decimal(0))
        expect(bucket.amount).toBe(sum.toFixed(bucket.exponent))
      }
      expect(amount(summary.outstanding)).toBe(expected)
      expect(summary.incoming.find(row => row.documentId === invoice.id)).toMatchObject({
        total: { currency: "DKK", exponent: 2, amount: "100.00" }, amount: { amount: expected },
      })
      expect(amount(summary.outstanding, "EUR")).toBe("12.34")
      expect(summary.incoming.find(row => row.documentId === second.id)?.amount.amount).toBe("12.34")
      const payments = await org.admin.payments.list({ invoiceId: invoice.id })
      expect(payments.balanceDue.toFixed(2)).toBe(expected)
      return summary
    }
    expect(amount((await check("49.60")).paidThisMonth)).toBe("30.25")
    await org.admin.payments.void({ paymentId: recorded.payment.id, reason: "Wrong receipt" })
    expect((await check("79.85")).paidThisMonth).toEqual(zero)
    await org.admin.creditNotes.issue({ invoiceId: invoice.id, mode: "full", reason: "Remaining return" })
    expect(amount((await org.summary()).outstanding)).toBe("0.00")
  })

  it("counts a split receipt once at net, including its unallocated cash", async () => {
    const org = await setup()
    const first = await org.seed(), second = await org.seed()
    const receipt = await org.receipt("145", { feeAmount: "5", feeEvidence: receiptEvidence })
    await org.allocate(receipt.receiptId, [
      { invoiceId: first.id, receiptAmount: "50", invoiceAmount: "50" },
      { invoiceId: second.id, receiptAmount: "75", invoiceAmount: "75" },
    ])
    const result = await org.summary()
    expect(result.paidThisMonth.buckets).toEqual([{ currency: "DKK", exponent: 2, amount: "145.00", count: 1 }])
    expect(result.receivedByMonth.at(-1)).toMatchObject(result.paidThisMonth)
    expect(result.paidThisMonth.unvalued).toEqual(result.paidThisMonth.buckets)
    expect(amount(result.outstanding)).toBe("75.00")
    expect((await org.admin.dashboard.stats()).currencyBuckets).toEqual([
      { currency: "DKK", totalRevenue: "145", outstanding: "75" },
    ])
  })

  it("reconciles receipt corrections, credits and legacy payments with invoice details and the list", async () => {
    const org = await setup()
    const legacy = await org.seed({ dueDate: new Date("2026-10-01") })
    const fee = await org.seed({ dueDate: new Date("2026-10-03") })
    const splitA = await org.seed({ dueDate: new Date("2026-10-04") })
    const splitB = await org.seed({ dueDate: new Date("2026-10-05") })
    const corrected = await org.seed({ dueDate: new Date("2026-10-06") })
    const partial = await org.seed({ dueDate: new Date("2026-10-07") })
    const voided = await org.seed({ dueDate: new Date("2026-10-07") })
    const credited = await org.admin.invoices.create({ contactId: org.contact.id, currency: "DKK", dueDate: "2026-10-06", items: [{ description: "Work", quantity: 1, unitPrice: 100 }] })
    await org.admin.invoices.send({ id: credited.id, allowSendWithoutEmail: true })
    for (const [invoiceId, value, paidAt] of [[legacy.id, 100, "2026-09-30"], [credited.id, 20, "2026-10-04"], [partial.id, 25, "2026-10-06"]] as const) {
      await org.admin.payments.record({ invoiceId, amount: value, paidAt, method: "bank_transfer" })
    }
    await org.admin.creditNotes.issue({ invoiceId: credited.id, mode: "amount", amount: 30, reason: "Partial return" })
    const wrongLegacy = await org.admin.payments.record({ invoiceId: voided.id, amount: 10, paidAt: "2026-10-01", method: "cash" })
    await org.admin.payments.void({ paymentId: wrongLegacy.payment.id, reason: "Duplicate" })
    const feeReceipt = await org.receipt("95", { feeAmount: "5", feeEvidence: receiptEvidence, paidAt: "2026-10-02" })
    await org.allocate(feeReceipt.receiptId, [{ invoiceId: fee.id, receiptAmount: "100", invoiceAmount: "100" }])
    const splitReceipt = await org.receipt("120", { paidAt: "2026-10-03" })
    const split = await org.allocate(splitReceipt.receiptId, [
      { invoiceId: splitA.id, receiptAmount: "100", invoiceAmount: "100" },
      { invoiceId: splitB.id, receiptAmount: "20", invoiceAmount: "20" },
    ])
    const wrongReceipt = await org.receipt("100", { paidAt: "2026-10-05" })
    const wrongAllocation = await org.allocate(wrongReceipt.receiptId, [{ invoiceId: corrected.id, receiptAmount: "100", invoiceAmount: "100" }])
    expect((await org.summary()).streak).toBe(4)
    await org.change({ ...decision(), action: "reverse_allocation", paymentId: wrongAllocation.paymentIds[0]! })
    await org.change({ ...decision(), action: "reverse_receipt", receiptId: wrongReceipt.receiptId })
    const replacement = await org.receipt("30", { paidAt: "2026-10-04" })
    await org.allocate(replacement.receiptId, [{ invoiceId: corrected.id, receiptAmount: "30", invoiceAmount: "30" }])

    const residual = await org.receipt("10")
    await org.change({ ...decision(), action: "refund", receiptId: residual.receiptId, amount: "4" })
    await org.change({ ...decision(), action: "customer_credit", receiptId: residual.receiptId })

    const expected = new Map([[legacy.id, "0.00"], [fee.id, "0.00"], [splitA.id, "0.00"], [splitB.id, "80.00"], [corrected.id, "70.00"], [credited.id, "50.00"], [partial.id, "75.00"], [voided.id, "100.00"]])
    const result = await org.summary()
    const list = await org.admin.invoices.list()
    let detailTotal = new Prisma.Decimal(0)
    for (const [id, balance] of expected) {
      const detail = await org.admin.invoices.get({ id })
      const payments = await org.admin.payments.list({ invoiceId: id })
      expect(detail.balanceDue.toFixed(2)).toBe(balance)
      expect(payments.balanceDue.toFixed(2)).toBe(balance)
      expect(list.find(row => row.id === id)?.balanceDue.toFixed(2)).toBe(balance)
      expect(result.incoming.find(row => row.documentId === id)?.amount.amount ?? "0.00").toBe(balance)
      detailTotal = detailTotal.plus(String(detail.balanceDue))
    }
    expect(detailTotal.toFixed(2)).toBe("375.00")
    expect(result.outstanding.buckets).toEqual([{ currency: "DKK", exponent: 2, amount: "375.00", count: 5 }])
    expect(result.overdue.buckets).toEqual([{ currency: "DKK", exponent: 2, amount: "375.00", count: 5, oldestDaysOverdue: 3 }])
    expect(result.paidThisMonth.buckets).toEqual([{ currency: "DKK", exponent: 2, amount: "300.00", count: 6 }])
    expect(result.receivedByMonth.at(-2)?.buckets).toEqual([{ currency: "DKK", exponent: 2, amount: "100.00", count: 1 }])
    // Fee-inclusive debt settlement qualifies, although cash received is only 95, not 100.
    expect(result.streak).toBe(3)
    expect((await org.admin.dashboard.stats()).totalRevenue).toBe(400)
    await org.change({ ...decision(), action: "reverse_allocation", paymentId: split.paymentIds[0]! })
    const reopened = await org.summary()
    expect(amount(reopened.outstanding)).toBe("475.00")
    expect(amount(reopened.overdue)).toBe("475.00")
    expect((await org.admin.invoices.get({ id: splitA.id })).balanceDue).toBe(100)
    expect(reopened.paidThisMonth).toEqual(result.paidThisMonth)
    expect(reopened.streak).toBe(2)
  })

  it("keeps receipt currencies and local month boundaries, excluding foreign, future and old receipts", async () => {
    const org = await setup(), other = await setup()
    const invoice = await org.seed({ totalGross: "300", subtotalNet: "300" })
    const euro = await org.receipt("30", { currency: "EUR", feeAmount: "1", feeEvidence: receiptEvidence })
    await org.allocate(euro.receiptId, [{ invoiceId: invoice.id, receiptAmount: "20", invoiceAmount: "150", exchangeEvidence: receiptEvidence }])
    await other.receipt("999", { currency: "EUR" })
    await org.receipt("7", { currency: "JPY" })
    await org.receipt("10", { paidAt: "2026-09-30T21:59:59.999Z" })
    await org.receipt("20", { paidAt: "2026-09-30T22:00:00Z" })
    // A fee-only receipt still counts once, with zero cash received.
    await org.receipt("0", { feeAmount: "3", feeEvidence: receiptEvidence })
    await org.receipt("11", { paidAt: "2025-10-31T23:00:00Z" })
    await org.receipt("888", { paidAt: "2025-10-31T22:59:59.999Z" })
    await org.receipt("777", { paidAt: "2026-10-08T13:00:00Z" })
    const result = await org.summary()
    expect(result.paidThisMonth.buckets).toEqual([
      { currency: "DKK", exponent: 2, amount: "20.00", count: 2 },
      { currency: "EUR", exponent: 2, amount: "30.00", count: 1 },
      { currency: "JPY", exponent: 0, amount: "7", count: 1 },
    ])
    expect(result.paidThisMonth.count).toBe(4)
    expect(result.paidThisMonth.unvalued).toEqual(result.paidThisMonth.buckets)
    expect(result.receivedByMonth.at(-1)).toMatchObject(result.paidThisMonth)
    expect(result.receivedByMonth.at(-2)?.buckets).toEqual([{ currency: "DKK", exponent: 2, amount: "10.00", count: 1 }])
    expect(result.receivedByMonth[0]).toMatchObject({ month: "2025-11", buckets: [{ currency: "DKK", exponent: 2, amount: "11.00", count: 1 }] })
    expect(result.receivedByMonth.slice(1, -2).every(row => row.count === 0)).toBe(true)
    expect(result.hasOtherCurrencies).toBe(true)
    expect(amount(result.outstanding)).toBe("150.00")
    expect((await org.admin.invoices.get({ id: invoice.id })).balanceDue).toBe(150)
    expect((await org.admin.invoices.list()).find(row => row.id === invoice.id)?.balanceDue).toBe(150)
  })

  it("keeps cash receipts through refunds and reclassification, removing reversed receipts from their original month", async () => {
    const org = await setup()
    const receipt = await org.receipt("90", { paidAt: "2026-09-01" })
    const refund = await org.change({ ...decision(), action: "refund", receiptId: receipt.receiptId, amount: "10" })
    await org.change({ ...decision(), action: "customer_credit", receiptId: receipt.receiptId })
    const afterRefund = await org.summary()
    expect(afterRefund.paidThisMonth).toEqual(zero)
    expect(afterRefund.receivedByMonth.at(-2)?.buckets).toEqual([{ currency: "DKK", exponent: 2, amount: "90.00", count: 1 }])
    await org.change({ ...decision(), action: "reverse_refund", refundId: refund.targetId })
    expect((await org.summary()).receivedByMonth).toEqual(afterRefund.receivedByMonth)
    await org.change({ ...decision(), action: "reverse_receipt", receiptId: receipt.receiptId })
    expect((await org.summary()).receivedByMonth.every(row => row.count === 0)).toBe(true)
    expect((await org.admin.dashboard.stats()).totalRevenue).toBe(0)
    await org.receipt("40", { paidAt: "2026-09-01" })
    expect((await org.summary()).receivedByMonth.at(-2)?.buckets).toEqual([{ currency: "DKK", exponent: 2, amount: "40.00", count: 1 }])
  })

  it("normalizes legacy currency codes and skips malformed rows without breaking the summary", async () => {
    const org = await setup()
    await prisma.orgSettings.update({ where: { organizationId: org.organizationId }, data: { baseCurrency: " dkk " } })
    const lower = await org.seed({ currency: " dkk ", totalGross: "10" })
    await org.seed({ currency: "DKK", totalGross: "20" })
    await org.seed({ currency: "broken currency", totalGross: "999", dueDate: new Date("2026-10-01") })
    await org.payment(lower.id, "2026-10-01", "1", " dkk ")
    await org.payment(lower.id, "2026-10-01", "2", "DKK")
    await org.payment(lower.id, "2026-10-01", "999", "???")
    await prisma.quote.create({ data: { organizationId: org.organizationId, contactId: org.contact.id,
      status: "sent", expiryDate: new Date("2026-10-10"), currency: "???", subtotalNet: "999", totalGross: "999" } })
    const result = await org.summary()
    expect(dashboardSummarySchema.safeParse(result).success).toBe(true)
    expect(result.baseCurrency).toBe("DKK")
    expect(result.outstanding.buckets).toEqual([{ currency: "DKK", exponent: 2, amount: "30.00", count: 2 }])
    expect(result.paidThisMonth.buckets).toEqual([{ currency: "DKK", exponent: 2, amount: "3.00", count: 2 }])
    expect(result.incoming).toHaveLength(2)
    expect(result.incoming.every(row => row.amount.currency === "DKK")).toBe(true)
    expect(result.attention).toEqual([])
    expect(result.hasOtherCurrencies).toBe(false)
  })

  it("retains unsupported currencies only in unvalued totals without rounding or breaking the response", async () => {
    const org = await setup()
    await org.seed({ currency: "KWD", totalGross: "12.34", amountPaid: "1.20" })
    await org.seed({ currency: "ZZZ", totalGross: "9.87" })
    const invoice = await org.seed({ totalGross: "40" })
    await org.payment(invoice.id, "2026-10-01", "1.23", "KWD")
    const result = await org.summary()
    expect(dashboardSummarySchema.safeParse(result).success).toBe(true)
    expect(result.outstanding.count).toBe(3)
    expect(result.outstanding.buckets).toEqual([{ currency: "DKK", exponent: 2, amount: "40.00", count: 1 }])
    expect(result.outstanding.unvalued).toEqual([
      { currency: "DKK", exponent: 2, amount: "40.00", count: 1 },
      { currency: "KWD", exponent: 3, amount: "11.140", count: 1 },
      { currency: "ZZZ", exponent: 2, amount: "9.87", precisionSource: "storage", count: 1 },
    ])
    expect(result.paidThisMonth).toEqual({ count: 1, buckets: [], unvalued: [{ currency: "KWD", exponent: 3, amount: "1.230", count: 1 }] })
    expect(result.incoming.find(row => row.amount.currency === "ZZZ")?.amount).toMatchObject({ amount: "9.87", precisionSource: "storage" })
  })

  it("keeps currencies separate and missing, unknown and wrong-base valuations visible", async () => {
    const org = await setup()
    await org.seed({ currency: "EUR", totalGross: "100.10", valuation: { rateSource: "manual", base: { currency: "DKK", minor: "74500" } } })
    await org.seed({ currency: "EUR", totalGross: "0.20" })
    await org.seed({ currency: "EUR", totalGross: "0.30", valuation: { rateSource: "unknown", base: { currency: "DKK", minor: null } } })
    await org.seed({ totalGross: "50.00", valuation: { rateSource: "manual", base: { currency: "USD", minor: "5000" } } })
    const yen = await org.seed({ currency: "JPY", totalGross: "123.00" })
    await org.admin.payments.record({ invoiceId: yen.id, amount: 10, paidAt: "2026-10-02", method: "cash" })
    const result = await org.summary()
    expect(result.outstanding.buckets).toEqual([
      { currency: "DKK", exponent: 2, amount: "50.00", count: 1 },
      { currency: "EUR", exponent: 2, amount: "100.60", count: 3 },
      { currency: "JPY", exponent: 0, amount: "113", count: 1 },
    ])
    expect(result.outstanding.unvalued.find(row => row.currency === "EUR")).toMatchObject({ amount: "0.50", count: 2 })
    expect(result.paidThisMonth.buckets).toEqual([{ currency: "JPY", exponent: 0, amount: "10", count: 1 }])
    expect(result.paidThisMonth.unvalued).toEqual(result.paidThisMonth.buckets)
  })

  it.each([
    ["America/New_York", "2026-11-10T18:00:00Z", "2026-11-07T18:00:00Z"],
    ["Pacific/Pago_Pago", "2026-11-10T18:00:00Z", "2026-11-07T18:00:00Z"],
    ["Asia/Tokyo", "2026-11-10T08:00:00Z", "2026-11-07T08:00:00Z"],
  ])("preserves calendar due/expiry days and on-time settlement in %s", async (timezone, now, paidAt) => {
    const org = await setup()
    await prisma.orgSettings.update({ where: { organizationId: org.organizationId }, data: { timezone } })
    const invoice = await org.seed({ dueDate: new Date("2026-11-07") })
    await org.seed({ dueDate: new Date("2026-11-07"), amountPaid: "100", paidAt: new Date(paidAt), status: "paid" })
    const result = await org.summary(new Date(now))
    expect(result.incoming[0]).toMatchObject({ documentId: invoice.id, dueDate: "2026-11-07", daysOverdue: 3, isOverdue: true })
    expect(result.attention[0]).toMatchObject({ dueDate: "2026-11-07", daysOverdue: 3 })
    expect(result.streak).toBe(1)
    await prisma.invoice.delete({ where: { id: invoice.id } })
    for (const day of [9, 10, 17, 18]) await prisma.quote.create({ data: {
      organizationId: org.organizationId, contactId: org.contact.id, status: "sent", number: `Q-${day}`,
      expiryDate: new Date(`2026-11-${day.toString().padStart(2, "0")}`), subtotalNet: "50", totalGross: "50",
    } })
    expect((await org.summary(new Date(now))).attention.map(row => [row.number, row.expiresOn]))
      .toEqual([["Q-10", "2026-11-10"], ["Q-17", "2026-11-17"]])
  })

  it("keeps scheduler and dashboard on the same strict due-timestamp boundary", async () => {
    const org = await setup()
    const dueDate = new Date("2026-10-25T00:00:00Z")
    const invoice = await org.seed({ dueDate })
    for (const [now, marked] of [[dueDate, 0], [new Date(dueDate.getTime() + 1), 1]] as const) {
      expect((await org.summary(now)).overdue.count).toBe(marked)
      const outcome = await executeCommand(markOrganizationInvoicesOverdue, {}, { actor: org.actors.admin, now })
      expect(outcome).toMatchObject({ status: "completed", result: { marked } })
      expect((await org.admin.invoices.get({ id: invoice.id })).status).toBe(marked ? "overdue" : "sent")
    }
  })

  it("keeps the UTC due-timestamp predicate while counting Copenhagen calendar days across DST", async () => {
    const org = await setup()
    const invoice = await org.seed({ dueDate: new Date("2026-10-25T00:00:00Z") })
    for (const now of ["2026-10-24T23:59:59.999Z", "2026-10-25T00:00:00Z"]) {
      const before = await org.summary(new Date(now))
      expect(before.incoming[0]?.isOverdue).toBe(false)
      expect(before.attention).toEqual([])
      expect(before.overdue).toEqual({ ...zero, oldestDaysOverdue: 0 })
    }
    const justPastDue = await org.summary(new Date("2026-10-25T00:00:00.001Z"))
    expect(justPastDue.incoming[0]).toMatchObject({ daysOverdue: 0, isOverdue: true })
    expect(justPastDue.attention[0]).toMatchObject({ dueDate: "2026-10-25", daysOverdue: 0, isOverdue: true, expiresOn: null })
    expect(justPastDue.overdue).toMatchObject({ count: 1, oldestDaysOverdue: 0 })
    const result = await org.summary(new Date("2026-10-25T23:00:00Z"))
    expect(result.overdue).toMatchObject({ count: 1, oldestDaysOverdue: 1 })
    expect(amount(result.overdue)).toBe("100.00")
    expect(result.incoming[0]).toMatchObject({ dueDate: "2026-10-25", daysOverdue: 1 })
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).status).toBe("sent")
  })

  it("aggregates 12 local months by paidAt, excluding voids and future payments", async () => {
    const org = await setup()
    const invoice = await org.seed()
    for (const [date, value, voided] of [
      ["2025-10-31T22:59:59Z", "999", false],
      ["2025-10-31T23:00:00Z", "1.25", false],
      ["2026-09-30T21:59:59Z", "2.50", false],
      ["2026-09-30T22:00:00Z", "3.75", false],
      [NOW.toISOString(), "0.25", false],
      ["2026-10-09T00:00:00Z", "888", false],
      ["2026-10-01T00:00:00Z", "777", true],
    ] as const) await org.payment(invoice.id, date, value, "DKK", voided ? NOW : null)
    const result = await org.summary()
    expect(result.receivedByMonth.map(row => row.month)).toEqual(["2025-11", "2025-12", "2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10"])
    expect(amount(result.receivedByMonth[0]!)).toBe("1.25")
    expect(amount(result.receivedByMonth[10]!)).toBe("2.50")
    expect(result.paidThisMonth).toMatchObject({ count: 2, buckets: [{ amount: "4.00", count: 2 }] })
    expect(result.receivedByMonth[1]).toMatchObject(zero)
  })

  it("counts latest full on-time payments, stopping at late or credit-assisted settlement", async () => {
    const org = await setup()
    const olderLate = await org.seed({ dueDate: new Date("2026-10-01T00:00:00Z") })
    await org.admin.payments.record({ invoiceId: olderLate.id, amount: 100, paidAt: "2026-10-02", method: "cash" })
    const onTime = await org.seed({ dueDate: new Date("2026-10-03T00:00:00Z") })
    await org.admin.payments.record({ invoiceId: onTime.id, amount: 40, paidAt: "2026-10-02", method: "cash" })
    const last = await org.admin.payments.record({ invoiceId: onTime.id, amount: 60, paidAt: "2026-10-03T21:59:59Z", method: "cash" })
    const early = await org.seed()
    await org.admin.payments.record({ invoiceId: early.id, amount: 100, paidAt: "2026-10-04", method: "cash" })
    await org.seed({ status: "credited", amountCredited: "100" })
    await org.seed({ status: "paid", totalGross: "0", paidAt: NOW })
    expect((await org.summary()).streak).toBe(2)
    await org.admin.payments.void({ paymentId: last.payment.id, reason: "Payment reversed" })
    expect((await org.summary()).streak).toBe(1)
    await org.seed({ status: "paid", amountPaid: "80", amountCredited: "20", paidAt: new Date("2026-10-05T00:00:00Z") })
    expect((await org.summary()).streak).toBe(0)
  })

  it("ranks attention with delivery reasons and reminder eligibility", async () => {
    vi.stubEnv("EMAIL_PROVIDER", "resend")
    vi.stubEnv("RESEND_API_KEY", "test-dashboard")
    vi.stubEnv("FROM_EMAIL", "sender@example.com")
    const org = await setup()
    const overdue = await org.seed({ dueDate: new Date("2026-10-01T00:00:00Z") })
    const draft = await org.seed({ status: "draft", number: null, createdAt: new Date(NOW.getTime() - 7 * 86400000 - 1) })
    await org.seed({ status: "draft", number: null, createdAt: new Date(NOW.getTime() - 7 * 86400000) })
    const quote = await prisma.quote.create({ data: { organizationId: org.organizationId, contactId: org.contact.id, status: "sent", number: "Q1", expiryDate: new Date("2026-10-15T00:00:00Z"), subtotalNet: "50", totalGross: "50", currency: "DKK" } })
    await prisma.quote.create({ data: { organizationId: org.organizationId, contactId: org.contact.id, status: "sent", number: "Q2", expiryDate: new Date("2026-10-16T00:00:00Z"), subtotalNet: "50", totalGross: "50", currency: "DKK" } })
    const failed = await org.seed({ dueDate: new Date("2026-10-16T00:00:00Z"), lastEmailAttemptOutcome: "failed" })
    const uncertain = await org.seed({ dueDate: new Date("2026-10-17T00:00:00Z"), lastEmailAttemptOutcome: "unconfirmed" })
    const result = await org.summary()
    expect(result.attention.map(row => [row.documentId, row.reason])).toEqual([
      [overdue.id, "invoice_overdue"], [draft.id, "draft_older_than_7_days"], [quote.id, "quote_expiring"], [failed.id, "email_failed"], [uncertain.id, "email_unconfirmed"],
    ])
    expect(result.attention[0]).toMatchObject({ canRemind: true, dueDate: "2026-10-01", daysOverdue: 7, isOverdue: true, expiresOn: null })
    expect(result.attention[1]).toMatchObject({ dueDate: "2026-10-15", daysOverdue: null, isOverdue: false, expiresOn: null })
    expect(result.attention[2]).toMatchObject({ dueDate: null, daysOverdue: null, isOverdue: false, expiresOn: "2026-10-15" })
    expect(result.attention[3]).toMatchObject({ dueDate: "2026-10-16", daysOverdue: 0, isOverdue: false, expiresOn: null })
    await prisma.invoiceReminder.create({ data: { invoiceId: overdue.id, offsetDays: 7, scheduledFor: NOW, sentAt: NOW, outcome: "sent" } })
    expect((await org.summary()).attention[0]?.canRemind).toBe(false)
    await prisma.invoiceReminder.deleteMany({ where: { invoiceId: overdue.id } })
    expect((await dashboardSummary(prisma, org.actors.accountant, NOW)).attention[0]?.canRemind).toBe(false)
    vi.stubEnv("RESEND_API_KEY", "")
    expect((await org.summary()).attention[0]?.canRemind).toBe(false)
  })

  it("includes old quote drafts in the same age ranking as invoice drafts", async () => {
    const org = await setup()
    await org.seed({ status: "draft", number: null, createdAt: new Date("2026-09-29") })
    const quote = await prisma.quote.create({ data: {
      organizationId: org.organizationId, contactId: org.contact.id, status: "draft", number: null,
      createdAt: new Date("2026-09-28"), expiryDate: new Date("2026-10-15"), subtotalNet: "50", totalGross: "50", currency: "DKK",
    } })
    const result = await org.summary()
    expect(result.attention).toHaveLength(2)
    expect(result.attention[0]).toMatchObject({ documentId: quote.id, kind: "quote", number: null, reason: "draft_older_than_7_days", amount: { amount: "50.00" } })
    expect(result.outstanding).toEqual(zero)
  })

  it("excludes another organization's money, quotes and events and hides audit payloads", async () => {
    const org = await setup(), other = await setup()
    const invoice = await other.seed({ dueDate: new Date("2026-01-01") })
    await other.payment(invoice.id, "2026-10-01T00:00:00Z", "999999")
    await prisma.quote.create({ data: { organizationId: other.organizationId, contactId: other.contact.id, status: "sent", expiryDate: NOW, totalGross: "100", subtotalNet: "100" } })
    for (const target of [org, other]) {
      await prisma.domainEvent.createMany({ data: Array.from({ length: 10 }, (_, i) => ({ organizationId: target.organizationId, sequence: i + 1, aggregateType: "invoice", aggregateId: `document-${i}`, type: "invoice.sent", payload: { secret: "not returned" }, actorKind: "user", occurredAt: NOW })) })
      await prisma.domainEvent.create({ data: { organizationId: target.organizationId, sequence: 11, aggregateType: "organization", aggregateId: target.organizationId, type: "organization.payment_details_updated", payload: { secret: "not returned" }, actorKind: "user" } })
    }
    const result = await org.summary()
    expect(result.outstanding).toEqual(zero)
    expect(result.paidThisMonth).toEqual(zero)
    expect(result.attention).toEqual([])
    expect(result.incoming).toEqual([])
    expect(result.activity.map(event => event.sequence)).toEqual([10, 9, 8, 7, 6, 5, 4, 3])
    const ids = (await prisma.domainEvent.findMany({ where: { organizationId: org.organizationId } })).map(row => row.id)
    expect(result.activity.every(event => ids.includes(event.id))).toBe(true)
    expect(JSON.stringify(result)).not.toContain("not returned")
  })

  it("reports the oldest overdue days per currency and per unvalued subset", async () => {
    const org = await setup()
    await org.seed({ dueDate: new Date("2026-09-28"), valuation: { rateSource: "manual", base: { currency: "DKK", minor: "10000" } } })
    await org.seed({ dueDate: new Date("2026-10-06") })
    await org.seed({ currency: "EUR", dueDate: new Date("2026-10-03") })
    const result = await org.summary()
    expect(result.overdue.oldestDaysOverdue).toBe(10)
    expect(result.overdue.buckets.map(bucket => [bucket.currency, bucket.oldestDaysOverdue])).toEqual([["DKK", 10], ["EUR", 5]])
    expect(result.overdue.unvalued.map(bucket => [bucket.currency, bucket.oldestDaysOverdue])).toEqual([["DKK", 2], ["EUR", 5]])
    expect(result.outstanding.buckets.every(bucket => bucket.oldestDaysOverdue === undefined)).toBe(true)
    expect(dashboardSummarySchema.safeParse(result).success).toBe(true)
  })

  it("detects other currencies in outstanding and received totals, excluding drafts and out-of-window receipts", async () => {
    const org = await setup()
    await org.seed({ currency: "EUR", status: "draft", number: null })
    const settled = await org.seed({ currency: "EUR", status: "paid", amountPaid: "100" })
    await org.payment(settled.id, "2025-01-01T00:00:00Z", "100", "EUR")
    expect((await org.summary()).hasOtherCurrencies).toBe(false)
    const outstanding = await org.seed({ currency: "JPY", totalGross: "1" })
    expect((await org.summary()).hasOtherCurrencies).toBe(true)
    await prisma.invoice.update({ where: { id: outstanding.id }, data: { amountCredited: "1", status: "credited" } })
    expect((await org.summary()).hasOtherCurrencies).toBe(false)
    await org.payment(settled.id, "2026-09-01T00:00:00Z", "100", "EUR")
    const result = await org.summary()
    expect(result.paidThisMonth).toEqual(zero)
    expect(result.hasOtherCurrencies).toBe(true)
  })

  it("exports only real event types and filters excluded events before the eight-row cap", async () => {
    expect(DASHBOARD_ACTIVITY_EVENT_TYPES).toHaveLength(28)
    expect(new Set(DASHBOARD_ACTIVITY_EVENT_TYPES).size).toBe(28)
    for (const type of DASHBOARD_ACTIVITY_EVENT_TYPES) expect(Object.hasOwn(eventRegistry, type)).toBe(true)
    const org = await setup()
    const invoice = await org.seed()
    await prisma.domainEvent.createMany({ data: Array.from({ length: 20 }, (_, index) => ({
      organizationId: org.organizationId, sequence: index + 1, aggregateType: "invoice", aggregateId: invoice.id,
      type: index < 8 ? "invoice.sent" : index % 2 ? "document.artifact_stored" : "invoice.draft_updated",
      payload: { number: "PAYLOAD MUST NOT WIN", customerName: "hidden", secret: "not returned" }, actorKind: "user",
    })) })
    const result = await org.summary()
    expect(result.activity.map(event => event.sequence)).toEqual([8, 7, 6, 5, 4, 3, 2, 1])
    expect(result.activity.every(event => event.documentKind === "invoice" && event.documentNumber === invoice.number && event.customerName === org.contact.name)).toBe(true)
    expect(JSON.stringify(result.activity)).not.toContain("not returned")
    expect(dashboardSummarySchema.safeParse(result).success).toBe(true)
  })

  it("resolves all document kinds through scoped joins, refusing cross-org references even in local events", async () => {
    const org = await setup(), other = await setup()
    await prisma.contact.update({ where: { id: other.contact.id }, data: { name: "Foreign customer secret" } })
    async function documents(target: Awaited<ReturnType<typeof setup>>) {
      const invoice = await target.seed()
      const quote = await prisma.quote.create({ data: { organizationId: target.organizationId, contactId: target.contact.id, status: "sent", number: "Q-1", expiryDate: NOW, subtotalNet: "50", totalGross: "50" } })
      const credit = await prisma.creditNote.create({ data: {
        organizationId: target.organizationId, contactId: target.contact.id, invoiceId: invoice.id, number: "CN-1", reason: "Return",
        currency: "DKK", countryCode: "US", locale: "en-US", timezone: "Europe/Copenhagen", taxRegime: "us_sales_tax", subtotalNet: "10", totalGross: "10",
      } })
      const agreement = await prisma.agreement.create({ data: {
        organizationId: target.organizationId, contactId: target.contact.id, number: "AGR-1", status: "sent", title: "Work", termsMarkdown: "Terms",
        validUntil: NOW, subtotalNet: "50", totalGross: "50",
      } })
      return [
        { kind: "invoice", aggregateType: "invoice", type: "invoice.sent", document: invoice },
        { kind: "quote", aggregateType: "quote", type: "quote.sent", document: quote },
        { kind: "credit_note", aggregateType: "creditNote", type: "credit_note.issued", document: credit },
        { kind: "agreement", aggregateType: "agreement", type: "agreement.sent", document: agreement },
      ]
    }
    const own = await documents(org), foreign = await documents(other)
    await prisma.domainEvent.createMany({ data: [...own, ...foreign].map((entry, index) => ({
      organizationId: org.organizationId, sequence: index + 1, aggregateType: entry.aggregateType, aggregateId: entry.document.id,
      type: entry.type, payload: { customerName: "Foreign customer secret" }, actorKind: "user",
    })) })
    await prisma.domainEvent.create({ data: { organizationId: other.organizationId, sequence: 100, aggregateType: "invoice", aggregateId: foreign[0]!.document.id, type: "invoice.sent", payload: {}, actorKind: "user" } })
    const activity = (await org.summary()).activity
    expect(activity).toHaveLength(8)
    for (const entry of own) expect(activity.find(event => event.aggregateId === entry.document.id)).toMatchObject({ documentKind: entry.kind, documentNumber: entry.document.number, customerName: org.contact.name })
    for (const entry of foreign) expect(activity.find(event => event.aggregateId === entry.document.id)).toMatchObject({ documentKind: null, documentNumber: null, customerName: null })
    expect(JSON.stringify(activity)).not.toContain("Foreign customer secret")
  })

  it("resolves payment aggregates and keeps drafts and deleted records nullable without payload fallback", async () => {
    const org = await setup(), other = await setup()
    const invoice = await org.seed()
    const payment = await org.payment(invoice.id, NOW.toISOString())
    const foreignPayment = await other.payment((await other.seed()).id, NOW.toISOString())
    const draft = await org.seed({ status: "draft", number: "LEGACY-DRAFT" })
    await prisma.domainEvent.createMany({ data: [
      { aggregateType: "payment", aggregateId: payment.id, type: "payment.recorded" },
      { aggregateType: "payment", aggregateId: foreignPayment.id, type: "payment.voided" },
      { aggregateType: "invoice", aggregateId: draft.id, type: "invoice.draft_created" },
      { aggregateType: "invoice", aggregateId: randomUUID(), type: "invoice.draft_created" },
    ].map((entry, index) => ({ ...entry, organizationId: org.organizationId, sequence: index + 1, payload: { number: "SECRET" }, actorKind: "user" })) })
    const result = (await org.summary()).activity
    expect(result[0]).toMatchObject({ documentKind: null, documentNumber: null, customerName: null })
    expect(result[1]).toMatchObject({ documentKind: "invoice", documentNumber: null, customerName: org.contact.name })
    expect(result[2]).toMatchObject({ documentKind: null, documentNumber: null, customerName: null })
    expect(result[3]).toMatchObject({ documentKind: "invoice", documentNumber: invoice.number, customerName: org.contact.name })
  })

  it("filters unreadable document kinds and event types before the activity cap", async () => {
    const org = await setup()
    const invoice = await org.seed({ status: "draft", createdAt: new Date("2026-01-01") })
    const quote = await prisma.quote.create({ data: { organizationId: org.organizationId, contactId: org.contact.id,
      status: "draft", expiryDate: new Date("2026-10-10"), createdAt: new Date("2026-01-01"), subtotalNet: "50", totalGross: "50" } })
    await prisma.quote.create({ data: { organizationId: org.organizationId, contactId: org.contact.id,
      status: "sent", expiryDate: new Date("2026-10-10"), subtotalNet: "50", totalGross: "50" } })
    const event = (sequence: number, type: string, aggregateType: string, aggregateId: string) => ({
      organizationId: org.organizationId, sequence, type, aggregateType, aggregateId, payload: {}, actorKind: "user",
    })
    await prisma.domainEvent.createMany({ data: [
      ...Array.from({ length: 8 }, (_, i) => event(i + 1, "invoice.draft_created", "invoice", invoice.id)),
      ...Array.from({ length: 8 }, (_, i) => event(i + 9, "quote.sent", "quote", quote.id)),
      event(17, "credit_note.issued", "credit_note", "hidden-credit"),
      event(18, "agreement.accepted", "agreement", "hidden-agreement"),
      // Legacy/malformed envelopes must pass both type and aggregate-kind permission checks.
      event(19, "quote.sent", "invoice", invoice.id),
      event(20, "invoice.sent", "quote", quote.id),
    ] })
    const actor = { kind: "agent" as const, organizationId: org.organizationId, agentKeyId: "invoice-reader",
      mode: "read_only" as const, scopes: ["invoice:read" as const], ownerRoles: org.actors.admin.roles, label: "Invoice reader" }
    const result = await dashboardSummary(prisma, actor, NOW)
    expect(result.drafts).toEqual({ count: 1, newestId: invoice.id, newestKind: "invoice" })
    expect(result.attention.map(row => row.documentId)).toEqual([invoice.id])
    expect(result.activity.map(row => row.sequence)).toEqual([8, 7, 6, 5, 4, 3, 2, 1])
    expect(result.activity.every(row => row.documentKind === "invoice")).toBe(true)
  })

  it("omits in-flight invoice and quote drafts from both attention and draft inventory", async () => {
    const org = await setup()
    await org.seed({ status: "draft", createdAt: new Date("2026-01-01"), lastEmailAttemptOutcome: "sending" })
    await prisma.quote.create({ data: { organizationId: org.organizationId, contactId: org.contact.id,
      status: "draft", createdAt: new Date("2026-01-01"), expiryDate: NOW, subtotalNet: "50", totalGross: "50", lastEmailAttemptOutcome: "sending" } })
    const result = await org.summary()
    expect(result.drafts.count).toBe(0)
    expect(result.attention).toEqual([])
  })

  it("counts every editable draft independently of attention and activity caps", async () => {
    const org = await setup()
    const other = await setup()
    expect((await org.admin.dashboard.summary()).drafts).toEqual({ count: 0, newestId: null, newestKind: null })
    const invoice = await org.seed({ status: "draft", number: null, createdAt: new Date("2026-01-01") })
    expect((await org.admin.dashboard.summary()).drafts).toEqual({ count: 1, newestId: invoice.id, newestKind: "invoice" })
    await org.seed({ status: "draft", lastEmailAttemptOutcome: "sending" })
    await other.seed({ status: "draft" })
    await prisma.quote.create({ data: { organizationId: other.organizationId, contactId: other.contact.id, expiryDate: NOW, subtotalNet: "10", totalGross: "10" } })
    await prisma.quote.createMany({ data: Array.from({ length: 10 }, () => ({
      organizationId: org.organizationId, contactId: org.contact.id,
      status: "draft", expiryDate: NOW, subtotalNet: "10", totalGross: "10", createdAt: new Date("2026-02-01"),
    })) })
    const quote = await prisma.quote.create({ data: {
      organizationId: org.organizationId, contactId: org.contact.id, status: "draft", expiryDate: NOW, subtotalNet: "10", totalGross: "10",
      createdAt: new Date("2026-03-01"), lastEmailAttemptOutcome: "failed",
    } })
    await prisma.quote.createMany({ data: [
      { organizationId: org.organizationId, contactId: org.contact.id, status: "draft", expiryDate: NOW, subtotalNet: "10", totalGross: "10", lastEmailAttemptOutcome: "sending" },
      { organizationId: org.organizationId, contactId: org.contact.id, status: "sent", expiryDate: NOW, subtotalNet: "10", totalGross: "10" },
    ] })
    const result = await org.admin.dashboard.summary()
    expect(result.drafts).toEqual({ count: 12, newestId: quote.id, newestKind: "quote" })
    expect(result.attention).toHaveLength(5)
    expect(result.activity).toEqual([])
    expect((await dashboardSummary(prisma, { ...org.actors.admin, roles: [] }, NOW)).drafts)
      .toEqual({ count: 0, newestId: null, newestKind: null })
    await prisma.quote.update({ where: { id: quote.id }, data: { status: "sent" } })
    const latest = await org.seed({ status: "draft", createdAt: new Date("2026-04-01") })
    expect((await org.admin.dashboard.summary()).drafts).toEqual({ count: 12, newestId: latest.id, newestKind: "invoice" })
  })

  it("transports existing sendNow refusal codes as data.reason for UI translation", async () => {
    const org = await setup()
    const draft = await org.seed({ status: "draft", number: null })
    async function refusal(invoiceId: string) {
      const response = await fetchRequestHandler({
        endpoint: "/api/trpc", router: appRouter,
        req: new Request("http://localhost/api/trpc/reminders.sendNow", {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(superjson.serialize({ invoiceId })),
        }),
        createContext: async () => ({ session: { user: { id: org.actors.admin.userId }, session: { activeOrganizationId: org.organizationId } } }) as never,
      })
      const body = await response.json() as { error: SuperJSONResult }
      return superjson.deserialize<{ data: { reason: string; code: string } }>(body.error).data
    }
    expect(await refusal(draft.id)).toMatchObject({ code: "BAD_REQUEST", reason: "not_remindable" })
    const invoice = await org.seed()
    await prisma.contact.update({ where: { id: org.contact.id }, data: { email: null } })
    expect((await refusal(invoice.id)).reason).toBe("missing_recipient")
    await prisma.contact.update({ where: { id: org.contact.id }, data: { email: "buyer@example.com" } })
    vi.stubEnv("EMAIL_PROVIDER", "resend")
    vi.stubEnv("RESEND_API_KEY", "")
    expect((await refusal(invoice.id)).reason).toBe("email_unavailable")
    vi.stubEnv("RESEND_API_KEY", "test-dashboard")
    vi.stubEnv("FROM_EMAIL", "sender@example.com")
    // Reserve both adjacent slots to avoid a wall-clock boundary race while executing the request.
    const slot = Math.floor((Date.now() - invoice.dueDate.getTime()) / 86400000)
    await prisma.invoiceReminder.createMany({ data: [slot, slot + 1].map(offsetDays => ({ invoiceId: invoice.id, offsetDays, scheduledFor: NOW, sentAt: NOW, outcome: "sent" })) })
    expect((await refusal(invoice.id)).reason).toBe("already_reminded")
  })

  it("uses six SELECTs for one and 501 invoices plus 500 receipts, independent of SQL timezone", async () => {
    const org = await setup()
    const invoice = await org.seed()
    await org.admin.payments.record({ invoiceId: invoice.id, amount: 1.25, paidAt: "2026-09-30T22:00:00Z", method: "cash" })
    const queries: string[] = []
    const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL!, options: "-c timezone=America/Los_Angeles" }), log: [{ emit: "event", level: "query" }] })
    db.$on("query", event => queries.push(event.query))
    try {
      const measure = async () => {
        queries.length = 0
        const summary = await dashboardSummary(db, org.actors.admin, NOW)
        expect(queries.filter(query => /^\s*SELECT/i.test(query))).toHaveLength(6)
        expect(queries.every(query => /^\s*(SELECT|BEGIN|COMMIT|SET TRANSACTION)/i.test(query))).toBe(true)
        expect(amount(summary.paidThisMonth)).toBe("1.25")
        return summary
      }
      await measure()
      const rows = Array.from({ length: 500 }, (_, index) => ({
        id: randomUUID(),
        organizationId: org.organizationId, contactId: org.contact.id, number: `LOAD-${index}`, status: "sent", currency: "DKK", dueDate: new Date("2026-10-01"), subtotalNet: "100", totalGross: "100", amountPaid: "20.10", amountCredited: "10.20",
      }))
      await prisma.invoice.createMany({ data: rows })
      await prisma.settlementReceipt.createMany({ data: rows.map(row => ({
        id: `receipt-${row.id}`, organizationId: org.organizationId, contactId: org.contact.id,
        currency: "DKK", grossAmount: "20.10", netAmount: "19.10", feeAmount: "1.00",
        paidAt: new Date("2026-09-01"), method: "cash", reference: row.id, ...receiptEvidence,
        feeReason: receiptEvidence.reason, feeEvidence: receiptEvidence.evidence,
        actorKey: `user:${org.actors.admin.userId}`, commandId: randomUUID(),
      })) })
      await prisma.payment.createMany({ data: rows.map(row => ({
        organizationId: org.organizationId, invoiceId: row.id, currency: "DKK", amount: "20.10",
        receiptId: `receipt-${row.id}`, receiptAmount: "20.10",
        allocationReason: receiptEvidence.reason, allocationEvidence: receiptEvidence.evidence,
        paidAt: new Date("2026-09-01"), source: "user", method: "cash",
      })) })
      await prisma.creditNote.createMany({ data: rows.map(row => ({
        organizationId: org.organizationId, invoiceId: row.id, contactId: org.contact.id,
        number: `CN-${row.number}`, reason: "Seeded partial credit", currency: "DKK", countryCode: "US",
        locale: "en-US", timezone: "Europe/Copenhagen", taxRegime: "us_sales_tax", subtotalNet: "10.20", totalGross: "10.20",
      })) })
      const summary = await measure()
      expect(summary.receivedByMonth.at(-2)?.buckets).toEqual([{ currency: "DKK", exponent: 2, amount: "9550.00", count: 500 }])
      expect(summary.outstanding.count).toBe(501)
      expect(amount(summary.outstanding)).toBe("34948.75")
      expect(summary.incoming).toHaveLength(8)
      expect(summary.attention).toHaveLength(5)
      const listed = await org.admin.invoices.list()
      expect(new Prisma.Decimal(amount(summary.outstanding)).equals(listed.reduce((sum, row) => sum.plus(String(row.balanceDue)), new Prisma.Decimal(0)))).toBe(true)
    } finally { await db.$disconnect() }
  })
})
