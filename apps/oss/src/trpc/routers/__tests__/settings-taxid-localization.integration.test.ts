import { cleanupTestOrganizations } from "../../../test-utils/organization"
import "dotenv/config"
import { randomUUID } from "node:crypto"
import { describe, expect, it } from "vitest"
import { pdf } from "@react-pdf/renderer"
import { prisma } from "../../../lib/db"
import { buildInvoiceEmailContent } from "../../../lib/email"
import { InvoicePdfDocument } from "../../../lib/invoice-pdf"
import { appRouter } from "../../router"
import { ensureTestMembership } from "../../../test-utils/membership"

const hasDatabaseUrl = Boolean(process.env.DATABASE_URL)
const describeIfDatabase = hasDatabaseUrl ? describe : describe.skip

async function createOrgWithCaller() {
  const orgId = randomUUID()
  const slug = `settings-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`

  await prisma.organization.create({
    data: {
      id: orgId,
      name: "Settings Smoke Org",
      slug,
      createdAt: new Date(),
      subscriptionStatus: "pro",
    },
  })
  await ensureTestMembership(orgId, "settings-user")

  const ctx = {
    session: {
      user: {
        id: "settings-user",
        email: "settings@example.com",
        name: "Settings User",
      },
      session: {
        activeOrganizationId: orgId,
      },
    },
  }

  return {
    orgId,
    caller: appRouter.createCaller(ctx as never),
  }
}

describeIfDatabase("settings/tax-id/localization integration", () => {
  it("round-trips settings and upserts primary organization tax ID", async () => {
    const { orgId, caller } = await createOrgWithCaller()

    try {
      await caller.settings.update({
        countryCode: "DK",
        locale: "da-DK",
        timezone: "Europe/Copenhagen",
        defaultCurrency: "DKK",
        taxRegime: "eu_vat",
        pricesIncludeTax: true,
        primaryTaxId: "12345678",
        primaryTaxIdScheme: "DK_CVR",
      })

      const firstRead = await caller.settings.get()
      expect(firstRead.countryCode).toBe("DK")
      expect(firstRead.locale).toBe("da-DK")
      expect(firstRead.defaultCurrency).toBe("DKK")
      expect(firstRead.pricesIncludeTax).toBe(true)
      expect(firstRead.primaryTaxId).toBe("12345678")
      expect(firstRead.primaryTaxIdScheme).toBe("DK_CVR")

      await caller.settings.update({
        primaryTaxId: "87654321",
        primaryTaxIdScheme: "VAT",
      })

      const secondRead = await caller.settings.get()
      expect(secondRead.primaryTaxId).toBe("87654321")
      expect(secondRead.primaryTaxIdScheme).toBe("VAT")

      const orgTaxIds = await prisma.organizationTaxId.findMany({
        where: { organizationId: orgId },
      })
      expect(orgTaxIds).toHaveLength(1)
      expect(orgTaxIds[0]?.value).toBe("87654321")
    } finally {
      await cleanupTestOrganizations({ where: { id: orgId } })
    }
  })

  it("supports structured organization and contact tax-id CRUD", async () => {
    const { orgId } = await createOrgWithCaller()

    try {
      const contact = await prisma.contact.create({
        data: {
          organizationId: orgId,
          name: "Tax Buyer",
          email: "taxbuyer@example.com",
          country: "DK",
        },
      })

      const orgTaxId = await prisma.organizationTaxId.create({
        data: {
          organizationId: orgId,
          scheme: "VAT",
          value: "DK123",
          countryCode: "DK",
          isPrimary: true,
        },
      })

      const updatedOrgTaxId = await prisma.organizationTaxId.update({
        where: { id: orgTaxId.id },
        data: { value: "DK456" },
      })
      expect(updatedOrgTaxId.value).toBe("DK456")

      const contactTaxId = await prisma.contactTaxId.create({
        data: {
          contactId: contact.id,
          scheme: "VAT",
          value: "CUST123",
          countryCode: "DK",
          isPrimary: true,
        },
      })

      const updatedContactTaxId = await prisma.contactTaxId.update({
        where: { id: contactTaxId.id },
        data: { value: "CUST456" },
      })
      expect(updatedContactTaxId.value).toBe("CUST456")

      await prisma.contactTaxId.delete({ where: { id: contactTaxId.id } })
      await prisma.organizationTaxId.delete({ where: { id: orgTaxId.id } })

      const remainingOrgTaxIds = await prisma.organizationTaxId.count({
        where: { organizationId: orgId },
      })
      const remainingContactTaxIds = await prisma.contactTaxId.count({
        where: { contactId: contact.id },
      })
      expect(remainingOrgTaxIds).toBe(0)
      expect(remainingContactTaxIds).toBe(0)
    } finally {
      await cleanupTestOrganizations({ where: { id: orgId } })
    }
  })

  it("renders localized invoice email and pdf outputs (snapshot)", async () => {
    const invoice = {
      number: "INV-2026-001",
      status: "draft",
      issueDate: "2026-03-01T00:00:00.000Z",
      dueDate: "2026-03-15T00:00:00.000Z",
      subtotal: 1000.4,
      taxAmount: 250.1,
      total: 1250.5,
      currency: "DKK",
      notes: "Tak for samarbejdet",
      contact: {
        name: "Acme ApS",
        email: "billing@acme.dk",
        company: "Acme ApS",
        address: "Hovedgade 1",
        city: "København",
        zip: "2100",
        country: "DK",
      },
      items: [
        {
          description: "Konsulentydelse",
          quantity: 1,
          unitPrice: 1250.5,
          total: 1250.5,
        },
      ],
    }

    const org = {
      companyName: "Nordic Services",
      companyEmail: "finance@nordic.test",
      companyAddress: "Vesterbrogade 2",
      locale: "da-DK",
      timezone: "Europe/Copenhagen",
    }

    const emailContent = buildInvoiceEmailContent({
      invoice: {
        number: invoice.number,
        issueDate: invoice.issueDate,
        dueDate: invoice.dueDate,
        subtotal: invoice.subtotal,
        taxAmount: invoice.taxAmount,
        total: invoice.total,
        currency: invoice.currency,
        notes: invoice.notes,
        items: invoice.items,
      },
      org,
      contactName: invoice.contact.name,
    })

    expect(emailContent.subject).toMatchInlineSnapshot(
      '"Faktura INV-2026-001 — 1.250,50\u00a0kr. forfalder 15. marts 2026"'
    )
    expect(emailContent.html).toContain("1.250,50\u00a0kr.")
    expect(emailContent.html).toContain("15. marts 2026")

    const pdfString = await pdf(
      InvoicePdfDocument({
        invoice,
        org,
      })
    ).toString()

    expect(pdfString).toContain("<2d323032362d303031>")
    expect(pdfString).toContain("<6d6172> -40 <74732032303236>")
    expect(pdfString).toContain("<312e3235302c3530a0>")
  })
})
