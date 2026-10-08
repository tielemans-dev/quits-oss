import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
vi.mock("../../lib/email", async () => ({
  ...await vi.importActual<typeof import("../../lib/email")>("../../lib/email"), deliver: vi.fn(),
}))
import { prisma } from "../../lib/db"
import { deliver, EmailSendError } from "../../lib/email"
import { createTestOrganization, hasTestDatabase } from "../../test-utils/organization"
import { createContact } from "../../domain/commands/contacts"
import { createInvoiceDraft, deleteInvoiceDraft, sendInvoice } from "../../domain/commands/invoices"
import { convertQuoteToInvoice, createQuoteDraft, sendQuote } from "../../domain/commands/quotes"
import { createRecurringInvoice, runRecurringInvoiceNow } from "../../domain/commands/recurring"
import { executeCommand } from "../../domain/execute"
import { runOrganizationJobs } from "../../domain/scheduler"
import { bootstrapQuitsRuntime } from "../../lib/runtime/bootstrap"
import { setRuntimeServices, resetRuntimeServices, type ArtifactMeta, type DocumentArtifactStore } from "../../lib/runtime/services"
import type { RenderInput } from "../../domain/documents/render-input"
import { issueDocument, prepareDocument, reserveDocument } from "../issuance"

const cleanups: Array<() => Promise<void>> = []
const bytes = new Map<string, Uint8Array>()
const meta = new Map<string, ArtifactMeta>()
const render = vi.fn(async (input: RenderInput) => new TextEncoder().encode(JSON.stringify(input)))
const store: DocumentArtifactStore = {
  async put(value, metadata) {
    const ref = `${metadata.organizationId}/${metadata.documentKind}/${metadata.documentId}/${metadata.hash}.pdf`
    bytes.set(ref, value); meta.set(ref, metadata); return ref
  },
  async get(ref) { return bytes.get(ref) ?? null },
  async head(ref) { return meta.get(ref) ?? null },
  async delete(ref) { bytes.delete(ref); meta.delete(ref) },
}
beforeEach(() => {
  vi.stubEnv("RESEND_API_KEY", "synthetic-numbering")
  vi.stubEnv("FROM_EMAIL", "billing@example.test")
  vi.stubEnv("BETTER_AUTH_SECRET", "synthetic-numbering-secret-over-thirty-two-characters")
  vi.mocked(deliver).mockReset().mockResolvedValue({ id: "synthetic-delivery" })
  render.mockClear(); bytes.clear(); meta.clear()
  setRuntimeServices({ documentRenderer: { version: "test-v1", renderPdf: render }, documentArtifactStore: store })
})
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.()
  resetRuntimeServices(); vi.unstubAllEnvs()
})

async function setup() {
  const org = await createTestOrganization()
  cleanups.push(org.cleanup)
  const contact = await prisma.contact.create({ data: { organizationId: org.organizationId, name: "Customer", email: "customer@example.test" } })
  const counters = async () => {
    const settings = await prisma.orgSettings.findUniqueOrThrow({ where: { organizationId: org.organizationId } })
    return { invoice: settings.invoiceNextNum, quote: settings.quoteNextNum }
  }
  const draft = async (contactId = contact.id) => {
    const created = await executeCommand(createInvoiceDraft, { contactId, dueDate: "2099-01-01", taxRate: 0,
      items: [{ description: "Work", quantity: 1, unitPrice: 100 }] }, { actor: org.actors.admin })
    if (created.status !== "completed") throw new Error(JSON.stringify(created))
    return created.result
  }
  const issueArgs = (id: string, clientRequestId = `issue-${id}`) =>
    ({ kind: "invoice" as const, commandInput: { id }, actor: org.actors.admin, clientRequestId })
  const numberOf = async (id: string) => (await prisma.invoice.findUniqueOrThrow({ where: { id } })).number
  return { org, contact, counters, draft, issueArgs, numberOf }
}

;(hasTestDatabase ? describe : describe.skip)("numbers are assigned when a document is issued", () => {
  it("creates invoice drafts without a number and leaves the counter alone", async () => {
    const { draft, counters } = await setup()
    const first = await draft()
    await draft()
    expect(first.number).toBeNull()
    expect(await counters()).toEqual({ invoice: 1, quote: 1 })
  })

  it("issuing allocates exactly one number, advances the counter and prints the number on the PDF", async () => {
    const { draft, counters, issueArgs, numberOf } = await setup()
    const invoice = await draft()
    const outcome = await issueDocument(issueArgs(invoice.id))
    expect(outcome).toMatchObject({ status: "completed", result: { number: "INV-0001" } })
    expect(await numberOf(invoice.id)).toBe("INV-0001")
    expect(await counters()).toEqual({ invoice: 2, quote: 1 })
    const issued = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })
    expect(issued.status).toBe("sent")
    const pdf = JSON.parse(new TextDecoder().decode(bytes.get(issued.artifactPdfRef!)!)) as RenderInput
    expect(pdf.number).toBe("INV-0001")
    expect(pdf.pdf).toMatchObject({ invoice: { number: "INV-0001" } })
    expect(issued.issuanceSnapshot).toMatchObject({ number: "INV-0001" })
    const issuedEvent = await prisma.domainEvent.findFirstOrThrow({ where: { aggregateId: invoice.id, type: "invoice.issued" } })
    expect(issuedEvent.payload).toMatchObject({ number: "INV-0001" })
  })

  it("leaves no gap when a draft is deleted: create A, create B, delete A, issue B", async () => {
    const { org, draft, counters, issueArgs, numberOf } = await setup()
    const a = await draft()
    const b = await draft()
    expect(await executeCommand(deleteInvoiceDraft, { id: a.id }, { actor: org.actors.admin })).toMatchObject({ status: "completed" })
    expect(await issueDocument(issueArgs(b.id))).toMatchObject({ status: "completed" })
    expect(await numberOf(b.id)).toBe("INV-0001")
    expect(await counters()).toEqual({ invoice: 2, quote: 1 })
    const deleted = await prisma.domainEvent.findFirstOrThrow({ where: { aggregateId: a.id, type: "invoice.draft_deleted" } })
    expect(deleted.payload).toEqual({ number: null })
  })

  it("gives concurrent issuances distinct consecutive numbers", async () => {
    const { draft, counters, issueArgs, numberOf } = await setup()
    const invoices = await Promise.all(Array.from({ length: 6 }, () => draft()))
    const outcomes = await Promise.all(invoices.map(invoice => issueDocument(issueArgs(invoice.id))))
    for (const outcome of outcomes) expect(outcome.status).toBe("completed")
    const numbers = await Promise.all(invoices.map(invoice => numberOf(invoice.id)))
    expect(new Set(numbers).size).toBe(6)
    expect([...numbers].sort()).toEqual(["INV-0001", "INV-0002", "INV-0003", "INV-0004", "INV-0005", "INV-0006"])
    expect(await counters()).toEqual({ invoice: 7, quote: 1 })
    // Every stored PDF carries the number its invoice ended up with.
    for (const invoice of invoices) {
      const issued = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })
      const pdf = JSON.parse(new TextDecoder().decode(bytes.get(issued.artifactPdfRef!)!)) as RenderInput
      expect(pdf.number).toBe(issued.number)
    }
  })

  it("does not consume a number when rendering fails, and the retry takes the first number", async () => {
    const { draft, counters, issueArgs, numberOf } = await setup()
    const invoice = await draft()
    render.mockRejectedValueOnce(new Error("render failed"))
    await expect(issueDocument(issueArgs(invoice.id))).rejects.toThrow("render failed")
    expect(await numberOf(invoice.id)).toBeNull()
    expect(await counters()).toEqual({ invoice: 1, quote: 1 })
    expect(await issueDocument(issueArgs(invoice.id, "retry"))).toMatchObject({ status: "completed", result: { number: "INV-0001" } })
    expect(await counters()).toEqual({ invoice: 2, quote: 1 })
  })

  it("does not consume a number when the issuing transaction fails", async () => {
    const { org, draft, counters, issueArgs, numberOf } = await setup()
    const noEmail = await executeCommand(createContact, { name: "No email" }, { actor: org.actors.admin })
    if (noEmail.status !== "completed") throw new Error(JSON.stringify(noEmail))
    const invoice = await draft(noEmail.result.id)
    expect(await issueDocument(issueArgs(invoice.id))).toMatchObject({ status: "failed" })
    expect(await numberOf(invoice.id)).toBeNull()
    expect(await counters()).toEqual({ invoice: 1, quote: 1 })
  })

  it("keeps the number of a legacy draft that was numbered at creation, and does not move the counter", async () => {
    const { org, draft, counters, issueArgs, numberOf } = await setup()
    const legacy = await draft()
    await prisma.invoice.update({ where: { id: legacy.id }, data: { number: "INV-0007" } })
    await prisma.orgSettings.update({ where: { organizationId: org.organizationId }, data: { invoiceNextNum: 8 } })
    const before = await counters()
    expect(await issueDocument(issueArgs(legacy.id))).toMatchObject({ status: "completed", result: { number: "INV-0007" } })
    expect(await numberOf(legacy.id)).toBe("INV-0007")
    expect(await counters()).toEqual(before)
    const issued = await prisma.invoice.findUniqueOrThrow({ where: { id: legacy.id } })
    const pdf = JSON.parse(new TextDecoder().decode(bytes.get(issued.artifactPdfRef!)!)) as RenderInput
    expect(pdf.number).toBe("INV-0007")
  })

  it("refuses a rendered issuance whose number was taken meanwhile, consumes nothing, and prepares it again", async () => {
    const { org, draft, counters, issueArgs, numberOf } = await setup()
    const a = await draft()
    const b = await draft()
    const argsA = issueArgs(a.id, "request-a")
    const reservation = await reserveDocument(argsA)
    await prepareDocument(reservation.id)
    expect(reservation.reservedNumber).toBe("INV-0001")
    // B is issued first and takes the number A was prepared with.
    expect(await issueDocument(issueArgs(b.id))).toMatchObject({ status: "completed", result: { number: "INV-0001" } })

    const stale = await executeCommand(sendInvoice, { id: a.id }, {
      actor: org.actors.admin, clientRequestId: "request-a", issuanceStagingId: reservation.id,
    })
    expect(stale).toMatchObject({ status: "failed", error: { code: "number_changed" } })
    expect(await numberOf(a.id)).toBeNull()
    expect(await counters()).toEqual({ invoice: 2, quote: 1 })
    // The stale refusal is not recorded, so the same request can be issued again.
    expect(await prisma.commandReceipt.count({ where: { organizationId: org.organizationId, clientRequestId: "request-a" } })).toBe(0)

    expect(await issueDocument(argsA)).toMatchObject({ status: "completed", result: { number: "INV-0002" } })
    expect(await counters()).toEqual({ invoice: 3, quote: 1 })
    const issued = await prisma.invoice.findUniqueOrThrow({ where: { id: a.id } })
    const pdf = JSON.parse(new TextDecoder().decode(bytes.get(issued.artifactPdfRef!)!)) as RenderInput
    expect(pdf.number).toBe("INV-0002")
  })

  it("keeps an invoice's number after the email provider refuses it, and reuses it on the retry", async () => {
    const { draft, counters, issueArgs, numberOf } = await setup()
    const invoice = await draft()
    vi.mocked(deliver).mockRejectedValueOnce(new EmailSendError("validation_error", "refused"))
    await issueDocument(issueArgs(invoice.id))
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).status).toBe("draft")
    // The refused email was rendered and queued with this number, so the draft holds on to it.
    expect(await numberOf(invoice.id)).toBe("INV-0001")
    expect(await counters()).toEqual({ invoice: 2, quote: 1 })
    expect(await issueDocument(issueArgs(invoice.id, "retry"))).toMatchObject({ status: "completed", result: { number: "INV-0001" } })
    expect(await counters()).toEqual({ invoice: 2, quote: 1 })
  })

  it("numbers a recurring invoice when its automatic send issues it, not when it is generated", async () => {
    const { org, contact, counters } = await setup()
    bootstrapQuitsRuntime({})
    const schedule = await executeCommand(createRecurringInvoice, { name: "Retainer", contactId: contact.id,
      items: [{ description: "Retainer", quantity: 1, unitPrice: 100 }], taxRate: 0, intervalCount: 1,
      intervalUnit: "month", startDate: new Date().toISOString().slice(0, 10), dueInDays: 14, autoSend: true },
      { actor: org.actors.admin })
    if (schedule.status !== "completed") throw new Error(JSON.stringify(schedule))
    const run = await executeCommand(runRecurringInvoiceNow, { id: schedule.result.id }, { actor: org.actors.admin })
    expect(run).toMatchObject({ status: "completed", result: { invoice: { number: null } } })
    await runOrganizationJobs([org.organizationId])
    const generated = await prisma.invoice.findFirstOrThrow({ where: { recurringInvoiceId: schedule.result.id } })
    expect(generated).toMatchObject({ status: "sent", number: "INV-0001" })
    expect(await counters()).toEqual({ invoice: 2, quote: 1 })
  })

  it("leaves a recurring invoice without auto-send unnumbered", async () => {
    const { org, contact, counters } = await setup()
    const schedule = await executeCommand(createRecurringInvoice, { name: "Manual", contactId: contact.id,
      items: [{ description: "Retainer", quantity: 1, unitPrice: 100 }], taxRate: 0, intervalCount: 1,
      intervalUnit: "month", startDate: new Date().toISOString().slice(0, 10), dueInDays: 14, autoSend: false },
      { actor: org.actors.admin })
    if (schedule.status !== "completed") throw new Error(JSON.stringify(schedule))
    await executeCommand(runRecurringInvoiceNow, { id: schedule.result.id }, { actor: org.actors.admin })
    const generated = await prisma.invoice.findFirstOrThrow({ where: { recurringInvoiceId: schedule.result.id } })
    expect(generated).toMatchObject({ status: "draft", number: null })
    expect(await counters()).toEqual({ invoice: 1, quote: 1 })
  })

  it("numbers a quote when it is sent, and the invoice converted from it when that is sent", async () => {
    const { org, contact, counters, issueArgs, numberOf } = await setup()
    const created = await executeCommand(createQuoteDraft, { contactId: contact.id, expiryDate: "2099-01-01", taxRate: 0,
      items: [{ description: "Work", quantity: 1, unitPrice: 100 }] }, { actor: org.actors.admin })
    if (created.status !== "completed") throw new Error(JSON.stringify(created))
    expect(created.result.number).toBeNull()
    expect(await counters()).toEqual({ invoice: 1, quote: 1 })

    const sent = await executeCommand(sendQuote, { id: created.result.id }, { actor: org.actors.admin })
    expect(sent).toMatchObject({ status: "completed", result: { number: "QTE-0001" } })
    expect(await counters()).toEqual({ invoice: 1, quote: 2 })
    await prisma.quote.update({ where: { id: created.result.id }, data: { status: "accepted" } })

    const converted = await executeCommand(convertQuoteToInvoice, { id: created.result.id }, { actor: org.actors.admin })
    if (converted.status !== "completed") throw new Error(JSON.stringify(converted))
    expect(converted.result.number).toBeNull()
    expect(await counters()).toEqual({ invoice: 1, quote: 2 })
    const issuedConverted = await issueDocument({ ...issueArgs(converted.result.id), commandInput: { id: converted.result.id, supplyDate: "2099-01-01" } })
    expect(issuedConverted, JSON.stringify(issuedConverted)).toMatchObject({ status: "completed", result: { number: "INV-0001" } })
    expect(await numberOf(converted.result.id)).toBe("INV-0001")
    expect(await counters()).toEqual({ invoice: 2, quote: 2 })
  })
})
