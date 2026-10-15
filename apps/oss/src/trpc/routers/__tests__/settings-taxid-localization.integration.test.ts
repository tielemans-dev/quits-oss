import { cleanupTestOrganizations } from "../../../test-utils/organization"
import "dotenv/config"
import { randomUUID } from "node:crypto"
import { describe, expect, it } from "vitest"
import { pdf } from "@react-pdf/renderer"
import { prisma } from "../../../lib/db"
import { buildInvoiceEmailContent } from "../../../lib/email"
import { InvoicePdfDocument } from "../../../lib/invoice-pdf"
import { confirmOnboardingV2 } from "../../../lib/onboarding/confirm-v2"
import { confirmOnboardingV2Schema } from "@quits/contracts/onboarding"
import { buildSellerSnapshot } from "../../../domain/documents/snapshots"
import { buildSellerParty } from "../../../lib/exports/einvoice"
import { vatIdentifier } from "../../../lib/exports/parties"
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
      '"Faktura INV-2026-001 — 1.250,50\u00a0kr. forfalder 15. mar. 2026"'
    )
    expect(emailContent.html).toContain("1.250,50\u00a0kr.")
    expect(emailContent.html).toContain("15. mar. 2026")

    const pdfString = await pdf(
      InvoicePdfDocument({
        invoice,
        org,
      })
    ).toString()

    // This renderer uses uncompressed WinAnsi hex text runs. Decode their text, ignoring
    // kerning and run boundaries, which change when the layout or date labels change.
    const pdfText = [...pdfString.matchAll(/BT([\s\S]*?)ET/g)].flatMap(block =>
      [...block[1]!.matchAll(/\[([\s\S]*?)\]\s*TJ/g)].map(run =>
        [...run[1]!.matchAll(/<([\da-f]+)>/gi)].map(hex =>
          new TextDecoder("windows-1252").decode(Buffer.from(hex[1]!, "hex"))
        ).join("")
      )
    ).join("")
    expect(pdfText).toContain(invoice.number)
    expect(pdfText).toContain("15. marts 2026")
    expect(pdfText).toContain("1.250,50\u00a0kr.")
  })
})

describeIfDatabase("Danish VAT Settings invariants", () => {
  it("keeps confirmed CVR and paired VAT synchronized while retaining historical snapshots and other IDs", async () => {
    const { orgId, caller } = await createOrgWithCaller()
    try {
      await confirmOnboardingV2(orgId, confirmOnboardingV2Schema.parse({ companyName: "Confirmed ApS", companyAddress: "Testvej 1, 1000 København", companyForm: "ApS", momsRegistered: true, cvr: "24256790", vatId: "DK24256790", idempotencyKey: randomUUID() }), "settings@example.test")
      await prisma.organizationTaxId.createMany({ data: [
        { organizationId: orgId, scheme: "vat", value: "DE123456789", countryCode: "DE", isPrimary: false },
        { organizationId: orgId, scheme: "other", value: "other-id", countryCode: "DK", isPrimary: false },
      ] })
      const before = await prisma.organizationTaxId.findMany({ where: { organizationId: orgId } })
      const oldSnapshot = buildSellerSnapshot(await prisma.orgSettings.findUniqueOrThrow({ where: { organizationId: orgId } }), before)
      const historical = await prisma.invoice.create({ data: { organizationId: orgId, contactId: (await prisma.contact.create({ data: { organizationId: orgId, name: "Buyer" } })).id, status: "sent", number: "INV-HISTORICAL", dueDate: new Date("2026-11-01"), subtotalNet: 100, totalGross: 125, sellerSnapshot: JSON.parse(JSON.stringify(oldSnapshot)) } })
      await caller.settings.update({ primaryTaxId: "87654321", primaryTaxIdScheme: "DK_CVR" })
      const after = await prisma.organizationTaxId.findMany({ where: { organizationId: orgId } })
      expect(after.find(id => id.isPrimary)).toMatchObject({ scheme: "DK_CVR", value: "87654321" })
      expect(after.find(id => id.scheme === "vat" && id.countryCode === "DK")).toMatchObject({ value: "DK87654321", isPrimary: false })
      expect(after.find(id => id.countryCode === "DE")?.value).toBe("DE123456789")
      expect(after.find(id => id.scheme === "other")?.value).toBe("other-id")
      const futureSnapshot = buildSellerSnapshot(await prisma.orgSettings.findUniqueOrThrow({ where: { organizationId: orgId } }), after.filter(id => id.countryCode === "DK"))
      expect(buildSellerParty({ snapshot: futureSnapshot, settings: null, taxIds: [], documentCountryCode: "DK" }).vatId).toBe("DK87654321")
      expect((await prisma.invoice.findUniqueOrThrow({ where: { id: historical.id } })).sellerSnapshot).toEqual(JSON.parse(JSON.stringify(oldSnapshot)))
    } finally { await cleanupTestOrganizations({ where: { id: orgId } }) }
  })
  it("synchronizes the paired VAT when the primary scheme switches between cvr and vat", async () => {
    const { orgId, caller } = await createOrgWithCaller()
    try {
      await confirmOnboardingV2(orgId, confirmOnboardingV2Schema.parse({ companyName: "Confirmed ApS", companyAddress: "Testvej 1, 1000 København", companyForm: "ApS", momsRegistered: true, cvr: "24256790", vatId: "DK24256790", idempotencyKey: randomUUID() }), "settings@example.test")
      await prisma.organizationTaxId.create({ data: { organizationId: orgId, scheme: "vat", value: "DE123456789", countryCode: "DE", isPrimary: false } })
      await caller.settings.update({ primaryTaxId: "DK87654321", primaryTaxIdScheme: "vat", momsRegistered: true })
      const switched = await prisma.organizationTaxId.findMany({ where: { organizationId: orgId } })
      expect(switched.find(id => id.isPrimary)).toMatchObject({ scheme: "vat", value: "DK87654321" })
      expect(switched.find(id => !id.isPrimary && id.countryCode === "DK")).toMatchObject({ scheme: "vat", value: "DK87654321" })
      expect(switched.find(id => id.countryCode === "DE")?.value).toBe("DE123456789")
      await caller.settings.update({ primaryTaxId: "12345678", primaryTaxIdScheme: "cvr", momsRegistered: true })
      const restored = await prisma.organizationTaxId.findMany({ where: { organizationId: orgId } })
      expect(restored.find(id => id.isPrimary)).toMatchObject({ scheme: "cvr", value: "12345678" })
      expect(restored.find(id => id.scheme === "vat" && id.countryCode === "DK")).toMatchObject({ value: "DK12345678", isPrimary: false })
      expect(restored.find(id => id.countryCode === "DE")?.value).toBe("DE123456789")
      expect(vatIdentifier([...restored].reverse(), "DK")).toBe("DK12345678")
      expect(vatIdentifier(restored, "DK")).toBe("DK12345678")
    } finally { await cleanupTestOrganizations({ where: { id: orgId } }) }
  })
  it.each([{ countryCode: "DE" }, { taxRegime: "custom" }] as const)("clears registration on scope departure %o", async departure => {
    const { orgId, caller } = await createOrgWithCaller()
    try {
      await caller.settings.update({ countryCode: "DK", taxRegime: "eu_vat", momsRegistered: true })
      await caller.settings.update(departure)
      expect((await caller.settings.get()).momsRegistered).toBeNull()
    } finally { await cleanupTestOrganizations({ where: { id: orgId } }) }
  })
})
