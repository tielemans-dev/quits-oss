import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
vi.mock("../../lib/email", async () => ({
  ...await vi.importActual<typeof import("../../lib/email")>("../../lib/email"), deliver: vi.fn(),
}))
import { prisma } from "../../lib/db"
import { deliver, EmailSendError } from "../../lib/email"
import { createTestOrganization, hasTestDatabase } from "../../test-utils/organization"
import { createContact } from "../../domain/commands/contacts"
import { createInvoiceDraft, deleteInvoiceDraft, sendInvoice } from "../../domain/commands/invoices"
import { convertQuoteToInvoice, createQuoteDraft, deleteQuoteDraft, sendQuote } from "../../domain/commands/quotes"
import { AUTO_SEND_JOB, createRecurringInvoice, runRecurringInvoiceNow } from "../../domain/commands/recurring"
import { executeCommand } from "../../domain/execute"
import { runOrganizationJobs } from "../../domain/scheduler"
import { MAX_JOB_ATTEMPTS } from "../../domain/jobs"
import { authenticateAgentSecret, createAgentKey } from "../../domain/agent-keys"
import { decideApproval, recoverInterruptedApprovals } from "../../domain/approvals"
import { setIssuanceDispatcher } from "../../domain/issuance-dispatcher"
import { bootstrapQuitsRuntime } from "../../lib/runtime/bootstrap"
import { setRuntimeServices, resetRuntimeServices, type ArtifactMeta, type DocumentArtifactStore } from "../../lib/runtime/services"
import type { RenderInput } from "../../domain/documents/render-input"
import { MAX_NUMBER_ATTEMPTS, NUMBER_CONTENTION, issueDocument, numberRetryDelayMs, prepareDocument, reserveDocument } from "../issuance"

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

  it("gives concurrent issuances distinct consecutive numbers, after the losers render again", async () => {
    const { draft, counters, issueArgs, numberOf } = await setup()
    const invoices = await Promise.all(Array.from({ length: 6 }, () => draft()))
    // Rendering takes long enough for every issuance to be prepared with the same provisional number.
    render.mockImplementation(async input => {
      await new Promise(resolve => setTimeout(resolve, 40))
      return new TextEncoder().encode(JSON.stringify(input))
    })
    const outcomes = await Promise.all(invoices.map(invoice => issueDocument(issueArgs(invoice.id))))
    for (const outcome of outcomes) expect(outcome.status).toBe("completed")
    // Only one of them can win the first round, so at least one of the others had to render again.
    expect(render.mock.calls.length).toBeGreaterThan(invoices.length)
    const superseded = await prisma.artifactStaging.count({ where: { documentKind: "invoice", status: "abandoned",
      documentId: { in: invoices.map(invoice => invoice.id) } } })
    expect(superseded).toBeGreaterThanOrEqual(1)
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
  it("delays the next attempt by a short, jittered, growing pause", () => {
    expect(numberRetryDelayMs(1, () => 0)).toBe(20)
    expect(numberRetryDelayMs(1, () => 1)).toBe(30)
    expect(numberRetryDelayMs(MAX_NUMBER_ATTEMPTS, () => 0)).toBe(20)
    expect(numberRetryDelayMs(MAX_NUMBER_ATTEMPTS, () => 1)).toBe(100)
    for (let attempt = 1; attempt <= MAX_NUMBER_ATTEMPTS; attempt++) {
      const delay = numberRetryDelayMs(attempt)
      expect(delay).toBeGreaterThanOrEqual(20)
      expect(delay).toBeLessThanOrEqual(100)
    }
  })

  /** Another issuance takes the number just before each document's transaction, whatever it was rendered with. */
  const alwaysLoseTheNumber = (organizationId: string) =>
    render.mockImplementation(async input => {
      await prisma.orgSettings.update({ where: { organizationId }, data: { invoiceNextNum: { increment: 1 } } })
      return new TextEncoder().encode(JSON.stringify(input))
    })

  it("returns a retryable failure when every attempt loses its number, and the same request can be repeated", async () => {
    const { org, draft, issueArgs, numberOf } = await setup()
    const invoice = await draft()
    alwaysLoseTheNumber(org.organizationId)
    const outcome = await issueDocument(issueArgs(invoice.id, "contended"))
    expect(outcome).toMatchObject({ status: "failed", error: { tag: "ExternalFailure", code: NUMBER_CONTENTION } })
    expect(render).toHaveBeenCalledTimes(MAX_NUMBER_ATTEMPTS)
    expect(await numberOf(invoice.id)).toBeNull()
    // Like a provider outage it leaves no receipt, so the identical call is simply made again.
    expect(await prisma.commandReceipt.count({ where: { organizationId: org.organizationId, clientRequestId: "contended" } })).toBe(0)
    render.mockImplementation(async input => new TextEncoder().encode(JSON.stringify(input)))
    expect(await issueDocument(issueArgs(invoice.id, "contended"))).toMatchObject({ status: "completed" })
    expect(await numberOf(invoice.id)).toBe(`INV-${String(MAX_NUMBER_ATTEMPTS + 1).padStart(4, "0")}`)
  }, 60_000)

  async function queueForApproval(org: Awaited<ReturnType<typeof setup>>["org"], invoiceId: string) {
    const key = await createAgentKey(org.actors.admin, { name: "Agent", mode: "approval_required", scopes: ["invoice:send"] })
    const agent = await authenticateAgentSecret(key.secret)
    const queued = await issueDocument({ kind: "invoice", commandInput: { id: invoiceId }, actor: agent, clientRequestId: "agent-send" })
    if (queued.status !== "awaiting_approval") throw new Error(JSON.stringify(queued))
    return queued
  }
  const receiptStatus = async (id: string) => (await prisma.commandReceipt.findUniqueOrThrow({ where: { id } })).status

  it("keeps an approved command awaiting while it loses its number, and records only the final outcome", async () => {
    const { org, draft, issueArgs, numberOf } = await setup()
    const invoice = await draft()
    const rival = await draft()
    const queued = await queueForApproval(org, invoice.id)
    let call = 0
    let statusWhileRetrying: string | undefined
    render.mockImplementation(async input => {
      const mine = call++
      // The rival is issued while the approved invoice is rendering, and takes its number.
      if (mine === 0) expect(await issueDocument(issueArgs(rival.id))).toMatchObject({ status: "completed" })
      if (mine === 2) statusWhileRetrying = await receiptStatus(queued.commandId)
      return new TextEncoder().encode(JSON.stringify(input))
    })
    const decided = await decideApproval({ approvalRequestId: queued.approvalRequestId, decider: org.actors.admin, decision: "approve" })
    expect(decided).toMatchObject({ status: "completed", result: { number: "INV-0002" } })
    // Between the lost number and the retry the receipt was not a failure.
    expect(call).toBe(3)
    expect(statusWhileRetrying).toBe("awaiting_approval")
    expect(await receiptStatus(queued.commandId)).toBe("completed")
    expect(await numberOf(rival.id)).toBe("INV-0001")
    expect(await numberOf(invoice.id)).toBe("INV-0002")
  })

  it("does not burn an approval when its attempts run out: the receipt keeps awaiting and recovery finishes it", async () => {
    const { org, draft, numberOf } = await setup()
    const invoice = await draft()
    const queued = await queueForApproval(org, invoice.id)
    alwaysLoseTheNumber(org.organizationId)
    const decided = await decideApproval({ approvalRequestId: queued.approvalRequestId, decider: org.actors.admin, decision: "approve" })
    expect(decided).toMatchObject({ status: "failed", error: { tag: "ExternalFailure", code: NUMBER_CONTENTION } })
    expect(await receiptStatus(queued.commandId)).toBe("awaiting_approval")
    expect(await numberOf(invoice.id)).toBeNull()

    render.mockImplementation(async input => new TextEncoder().encode(JSON.stringify(input)))
    await prisma.commandReceipt.update({ where: { id: queued.commandId }, data: { updatedAt: new Date(Date.now() - 3600_000) } })
    expect(await recoverInterruptedApprovals({ organizationIds: [org.organizationId] })).toMatchObject({ recovered: 1, failed: 0 })
    expect(await receiptStatus(queued.commandId)).toBe("completed")
    expect(await numberOf(invoice.id)).not.toBeNull()
  }, 60_000)

  it("sending a quote and requesting its approval at the same time does not deadlock", async () => {
    const { org, contact, counters } = await setup()
    const key = await createAgentKey(org.actors.admin, { name: "Agent", mode: "approval_required", scopes: ["quote:send"] })
    const agent = await authenticateAgentSecret(key.secret)
    const quotes = await Promise.all(Array.from({ length: 8 }, async () => {
      const created = await executeCommand(createQuoteDraft, { contactId: contact.id, expiryDate: "2099-01-01", taxRate: 0,
        items: [{ description: "Work", quantity: 1, unitPrice: 100 }] }, { actor: org.actors.admin })
      if (created.status !== "completed") throw new Error(JSON.stringify(created))
      return created.result
    }))
    // Each quote is sent by a person while an agent asks to send it: the number allocation and the
    // approval request both want the organization and the quote.
    const outcomes = await Promise.all(quotes.flatMap(quote => [
      executeCommand(sendQuote, { id: quote.id }, { actor: org.actors.admin, clientRequestId: `send-${quote.id}` }),
      executeCommand(sendQuote, { id: quote.id }, { actor: agent, clientRequestId: `ask-${quote.id}` }),
    ]))
    for (const outcome of outcomes) expect(["completed", "awaiting_approval"]).toContain(outcome.status)
    const numbers = (await prisma.quote.findMany({ where: { organizationId: org.organizationId } })).map(quote => quote.number)
    expect(new Set(numbers).size).toBe(8)
    expect(numbers.every(number => number !== null)).toBe(true)
    expect(await counters()).toEqual({ invoice: 1, quote: 9 })
  })

  it("records the number a deleted draft leaves unused, for invoices and quotes", async () => {
    const { org, contact, draft } = await setup()
    const numbered = await draft()
    const plain = await draft()
    await prisma.invoice.update({ where: { id: numbered.id }, data: { number: "INV-0009" } })
    const quote = await executeCommand(createQuoteDraft, { contactId: contact.id, expiryDate: "2099-01-01", taxRate: 0,
      items: [{ description: "Work", quantity: 1, unitPrice: 100 }] }, { actor: org.actors.admin })
    if (quote.status !== "completed") throw new Error(JSON.stringify(quote))
    await prisma.quote.update({ where: { id: quote.result.id }, data: { number: "QTE-0004" } })

    for (const id of [numbered.id, plain.id]) {
      expect(await executeCommand(deleteInvoiceDraft, { id }, { actor: org.actors.admin })).toMatchObject({ status: "completed" })
    }
    expect(await executeCommand(deleteQuoteDraft, { id: quote.result.id }, { actor: org.actors.admin })).toMatchObject({ status: "completed" })

    const voided = await prisma.domainEvent.findMany({ where: { organizationId: org.organizationId, type: "document.number_voided" }, orderBy: { occurredAt: "asc" } })
    expect(voided.map(event => ({ aggregateType: event.aggregateType, aggregateId: event.aggregateId, payload: event.payload }))).toEqual([
      { aggregateType: "document", aggregateId: numbered.id, payload: { organizationId: org.organizationId, documentKind: "invoice", number: "INV-0009", reason: "draft_deleted" } },
      { aggregateType: "document", aggregateId: quote.result.id, payload: { organizationId: org.organizationId, documentKind: "quote", number: "QTE-0004", reason: "draft_deleted" } },
    ])
  })

  it("keeps a failed recurring auto-send retrying on a lost number, and records the failure when the retries run out", async () => {
    const { org, contact } = await setup()
    bootstrapQuitsRuntime({})
    try {
      setIssuanceDispatcher(async () => ({ status: "failed", commandId: "cmd_stale",
        error: { tag: "InvalidState", code: "number_changed", message: "Another document was issued first. Try again." } }))
      const schedule = await executeCommand(createRecurringInvoice, { name: "Retainer", contactId: contact.id,
        items: [{ description: "Retainer", quantity: 1, unitPrice: 100 }], taxRate: 0, intervalCount: 1,
        intervalUnit: "month", startDate: new Date().toISOString().slice(0, 10), dueInDays: 14, autoSend: true },
        { actor: org.actors.admin })
      if (schedule.status !== "completed") throw new Error(JSON.stringify(schedule))
      await executeCommand(runRecurringInvoiceNow, { id: schedule.result.id }, { actor: org.actors.admin })
      await runOrganizationJobs([org.organizationId])
      const generated = await prisma.invoice.findFirstOrThrow({ where: { recurringInvoiceId: schedule.result.id } })
      const failures = () => prisma.domainEvent.count({ where: { organizationId: org.organizationId, type: "recurring.auto_send_failed" } })

      // The first attempts only retry: the draft is fine, and nothing is shown to the person yet.
      let job = await prisma.job.findFirstOrThrow({ where: { organizationId: org.organizationId, type: AUTO_SEND_JOB } })
      expect(job).toMatchObject({ status: "pending", attempts: 1, lastError: "Another document was issued first. Try again." })
      expect(await failures()).toBe(0)
      expect((await prisma.invoice.findUniqueOrThrow({ where: { id: generated.id } })).lastEmailAttemptOutcome).toBeNull()

      // On the last attempt nobody retries, so the failure is left on the draft.
      await prisma.job.update({ where: { id: job.id }, data: { attempts: MAX_JOB_ATTEMPTS - 1, runAfter: new Date(0) } })
      await runOrganizationJobs([org.organizationId])
      job = await prisma.job.findUniqueOrThrow({ where: { id: job.id } })
      expect(job).toMatchObject({ status: "failed", attempts: MAX_JOB_ATTEMPTS })
      expect(await failures()).toBe(1)
      const failed = await prisma.invoice.findUniqueOrThrow({ where: { id: generated.id } })
      expect(failed).toMatchObject({ status: "draft", number: null, lastEmailAttemptOutcome: "failed" })
      expect(failed.lastEmailAttemptMessage).toContain("Another document was issued first")
    } finally {
      bootstrapQuitsRuntime({})
    }
  })

})
