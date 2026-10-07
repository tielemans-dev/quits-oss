import { issueCreditNote } from "../../../domain/commands/credit-notes"
import { setRuntimeServices } from "../../../lib/runtime/services"
import { selfhostDocumentRenderer } from "../../../selfhost/runtime"
import { executeIssuanceCommand } from "../../../application/issuance"
import { ACCOUNTING_EXPORT_COLUMNS } from "@quits/contracts/exports"
import { afterEach, describe, expect, it } from "vitest"
import { createContact } from "../../../domain/commands/contacts"
import { createInvoiceDraft, sendInvoice } from "../../../domain/commands/invoices"

import { prisma } from "../../../lib/db"
import { createTestOrganization, hasTestDatabase } from "../../../test-utils/organization"
import { appRouter } from "../../router"

const describeIfDatabase = hasTestDatabase ? describe : describe.skip

function callerFor(organizationId: string, userId: string) {
  return appRouter.createCaller({
    session: {
      user: { id: userId, email: `${userId}@test.quits.invalid`, name: userId },
      session: { activeOrganizationId: organizationId },
    },
  } as never)
}

describeIfDatabase("exports and activity routers", () => {
  const cleanups: Array<() => Promise<void>> = []
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()?.()
  })

  async function setup(options: { peppol?: boolean } = {}) {
    const org = await createTestOrganization({
      roles: ["admin", "member", "accountant"],
      settings: {
        countryCode: "DK",
        locale: "da-DK",
        timezone: "Europe/Copenhagen",
        currency: "DKK",
        taxRegime: "eu_vat",
        companyName: "Nordic Design ApS",
      },
    })
    cleanups.push(async () => {
      await prisma.payment.deleteMany({ where: { organizationId: org.organizationId } })
      await prisma.creditNote.deleteMany({ where: { organizationId: org.organizationId } })
      await prisma.domainEvent.deleteMany({ where: { organizationId: org.organizationId } })
      await prisma.invoice.deleteMany({ where: { organizationId: org.organizationId } })
      await org.cleanup()
    })
    await prisma.orgSettings.update({
      where: { organizationId: org.organizationId },
      data: { companyAddress: "Vesterbrogade 1\n1620 København V" },
    })
    await prisma.organizationTaxId.create({
      data: { organizationId: org.organizationId, scheme: "vat", value: "12345678", isPrimary: true },
    })

    const contact = await executeIssuanceCommand(
      createContact,
      {
        name: "Hans Müller",
        email: "billing@acme.test",
        company: "Acme GmbH",
        address: "Hauptstraße 5",
        city: "Berlin",
        zip: "10115",
        country: "DE",
        ...(options.peppol === false ? {} : { peppolEndpointId: "DE123456789", peppolEndpointScheme: "9930" }),
      },
      { actor: org.actors.admin }
    )
    if (contact.status !== "completed") throw new Error(JSON.stringify(contact))

    const draft = await executeIssuanceCommand(
      createInvoiceDraft,
      {
        contactId: contact.result.id,
        dueDate: "2026-12-01",
        taxRate: 25,
        items: [{ description: "Design = good", quantity: 2, unitPrice: 100 }],
      },
      { actor: org.actors.admin }
    )
    if (draft.status !== "completed") throw new Error(JSON.stringify(draft))
    return { org, contactId: contact.result.id, invoiceId: draft.result.id }
  }

  async function send(org: Awaited<ReturnType<typeof setup>>["org"], invoiceId: string) {
    const sent = await executeIssuanceCommand(
      sendInvoice,
      { id: invoiceId, allowSendWithoutEmail: true },
      { actor: org.actors.admin }
    )
    if (sent.status !== "completed") throw new Error(JSON.stringify(sent))
  }

  it("exports issued invoices and credit notes as Peppol UBL", async () => {
    const { org, invoiceId } = await setup()
    setRuntimeServices({ documentRenderer: selfhostDocumentRenderer })
    const accountant = callerFor(org.organizationId, org.actors.accountant.userId)

    await expect(accountant.exports.einvoice({ kind: "invoice", id: invoiceId })).resolves.toEqual({
      ok: false,
      missing: ["document.notIssued"],
    })

    await send(org, invoiceId)
    const result = await accountant.exports.einvoice({ kind: "invoice", id: invoiceId })
    if (!result.ok) throw new Error(JSON.stringify(result))
    expect(result.filename).toBe("INV-0001.xml")
    expect(result.xml).toContain('<cbc:EndpointID schemeID="0184">12345678</cbc:EndpointID>')
    expect(result.xml).toContain('<cbc:EndpointID schemeID="9930">DE123456789</cbc:EndpointID>')
    expect(result.xml).toContain("<cbc:CompanyID>DK12345678</cbc:CompanyID>")
    expect(result.xml).toContain("<cbc:CityName>København V</cbc:CityName>")
    expect(result.xml).toContain('<cbc:PayableAmount currencyID="DKK">250.00</cbc:PayableAmount>')

    await prisma.contact.updateMany({ where: { organizationId: org.organizationId }, data: { company: "Changed after issue" } })
    expect(await accountant.exports.einvoice({ kind: "invoice", id: invoiceId })).toEqual(result)
    const issuedCredit = await executeIssuanceCommand(issueCreditNote, { invoiceId, mode: "amount", amount: 125, reason: "Returned" }, { actor: org.actors.admin })
    if (issuedCredit.status !== "completed") throw new Error(JSON.stringify(issuedCredit))
    const creditNote = issuedCredit.result
    const credit = await accountant.exports.einvoice({ kind: "creditNote", id: creditNote.id })
    if (!credit.ok) throw new Error(JSON.stringify(credit))
    expect(credit.xml).toContain("<cbc:CreditNoteTypeCode>381</cbc:CreditNoteTypeCode>")
    expect(credit.xml).toContain("<cbc:ID>INV-0001</cbc:ID>")

    await expect(accountant.exports.einvoice({ kind: "invoice", id: "missing" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    })
  })

  it("refuses a missing stored UBL instead of rendering issued rows", async () => {
    const { org, invoiceId } = await setup({ peppol: false })
    await send(org, invoiceId)
    const admin = callerFor(org.organizationId, org.actors.admin.userId)

    await expect(admin.exports.einvoice({ kind: "invoice", id: invoiceId })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" })
  })

  it("exports accounting CSVs for a date range", async () => {
    const { org, invoiceId } = await setup()
    await send(org, invoiceId)
    await prisma.payment.create({
      data: {
        organizationId: org.organizationId,
        invoiceId,
        amount: 50,
        currency: "DKK",
        paidAt: new Date(),
        method: "bank_transfer",
        reference: "=SUM(A1)",
        source: "user",
      },
    })
    const accountant = callerFor(org.organizationId, org.actors.accountant.userId)
    const today = new Date().toISOString().slice(0, 10)
    const range = { from: "2020-01-01", to: "2099-12-31" }

    const invoices = await accountant.exports.accounting({ ...range, dataset: "invoices" })
    expect(invoices.filename).toBe("invoices-2020-01-01_2099-12-31.csv")
    const [header, row, trailing] = invoices.csv.split("\r\n")
    expect(header).toBe(ACCOUNTING_EXPORT_COLUMNS.invoices.join(","))
    expect(row).toMatch(/^INV-0001,\d{4}-\d{2}-\d{2},2026-12-01,Acme GmbH,DKK,200.00,50.00,250.00,0.00,0.00,250.00,sent$/)
    expect(trailing).toBe("")

    const payments = await accountant.exports.accounting({ ...range, dataset: "payments" })
    expect(payments.csv.split("\r\n")[1]).toMatch(/,INV-0001,Acme GmbH,DKK,50.00,bank_transfer,'=SUM\(A1\),false,$/)

    const empty = await accountant.exports.accounting({ from: "2020-01-01", to: "2020-01-31", dataset: "creditNotes" })
    expect(empty.csv).toBe(`${ACCOUNTING_EXPORT_COLUMNS.creditNotes.join(",")}\r\n`)

    await expect(
      accountant.exports.accounting({ from: today, to: "2020-01-01", dataset: "invoices" })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" })
  })

  it("lets accountants read the audit log but not members", async () => {
    const { org, invoiceId } = await setup()
    await send(org, invoiceId)
    const accountant = callerFor(org.organizationId, org.actors.accountant.userId)
    const member = callerFor(org.organizationId, org.actors.member.userId)

    await expect(member.activity.list({})).rejects.toMatchObject({ code: "FORBIDDEN" })

    const firstPage = await accountant.activity.list({ limit: 2 })
    expect(firstPage.events.map((event) => event.type)).toEqual(["contact.created", "invoice.draft_created"])
    expect(firstPage.hasMore).toBe(true)
    expect(firstPage.events[0]!.actor).toMatchObject({
      kind: "user",
      id: org.actors.admin.userId,
      name: org.actors.admin.userId,
    })

    const secondPage = await accountant.activity.list({ afterSequence: firstPage.nextSequence })
    expect(secondPage.events.map((event) => event.type)).toEqual(["invoice.sent", "invoice.issued", "document.artifact_stored"])

    const newest = await accountant.activity.list({ order: "desc", limit: 1 })
    expect(newest.events.map((event) => event.type)).toEqual(["document.artifact_stored"])
    const older = await accountant.activity.list({ beforeSequence: newest.nextSequence, limit: 5 })
    expect(older.events.map((event) => event.type)).toEqual(["invoice.issued", "invoice.sent", "invoice.draft_created", "contact.created"])
    expect(older.hasMore).toBe(false)

    const contacts = await accountant.activity.list({ aggregateType: "contact" })
    expect(contacts.events.map((event) => event.type)).toEqual(["contact.created"])

    // Members can still see a document's own timeline.
    const timeline = await member.activity.forDocument({ aggregateType: "invoice", aggregateId: invoiceId })
    expect(timeline.events.map((event) => event.type)).toEqual(["invoice.draft_created", "invoice.sent", "invoice.issued"])
  })
})
