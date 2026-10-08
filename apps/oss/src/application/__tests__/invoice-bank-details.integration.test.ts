import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { parseSellerSnapshot } from "@quits/contracts/documents"
import { prisma } from "../../lib/db"
import { createTestOrganization, hasTestDatabase } from "../../test-utils/organization"
import { createInvoiceDraft } from "../../domain/commands/invoices"
import { createQuoteDraft } from "../../domain/commands/quotes"
import { executeCommand } from "../../domain/execute"
import { issueDocument } from "../issuance"
import { documentPdf } from "../../lib/documents/pdf-access"
import { invoiceIssuedSchema } from "../../domain/events/money"
import type { RenderInput } from "../../domain/documents/render-input"
import { appRouter } from "../../trpc/router"

const bankDetails = {
  accountHolder: "Nordic Design ApS",
  bankName: "Danske Bank",
  regNumber: "0040",
  accountNumber: "0440116243",
  iban: "DK5000400440116243",
  bic: "DABADKKK",
  note: "MobilePay Box 12345",
}
const otherIban = "GB82WEST12345698765432"

const cleanups: Array<() => Promise<void>> = []
beforeEach(() => {
  // Without an email provider an invoice can be issued without sending an email.
  vi.stubEnv("RESEND_API_KEY", "")
})
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.()
  vi.unstubAllEnvs()
})

async function setup(options: { details?: Partial<typeof bankDetails> | null } = {}) {
  const org = await createTestOrganization()
  cleanups.push(org.cleanup)
  const admin = appRouter.createCaller({
    session: {
      user: { id: org.actors.admin.userId, email: "admin@test.quits.invalid", name: "admin" },
      session: { activeOrganizationId: org.organizationId },
    },
  } as never)
  if (options.details !== null) await admin.paymentDetails.update(options.details ?? bankDetails)
  const contact = await prisma.contact.create({
    data: { organizationId: org.organizationId, name: "Customer", email: "customer@example.test" },
  })
  return { org, actor: org.actors.admin, admin, contact }
}

type Context = Awaited<ReturnType<typeof setup>>

async function draft(context: Context) {
  const created = await executeCommand(
    createInvoiceDraft,
    {
      contactId: context.contact.id,
      dueDate: "2099-01-01",
      taxRate: 0,
      items: [{ description: "Work", quantity: 1, unitPrice: 100 }],
    },
    { actor: context.actor }
  )
  if (created.status !== "completed") throw new Error(JSON.stringify(created))
  return created.result
}

async function issue(context: Context, id: string) {
  const result = await issueDocument({
    kind: "invoice",
    actor: context.actor,
    commandInput: { id, allowSendWithoutEmail: true },
  })
  expect(result, JSON.stringify(result)).toMatchObject({ status: "completed" })
}

/** The render input stored with an issued document: the synthetic test renderer writes it as the PDF. */
async function storedRenderInput(context: Context, id: string) {
  const response = await documentPdf("invoice", id, context.org.organizationId)
  expect(response.status).toBe(200)
  expect(response.headers.get("X-Quits-Artifact")).toBe("stored")
  return JSON.parse(await response.text()) as RenderInput & { kind: "invoice" }
}

const sellerOf = async (id: string) =>
  parseSellerSnapshot((await prisma.invoice.findUniqueOrThrow({ where: { id } })).sellerSnapshot)

;(hasTestDatabase ? describe : describe.skip)("bank details on issued invoices", () => {
  it("freezes the details onto the invoice, its event, its PDF input and its e-invoice input", async () => {
    const context = await setup()
    const invoice = await draft(context)
    await issue(context, invoice.id)

    expect((await sellerOf(invoice.id))?.bankDetails).toEqual(bankDetails)

    const row = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })
    expect(parseSellerSnapshot((row.issuanceSnapshot as { seller: unknown }).seller)?.bankDetails).toEqual(bankDetails)

    const event = await prisma.domainEvent.findFirstOrThrow({
      where: { aggregateId: invoice.id, type: "invoice.issued" },
    })
    expect(invoiceIssuedSchema.parse(event.payload).seller.bankDetails).toEqual(bankDetails)

    const rendered = await storedRenderInput(context, invoice.id)
    expect(rendered.pdf.invoice.bankDetails).toEqual(bankDetails)
    expect(rendered.pdf.invoice.number).toBe(row.number)
    expect(rendered.ubl?.payment).toEqual({ iban: "DK5000400440116243", bic: "DABADKKK", reference: row.number })
  })

  it("keeps an issued invoice unchanged when the settings change afterwards", async () => {
    const context = await setup()
    const first = await draft(context)
    await issue(context, first.id)

    await context.admin.paymentDetails.update({
      ...bankDetails,
      iban: otherIban,
      bic: "NWBKGB2L",
      regNumber: "1111",
      note: "New account",
    })
    expect((await context.admin.paymentDetails.get()).details.iban).toBe(otherIban)

    // The stored seller snapshot and the stored PDF still name the account in force at issue time.
    expect((await sellerOf(first.id))?.bankDetails).toEqual(bankDetails)
    const frozen = await storedRenderInput(context, first.id)
    expect(frozen.pdf.invoice.bankDetails).toEqual(bankDetails)
    expect(frozen.ubl?.payment?.iban).toBe("DK5000400440116243")

    // An invoice issued after the change carries the new account.
    const second = await draft(context)
    await issue(context, second.id)
    expect((await sellerOf(second.id))?.bankDetails).toMatchObject({ iban: otherIban, bic: "NWBKGB2L", note: "New account" })
    expect((await storedRenderInput(context, second.id)).ubl?.payment?.iban).toBe(otherIban)
    expect((await sellerOf(first.id))?.bankDetails).toEqual(bankDetails)
  })

  it("renders a draft with the current settings, and an issued invoice with the frozen ones", async () => {
    const context = await setup()
    const invoice = await draft(context)

    const preview = async () => {
      const response = await documentPdf("invoice", invoice.id, context.org.organizationId)
      expect(response.headers.get("X-Quits-Artifact")).toBe("live")
      return (JSON.parse(await response.text()) as RenderInput & { kind: "invoice" }).pdf.invoice.bankDetails
    }
    expect(await preview()).toEqual(bankDetails)
    await context.admin.paymentDetails.update({ iban: otherIban })
    expect(await preview()).toMatchObject({ iban: otherIban, regNumber: null, note: null })

    await issue(context, invoice.id)
    await context.admin.paymentDetails.update({ iban: "DE89370400440532013000" })
    expect((await storedRenderInput(context, invoice.id)).pdf.invoice.bankDetails).toMatchObject({ iban: otherIban })
  })

  it("adds no bank details for an organization that has entered none", async () => {
    const context = await setup({ details: null })
    const invoice = await draft(context)
    await issue(context, invoice.id)

    const seller = await sellerOf(invoice.id)
    expect(seller).not.toBeNull()
    expect(seller && "bankDetails" in seller).toBe(false)
    const rendered = await storedRenderInput(context, invoice.id)
    // The render input is exactly what it was before this feature existed.
    expect("bankDetails" in rendered.pdf.invoice).toBe(false)
    expect(rendered.ubl && "payment" in rendered.ubl).toBe(false)
  })

  it("keeps parsing and rendering an invoice issued before bank details existed", async () => {
    const context = await setup()
    const invoice = await draft(context)
    await issue(context, invoice.id)
    // Remove what this feature added, leaving a snapshot as it was stored before.
    const row = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })
    const { bankDetails: _frozen, ...legacySeller } = row.sellerSnapshot as Record<string, unknown>
    await prisma.invoice.update({ where: { id: invoice.id }, data: { sellerSnapshot: legacySeller as never } })

    const seller = await sellerOf(invoice.id)
    expect(seller?.companyName).toBeTruthy()
    expect(seller?.bankDetails).toBeUndefined()
    expect((await documentPdf("invoice", invoice.id, context.org.organizationId)).status).toBe(200)
  })

  it("does not put the invoice's bank details on its credit note", async () => {
    const context = await setup()
    const invoice = await draft(context)
    await issue(context, invoice.id)
    expect((await sellerOf(invoice.id))?.bankDetails).toEqual(bankDetails)

    const credit = await issueDocument({
      kind: "creditNote",
      actor: context.actor,
      commandInput: { invoiceId: invoice.id, mode: "full", reason: "Correction" },
    })
    expect(credit, JSON.stringify(credit)).toMatchObject({ status: "completed" })

    const note = await prisma.creditNote.findFirstOrThrow({ where: { invoiceId: invoice.id } })
    const seller = parseSellerSnapshot(note.sellerSnapshot)
    expect(seller?.companyName).toBeTruthy()
    expect(seller && "bankDetails" in seller).toBe(false)
    const event = await prisma.domainEvent.findFirstOrThrow({
      where: { aggregateId: note.id, type: "credit_note.issued" },
    })
    expect(JSON.stringify(event.payload)).not.toContain(bankDetails.iban)
    expect(JSON.stringify(note.issuanceSnapshot)).not.toContain(bankDetails.iban)
  })

  it("does not put bank details on a quote", async () => {
    const context = await setup()
    const created = await executeCommand(
      createQuoteDraft,
      {
        contactId: context.contact.id,
        expiryDate: "2099-01-01",
        items: [{ description: "Work", quantity: 1, unitPrice: 100 }],
      },
      { actor: context.actor }
    )
    if (created.status !== "completed") throw new Error(JSON.stringify(created))
    const quote = await prisma.quote.findUniqueOrThrow({ where: { id: created.result.id } })
    const seller = parseSellerSnapshot(quote.sellerSnapshot)
    expect(seller?.companyName).toBeTruthy()
    expect(seller && "bankDetails" in seller).toBe(false)
  })
})
