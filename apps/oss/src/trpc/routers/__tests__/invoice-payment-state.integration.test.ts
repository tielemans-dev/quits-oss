import { cleanupTestOrganizations } from "../../../test-utils/organization"
import "dotenv/config"
import { randomUUID } from "node:crypto"
import { describe, expect, it } from "vitest"
import { prisma } from "../../../lib/db"
import { appRouter } from "../../router"
import { ensureTestMembership } from "../../../test-utils/membership"

const hasDatabaseUrl = Boolean(process.env.DATABASE_URL)
const describeIfDatabase = hasDatabaseUrl ? describe : describe.skip

describeIfDatabase("invoice payment state", () => {
  it("defaults invoices to unpaid and records manual settlement cleanly", async () => {
    const orgId = randomUUID()
    const slug = `invoice-payment-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`

    const caller = appRouter.createCaller({
      session: {
        user: {
          id: "invoice-payment-user",
          email: "invoice-payment@example.com",
          name: "Invoice Payment User",
        },
        session: {
          activeOrganizationId: orgId,
        },
      },
    } as never)

    try {
      await prisma.organization.create({
        data: {
          id: orgId,
          name: "Invoice Payment Org",
          slug,
          createdAt: new Date(),
          subscriptionStatus: "pro",
        },
      })
      await ensureTestMembership(orgId, "invoice-payment-user")

      await prisma.orgSettings.create({
        data: {
          organizationId: orgId,
          countryCode: "DK",
          locale: "da-DK",
          timezone: "Europe/Copenhagen",
          defaultCurrency: "DKK",
          baseCurrency: "DKK",
          currency: "DKK",
          taxRegime: "eu_vat",
          pricesIncludeTax: false,
          invoicePrefix: "INVPAY",
          quotePrefix: "QTEPAY",
        },
      })

      await prisma.organizationTaxId.create({
        data: {
          organizationId: orgId,
          scheme: "DK_CVR",
          value: "12345678",
          countryCode: "DK",
          isPrimary: true,
        },
      })

      const contact = await prisma.contact.create({
        data: {
          organizationId: orgId,
          name: "Buyer Name",
          email: "buyer@example.com",
          company: "Buyer Co",
          country: "DK",
        },
      })

      const invoice = await caller.invoices.create({
        contactId: contact.id,
        dueDate: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
        taxRate: 25,
        items: [{ description: "Consulting", quantity: 2, unitPrice: 1000 }],
      })

      expect(invoice.paymentStatus).toBe("unpaid")
      expect(invoice.paidAt).toBeNull()

      await caller.invoices.send({ id: invoice.id, allowSendWithoutEmail: true })
      await prisma.invoice.update({
        where: { id: invoice.id },
        data: {
          dueDate: new Date(Date.now() - 24 * 60 * 60 * 1000),
        },
      })
      await caller.invoices.markOverdue()

      const overdue = await caller.invoices.get({ id: invoice.id })
      expect(overdue.status).toBe("overdue")

      const paid = await caller.invoices.markPaid({ invoiceId: invoice.id, requestId: crypto.randomUUID() })

      expect(paid.invoiceStatus).toBe("paid")
      expect(paid.balance.amount).toBe("0.00")
      expect(paid.undoUntil).toBeTruthy()

      await expect(caller.invoices.markPaid({ invoiceId: invoice.id, requestId: crypto.randomUUID() })).rejects.toThrow(
        "The invoice is already settled"
      )

      const reloaded = await caller.invoices.get({ id: invoice.id })
      expect(reloaded.paymentStatus).toBe("paid")
    } finally {
      await cleanupTestOrganizations({ where: { id: orgId } })
    }
  }, 10_000)
})
