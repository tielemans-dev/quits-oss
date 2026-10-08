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

const bankAccount = {
  accountHolder: "Nordic Design ApS",
  bankName: "Danske Bank",
  regNumber: "0040",
  accountNumber: "0440116243",
  iban: "DK5000400440116243",
  bic: "DABADKKK",
}
const paymentNote = "MobilePay Box 12345"
const details = { bankAccount, note: paymentNote }
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

async function setup(options: { details?: { bankAccount?: Partial<typeof bankAccount> | null; note?: string | null } | null } = {}) {
  const org = await createTestOrganization()
  cleanups.push(org.cleanup)
  const admin = appRouter.createCaller({
    session: {
      user: { id: org.actors.admin.userId, email: "admin@test.quits.invalid", name: "admin" },
      session: { activeOrganizationId: org.organizationId },
    },
  } as never)
  if (options.details !== null) await admin.paymentDetails.update(options.details ?? details)
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

;(hasTestDatabase ? describe : describe.skip)("payment details on issued invoices", () => {
  it("freezes the details onto the invoice, its event, its PDF input and its e-invoice input", async () => {
    const context = await setup()
    const invoice = await draft(context)
    await issue(context, invoice.id)

    const seller = await sellerOf(invoice.id)
    expect(seller?.bankAccount).toEqual(bankAccount)
    expect(seller?.paymentNote).toBe(paymentNote)

    const row = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })
    const snapshotSeller = parseSellerSnapshot((row.issuanceSnapshot as { seller: unknown }).seller)
    expect(snapshotSeller?.bankAccount).toEqual(bankAccount)
    expect(snapshotSeller?.paymentNote).toBe(paymentNote)

    const event = await prisma.domainEvent.findFirstOrThrow({
      where: { aggregateId: invoice.id, type: "invoice.issued" },
    })
    const issuedSeller = invoiceIssuedSchema.parse(event.payload).seller
    expect(issuedSeller.bankAccount).toEqual(bankAccount)
    expect(issuedSeller.paymentNote).toBe(paymentNote)

    const rendered = await storedRenderInput(context, invoice.id)
    expect(rendered.pdf.invoice.bankAccount).toEqual(bankAccount)
    expect(rendered.pdf.invoice.paymentNote).toBe(paymentNote)
    expect(rendered.pdf.invoice.number).toBe(row.number)
    expect(rendered.ubl?.payment).toEqual({ iban: "DK5000400440116243", bic: "DABADKKK", reference: row.number })
  })

  it("keeps an issued invoice unchanged when the settings change afterwards", async () => {
    const context = await setup()
    const first = await draft(context)
    await issue(context, first.id)

    await context.admin.paymentDetails.update({
      bankAccount: { ...bankAccount, iban: otherIban, bic: "NWBKGB2L", regNumber: "1111" },
      note: "New account",
    })
    expect((await context.admin.paymentDetails.get()).bankAccount?.iban).toBe(otherIban)

    // The stored seller snapshot and the stored PDF still name the account in force at issue time.
    expect((await sellerOf(first.id))?.bankAccount).toEqual(bankAccount)
    const frozen = await storedRenderInput(context, first.id)
    expect(frozen.pdf.invoice.bankAccount).toEqual(bankAccount)
    expect(frozen.pdf.invoice.paymentNote).toBe(paymentNote)
    expect(frozen.ubl?.payment?.iban).toBe("DK5000400440116243")

    // An invoice issued after the change carries the new account.
    const second = await draft(context)
    await issue(context, second.id)
    expect(await sellerOf(second.id)).toMatchObject({
      bankAccount: { iban: otherIban, bic: "NWBKGB2L" },
      paymentNote: "New account",
    })
    expect((await storedRenderInput(context, second.id)).ubl?.payment?.iban).toBe(otherIban)
    expect((await sellerOf(first.id))?.bankAccount).toEqual(bankAccount)
  })

  it("renders a draft with the current settings, and an issued invoice with the frozen ones", async () => {
    const context = await setup()
    const invoice = await draft(context)

    const preview = async () => {
      const response = await documentPdf("invoice", invoice.id, context.org.organizationId)
      expect(response.headers.get("X-Quits-Artifact")).toBe("live")
      const { bankAccount: account, paymentNote: note } = (JSON.parse(await response.text()) as RenderInput & { kind: "invoice" }).pdf.invoice
      return { bankAccount: account, paymentNote: note }
    }
    expect(await preview()).toEqual({ bankAccount, paymentNote })
    await context.admin.paymentDetails.update({ bankAccount: { iban: otherIban } })
    expect(await preview()).toMatchObject({ bankAccount: { iban: otherIban, regNumber: null }, paymentNote: undefined })

    await issue(context, invoice.id)
    await context.admin.paymentDetails.update({ bankAccount: { iban: "DE89370400440532013000" } })
    expect((await storedRenderInput(context, invoice.id)).pdf.invoice.bankAccount).toMatchObject({ iban: otherIban })
  })

  it("adds no payment details for an organization that has entered none", async () => {
    const context = await setup({ details: null })
    const invoice = await draft(context)
    await issue(context, invoice.id)

    const seller = await sellerOf(invoice.id)
    expect(seller).not.toBeNull()
    expect(seller && ("bankAccount" in seller || "paymentNote" in seller)).toBe(false)
    const rendered = await storedRenderInput(context, invoice.id)
    // The render input is exactly what it was before this feature existed.
    expect("bankAccount" in rendered.pdf.invoice || "paymentNote" in rendered.pdf.invoice).toBe(false)
    expect(rendered.ubl && "payment" in rendered.ubl).toBe(false)
  })

  it("freezes a note without a bank account, and leaves the note out when there is none", async () => {
    const noteOnly = await setup({ details: { note: "Pay by MobilePay" } })
    const invoice = await draft(noteOnly)
    await issue(noteOnly, invoice.id)
    const seller = await sellerOf(invoice.id)
    expect(seller?.paymentNote).toBe("Pay by MobilePay")
    expect(seller && "bankAccount" in seller).toBe(false)

    const accountOnly = await setup({ details: { bankAccount } })
    const second = await draft(accountOnly)
    await issue(accountOnly, second.id)
    const sellerWithoutNote = await sellerOf(second.id)
    expect(sellerWithoutNote?.bankAccount).toEqual(bankAccount)
    expect(sellerWithoutNote && "paymentNote" in sellerWithoutNote).toBe(false)
  })

  it("keeps parsing and rendering an invoice issued before payment details existed", async () => {
    const context = await setup()
    const invoice = await draft(context)
    await issue(context, invoice.id)
    // Remove what this feature added, leaving a snapshot as it was stored before.
    const row = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })
    const { bankAccount: _account, paymentNote: _note, ...legacySeller } = row.sellerSnapshot as Record<string, unknown>
    await prisma.invoice.update({ where: { id: invoice.id }, data: { sellerSnapshot: legacySeller as never } })

    const seller = await sellerOf(invoice.id)
    expect(seller?.companyName).toBeTruthy()
    expect(seller?.bankAccount).toBeUndefined()
    expect(seller?.paymentNote).toBeUndefined()
    expect((await documentPdf("invoice", invoice.id, context.org.organizationId)).status).toBe(200)
  })

  it("does not put the invoice's payment details on its credit note", async () => {
    const context = await setup()
    const invoice = await draft(context)
    await issue(context, invoice.id)
    expect((await sellerOf(invoice.id))?.bankAccount).toEqual(bankAccount)

    const credit = await issueDocument({
      kind: "creditNote",
      actor: context.actor,
      commandInput: { invoiceId: invoice.id, mode: "full", reason: "Correction" },
    })
    expect(credit, JSON.stringify(credit)).toMatchObject({ status: "completed" })

    const note = await prisma.creditNote.findFirstOrThrow({ where: { invoiceId: invoice.id } })
    const seller = parseSellerSnapshot(note.sellerSnapshot)
    expect(seller?.companyName).toBeTruthy()
    expect(seller && ("bankAccount" in seller || "paymentNote" in seller)).toBe(false)
    const event = await prisma.domainEvent.findFirstOrThrow({
      where: { aggregateId: note.id, type: "credit_note.issued" },
    })
    expect(JSON.stringify(event.payload)).not.toContain(bankAccount.iban)
    expect(JSON.stringify(note.issuanceSnapshot)).not.toContain(bankAccount.iban)
    expect(JSON.stringify(note.issuanceSnapshot)).not.toContain(paymentNote)
  })

  it("does not put payment details on a quote", async () => {
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
    expect(seller && ("bankAccount" in seller || "paymentNote" in seller)).toBe(false)
  })
})
