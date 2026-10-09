import { afterEach, describe, expect, it } from "vitest"
import { createTestOrganization, hasTestDatabase } from "../../../test-utils/organization"
import { appRouter } from "../../router"

const describeIfDatabase = hasTestDatabase ? describe : describe.skip

describeIfDatabase("payments router", () => {
  const cleanups: Array<() => Promise<void>> = []
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()?.()
  })

  function callerFor(organizationId: string, userId: string) {
    return appRouter.createCaller({
      session: {
        user: { id: userId, email: `${userId}@example.com`, name: userId },
        session: { activeOrganizationId: organizationId },
      },
    } as never)
  }

  it("exposes balances, payment history, and void rights per role", async () => {
    const org = await createTestOrganization({ roles: ["admin", "member"] })
    cleanups.push(org.cleanup)
    const admin = callerFor(org.organizationId, org.actors.admin.userId)
    const member = callerFor(org.organizationId, org.actors.member.userId)

    const contact = await admin.contacts.create({ name: "Acme", email: "acme@example.com" })
    const invoice = await admin.invoices.create({
      contactId: contact.id,
      dueDate: "2099-01-01",
      items: [{ description: "Work", quantity: 1, unitPrice: 300 }],
    })
    await admin.invoices.send({ id: invoice.id, allowSendWithoutEmail: true })

    const recorded = await member.payments.record({
      invoiceId: invoice.id,
      amount: 120.5,
      paidAt: "2026-02-01",
      method: "card",
      reference: "R-1",
    })
    expect(recorded.balanceDue).toBe(179.5)

    const fetched = await admin.invoices.get({ id: invoice.id })
    expect(fetched).toMatchObject({ amountPaid: 120.5, amountCredited: 0, balanceDue: 179.5 })
    expect(fetched.paymentStatus).toBe("partially_paid")
    const listed = await admin.invoices.list()
    expect(listed.find((row) => row.id === invoice.id)?.balanceDue).toBe(179.5)

    const memberView = await member.payments.list({ invoiceId: invoice.id })
    expect(memberView).toMatchObject({ canVoid: false, canRecord: true, balanceDue: 179.5 })
    expect(memberView.payments).toHaveLength(1)
    expect(memberView.payments[0]).toMatchObject({ amount: 120.5, method: "card", reference: "R-1" })
    expect(memberView.timeZone).toBe("UTC")

    await expect(
      member.payments.void({ paymentId: recorded.payment.id, reason: "Mistake" })
    ).rejects.toThrow()

    const stats = await admin.dashboard.stats()
    expect(stats.outstanding).toBe(179.5)
    expect(stats.totalRevenue).toBe(120.5)

    const paid = await admin.invoices.markPaid({ invoiceId: invoice.id, requestId: crypto.randomUUID() })
    expect(paid).toMatchObject({ invoiceStatus: "paid", balance: { amount: "0.00" }, total: { amount: "300.00" }, paidFraction: "1" })

    const adminView = await admin.payments.list({ invoiceId: invoice.id })
    expect(adminView).toMatchObject({ canVoid: true, canRecord: false, balanceDue: 0 })
    const shortcut = adminView.payments.find((row) => row.method === "manual")
    expect(shortcut?.amount).toBe(179.5)

    await admin.payments.void({ paymentId: recorded.payment.id, reason: "Card chargeback" })
    const reopened = await admin.invoices.get({ id: invoice.id })
    expect(reopened).toMatchObject({ status: "sent", paymentStatus: "partially_paid", balanceDue: 120.5 })
  })
})
