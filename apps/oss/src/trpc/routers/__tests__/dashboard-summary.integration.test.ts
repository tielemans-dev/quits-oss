import { randomUUID } from "node:crypto"
import { PrismaPg } from "@prisma/adapter-pg"
import { afterEach, describe, expect, it, vi } from "vitest"
import { dashboardSummarySchema, type DashboardTotal } from "@quits/contracts/dashboard"
import { Prisma, PrismaClient } from "../../../../generated/prisma/client"
import { prisma } from "../../../lib/db"
import { dashboardSummary } from "../../../lib/dashboard/summary"
import { createTestOrganization, hasTestDatabase } from "../../../test-utils/organization"
import { appRouter } from "../../router"

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
    return { ...org, contact, admin, seed, payment, summary: (now = NOW) => dashboardSummary(prisma, org.actors.admin, now) }
  }

  it("returns empty results for every invoice-reading role without writes", async () => {
    const org = await setup()
    await prisma.orgSettings.delete({ where: { organizationId: org.organizationId } })
    for (const role of ["admin", "member", "accountant"] as const) {
      const result = await caller(org.organizationId, org.actors[role].userId).dashboard.summary()
      expect(result).toMatchObject({ currencyMode: "per_currency", timezone: "UTC", baseCurrency: "USD", outstanding: zero, overdue: { ...zero, oldestDaysOverdue: 0 }, paidThisMonth: zero, streak: 0, attention: [], incoming: [], activity: [] })
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

  it("uses the existing due-timestamp boundary at Copenhagen midnight and calendar days across DST", async () => {
    const org = await setup()
    const invoice = await org.seed({ dueDate: new Date("2026-10-24T22:00:00Z") })
    for (const now of ["2026-10-24T21:59:59.999Z", "2026-10-24T22:00:00Z"]) {
      expect((await org.summary(new Date(now))).overdue).toEqual({ ...zero, oldestDaysOverdue: 0 })
    }
    const justPastDue = await org.summary(new Date("2026-10-24T22:00:00.001Z"))
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
    const quote = await prisma.quote.create({ data: { organizationId: org.organizationId, contactId: org.contact.id, status: "sent", number: "Q1", expiryDate: new Date("2026-10-15T21:59:59Z"), subtotalNet: "50", totalGross: "50", currency: "DKK" } })
    await prisma.quote.create({ data: { organizationId: org.organizationId, contactId: org.contact.id, status: "sent", number: "Q2", expiryDate: new Date("2026-10-15T22:00:00Z"), subtotalNet: "50", totalGross: "50", currency: "DKK" } })
    const failed = await org.seed({ dueDate: new Date("2026-10-16T00:00:00Z"), lastEmailAttemptOutcome: "failed" })
    const uncertain = await org.seed({ dueDate: new Date("2026-10-17T00:00:00Z"), lastEmailAttemptOutcome: "unconfirmed" })
    const result = await org.summary()
    expect(result.attention.map(row => [row.documentId, row.reason])).toEqual([
      [overdue.id, "invoice_overdue"], [draft.id, "draft_older_than_7_days"], [quote.id, "quote_expiring"], [failed.id, "email_failed"], [uncertain.id, "email_unconfirmed"],
    ])
    expect(result.attention[0]?.canRemind).toBe(true)
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

  it("uses five SELECTs for one and 501 invoices with bounded lists, independent of SQL timezone", async () => {
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
        expect(queries.filter(query => /^\s*SELECT/i.test(query))).toHaveLength(5)
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
      await prisma.payment.createMany({ data: rows.map(row => ({
        organizationId: org.organizationId, invoiceId: row.id, currency: "DKK", amount: "20.10",
        paidAt: new Date("2026-09-01"), source: "user", method: "cash",
      })) })
      await prisma.creditNote.createMany({ data: rows.map(row => ({
        organizationId: org.organizationId, invoiceId: row.id, contactId: org.contact.id,
        number: `CN-${row.number}`, reason: "Seeded partial credit", currency: "DKK", countryCode: "US",
        locale: "en-US", timezone: "Europe/Copenhagen", taxRegime: "us_sales_tax", subtotalNet: "10.20", totalGross: "10.20",
      })) })
      const summary = await measure()
      expect(summary.outstanding.count).toBe(501)
      expect(amount(summary.outstanding)).toBe("34948.75")
      expect(summary.incoming).toHaveLength(8)
      expect(summary.attention).toHaveLength(5)
      const listed = await org.admin.invoices.list()
      expect(new Prisma.Decimal(amount(summary.outstanding)).equals(listed.reduce((sum, row) => sum.plus(String(row.balanceDue)), new Prisma.Decimal(0)))).toBe(true)
    } finally { await db.$disconnect() }
  })
})
