import { executeIssuanceCommand } from "../../application/issuance"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"

vi.mock("../../lib/email", async () => {
  const actual = await vi.importActual<typeof import("../../lib/email")>("../../lib/email")
  return { ...actual, deliver: vi.fn().mockResolvedValue({ id: "email_cn" }) }
})

import { prisma } from "../../lib/db"
import { deliver, EmailSendError } from "../../lib/email"
import { createTestOrganization, hasTestDatabase } from "../../test-utils/organization"
import { authenticateAgentSecret, createAgentKey } from "../agent-keys"
import { createContact } from "../commands/contacts"
import { issueCreditNote, sendCreditNote } from "../commands/credit-notes"
import { createInvoiceDraft, sendInvoice } from "../commands/invoices"
import { readActivity } from "../events"


const describeIfDatabase = hasTestDatabase ? describe : describe.skip

const emailEnvKeys = ["RESEND_API_KEY", "FROM_EMAIL"] as const
const savedEnv: Record<string, string | undefined> = {}

describeIfDatabase("credit note commands", () => {
  const cleanups: Array<() => Promise<void>> = []

  beforeAll(() => {
    for (const key of emailEnvKeys) {
      savedEnv[key] = process.env[key]
      delete process.env[key]
    }
  })
  afterAll(() => {
    for (const key of emailEnvKeys) {
      if (savedEnv[key] === undefined) delete process.env[key]
      else process.env[key] = savedEnv[key]
    }
  })
  afterEach(async () => {
    vi.mocked(deliver).mockClear()
    while (cleanups.length) await cleanups.pop()?.()
  })

  async function setup(roles: Array<"admin" | "member" | "accountant"> = ["admin"]) {
    const org = await createTestOrganization({ roles })
    cleanups.push(org.cleanup)
    const contact = await executeIssuanceCommand(
      createContact,
      { name: "Acme", email: "billing@acme.test" },
      { actor: org.actors.admin }
    )
    if (contact.status !== "completed") throw new Error("contact setup failed")
    return { org, contactId: contact.result.id }
  }

  /** Issues an invoice of 2 x 100 + 3 x 50 at 25% tax: 437.50 gross. */
  async function issuedInvoice(context: Awaited<ReturnType<typeof setup>>, send = true) {
    const created = await executeIssuanceCommand(
      createInvoiceDraft,
      {
        contactId: context.contactId,
        dueDate: "2026-12-01",
        taxRate: 25,
        items: [
          { description: "Design", quantity: 2, unitPrice: 100 },
          { description: "Hosting", quantity: 3, unitPrice: 50 },
        ],
      },
      { actor: context.org.actors.admin }
    )
    if (created.status !== "completed") throw new Error(JSON.stringify(created))
    if (send) {
      const sent = await executeIssuanceCommand(
        sendInvoice,
        { id: created.result.id, allowSendWithoutEmail: true },
        { actor: context.org.actors.admin }
      )
      if (sent.status !== "completed") throw new Error(JSON.stringify(sent))
      // The number is assigned when the invoice is sent.
      return { ...created.result, number: sent.result.number }
    }
    return created.result
  }

  async function issue(
    context: Awaited<ReturnType<typeof setup>>,
    input: Record<string, unknown>
  ) {
    return executeIssuanceCommand(issueCreditNote, { reason: "Customer complaint", ...input }, {
      actor: context.org.actors.admin,
    })
  }

  async function invoiceState(id: string) {
    const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id } })
    return { status: invoice.status, amountCredited: invoice.amountCredited.toNumber() }
  }

  it("fully credits an invoice, copies its lines, and marks it credited", async () => {
    const context = await setup()
    const invoice = await issuedInvoice(context)
    const outcome = await issue(context, { invoiceId: invoice.id, mode: "full" })
    if (outcome.status !== "completed") throw new Error(JSON.stringify(outcome))

    const creditNote = outcome.result
    expect(creditNote).toMatchObject({
      number: "CN-0001",
      reason: "Customer complaint",
      currency: "USD",
      locale: "en-US",
      taxRegime: "us_sales_tax",
      contactId: context.contactId,
    })
    expect(creditNote.totalGross.toNumber()).toBe(437.5)
    expect(creditNote.totalTax.toNumber()).toBe(87.5)
    expect(creditNote.items.map((item) => [item.description, item.quantity.toNumber()])).toEqual([
      ["Design", 2],
      ["Hosting", 3],
    ])
    expect(creditNote.items.every((item) => item.invoiceItemId)).toBe(true)
    expect(creditNote.buyerSnapshot).toMatchObject({ name: "Acme" })

    expect(await invoiceState(invoice.id)).toEqual({ status: "credited", amountCredited: 437.5 })

    const creditActivity = await readActivity({
      organizationId: context.org.organizationId,
      aggregateType: "credit_note",
    })
    expect(creditActivity.events.map((event) => event.type)).toEqual(["credit_note.issued"])
    const invoiceActivity = await readActivity({
      organizationId: context.org.organizationId,
      aggregateType: "invoice",
      aggregateId: invoice.id,
    })
    expect(invoiceActivity.events.map((event) => event.type)).toContain("invoice.credited")

    const again = await issue(context, { invoiceId: invoice.id, mode: "full" })
    expect(again.status === "failed" && again.error.code).toBe("fully_credited")
  })

  it("credits chosen line quantities and enforces what is left on each line", async () => {
    const context = await setup()
    const invoice = await issuedInvoice(context)
    const hosting = invoice.items.find((item) => item.description === "Hosting")
    if (!hosting) throw new Error("missing line")

    const first = await issue(context, {
      invoiceId: invoice.id,
      mode: "lines",
      lines: [{ invoiceItemId: hosting.id, quantity: 2 }],
    })
    if (first.status !== "completed") throw new Error(JSON.stringify(first))
    expect(first.result.totalGross.toNumber()).toBe(125)
    expect(first.result.items[0]?.invoiceItemId).toBe(hosting.id)
    expect(await invoiceState(invoice.id)).toEqual({ status: "sent", amountCredited: 125 })

    const tooMany = await issue(context, {
      invoiceId: invoice.id,
      mode: "lines",
      lines: [{ invoiceItemId: hosting.id, quantity: 2 }],
    })
    expect(tooMany.status === "failed" && tooMany.error.code).toBe("quantity_exceeds_remaining")

    const rest = await issue(context, {
      invoiceId: invoice.id,
      mode: "lines",
      lines: [{ invoiceItemId: hosting.id, quantity: 1 }],
    })
    expect(rest.status === "completed" && rest.result.totalGross.toNumber()).toBe(62.5)

    const unknown = await issue(context, {
      invoiceId: invoice.id,
      mode: "lines",
      lines: [{ invoiceItemId: "not-a-line", quantity: 1 }],
    })
    expect(unknown.status === "failed" && unknown.error.code).toBe("unknown_invoice_line")
  })

  it("credits an amount at the invoice tax rate and rejects over-crediting", async () => {
    const context = await setup()
    const invoice = await issuedInvoice(context)

    const amount = await issue(context, { invoiceId: invoice.id, mode: "amount", amount: 100 })
    if (amount.status !== "completed") throw new Error(JSON.stringify(amount))
    expect(amount.result.items).toHaveLength(1)
    expect(amount.result.items[0]).toMatchObject({
      description: `Credit for ${invoice.number}`,
      invoiceItemId: null,
    })
    expect(amount.result.subtotalNet.toNumber()).toBe(80)
    expect(amount.result.totalTax.toNumber()).toBe(20)

    const over = await issue(context, { invoiceId: invoice.id, mode: "amount", amount: 337.51 })
    expect(over.status === "failed" && over.error.code).toBe("exceeds_invoice_total")

    // Line remainders ignore amount credits, so the invoice total still caps line credits.
    const allLines = await issue(context, {
      invoiceId: invoice.id,
      mode: "lines",
      lines: invoice.items.map((item) => ({ invoiceItemId: item.id, quantity: item.quantity.toNumber() })),
    })
    expect(allLines.status === "failed" && allLines.error.code).toBe("exceeds_invoice_total")

    const remainder = await issue(context, { invoiceId: invoice.id, mode: "full" })
    expect(remainder.status === "completed" && remainder.result.totalGross.toNumber()).toBe(337.5)
    expect(await invoiceState(invoice.id)).toEqual({ status: "credited", amountCredited: 437.5 })
  })

  it("keeps credits and balances in whole units of a zero-decimal currency", async () => {
    const context = await setup()
    const created = await executeIssuanceCommand(
      createInvoiceDraft,
      {
        contactId: context.contactId,
        dueDate: "2026-12-01",
        currency: "JPY",
        taxRate: 25,
        items: [{ description: "Widget", quantity: 1, unitPrice: 100 }],
      },
      { actor: context.org.actors.admin }
    )
    if (created.status !== "completed") throw new Error(JSON.stringify(created))
    const sent = await executeIssuanceCommand(
      sendInvoice,
      { id: created.result.id, allowSendWithoutEmail: true, exchangeRate: "1", rateDate: "2026-10-07" },
      { actor: context.org.actors.admin }
    )
    if (sent.status !== "completed") throw new Error(JSON.stringify(sent))
    const invoice = created.result
    expect(invoice.totalGross.toNumber()).toBe(125)

    const fraction = await issue(context, { invoiceId: invoice.id, mode: "amount", amount: 0.01 })
    expect(fraction.status === "failed" && fraction.error).toMatchObject({
      tag: "ValidationFailed",
      issues: [{ path: "amount" }],
    })
    expect(await prisma.creditNote.count({ where: { invoiceId: invoice.id } })).toBe(0)

    const half = await issue(context, {
      invoiceId: invoice.id,
      mode: "lines",
      lines: [{ invoiceItemId: invoice.items[0]!.id, quantity: 0.5 }],
    })
    if (half.status !== "completed") throw new Error(JSON.stringify(half))
    for (const value of [half.result.subtotalNet, half.result.totalTax, half.result.totalGross]) {
      expect(Number.isInteger(value.toNumber())).toBe(true)
    }
    expect(half.result.items[0]?.quantity.toNumber()).toBe(0.5)
    const { amountCredited } = await invoiceState(invoice.id)
    expect(Number.isInteger(125 - amountCredited)).toBe(true)

    const remainder = await issue(context, { invoiceId: invoice.id, mode: "full" })
    if (remainder.status !== "completed") throw new Error(JSON.stringify(remainder))
    expect(await invoiceState(invoice.id)).toEqual({ status: "credited", amountCredited: 125 })
  })

  it("refuses to credit draft invoices", async () => {
    const context = await setup()
    const invoice = await issuedInvoice(context, false)
    const outcome = await issue(context, { invoiceId: invoice.id, mode: "full" })
    expect(outcome.status === "failed" && outcome.error.code).toBe("invoice_not_issued")
    expect(await prisma.creditNote.count({ where: { invoiceId: invoice.id } })).toBe(0)
  })

  it("numbers credit notes in their own sequence with the configured prefix", async () => {
    const context = await setup()
    await prisma.orgSettings.update({
      where: { organizationId: context.org.organizationId },
      data: { creditNotePrefix: "KN" },
    })
    const invoice = await issuedInvoice(context)
    const numbers: string[] = []
    for (const amount of [10, 20, 30]) {
      const outcome = await issue(context, { invoiceId: invoice.id, mode: "amount", amount })
      if (outcome.status !== "completed") throw new Error(JSON.stringify(outcome))
      numbers.push(outcome.result.number)
    }
    expect(numbers).toEqual(["KN-0001", "KN-0002", "KN-0003"])
    expect(invoice.number).toBe("INV-0001")
  })

  it("never over-credits under concurrent issues", async () => {
    const context = await setup()
    const invoice = await issuedInvoice(context)
    const outcomes = await Promise.all(
      Array.from({ length: 4 }, () => issue(context, { invoiceId: invoice.id, mode: "amount", amount: 200 }))
    )
    const completedCount = outcomes.filter((outcome) => outcome.status === "completed").length
    expect(completedCount).toBeGreaterThanOrEqual(1)
    expect(completedCount).toBeLessThanOrEqual(2)
    expect((await invoiceState(invoice.id)).amountCredited).toBe(completedCount * 200)
    for (const outcome of outcomes) {
      if (outcome.status === "failed") expect(["document_changed", "exceeds_invoice_total"]).toContain(outcome.error.code)
    }
    if (completedCount === 1) expect(await issue(context, { invoiceId: invoice.id, mode: "amount", amount: 200 })).toMatchObject({ status: "completed" })
    expect((await invoiceState(invoice.id)).amountCredited).toBe(400)
  })

  it("denies accountants and queues agent credit notes for approval", async () => {
    const context = await setup(["admin", "accountant"])
    const invoice = await issuedInvoice(context)

    const denied = await executeIssuanceCommand(
      issueCreditNote,
      { invoiceId: invoice.id, reason: "x", mode: "full" },
      { actor: context.org.actors.accountant }
    )
    expect(denied.status === "failed" && denied.error.tag).toBe("Forbidden")

    const { secret } = await createAgentKey(context.org.actors.admin, {
      name: "Bookkeeper",
      mode: "approval_required",
      scopes: ["creditNote:create", "creditNote:read"],
    })
    const agent = await authenticateAgentSecret(secret)
    const queued = await executeIssuanceCommand(
      issueCreditNote,
      { invoiceId: invoice.id, reason: "Agent refund", mode: "amount", amount: 50 },
      { actor: agent, clientRequestId: "cn-1" }
    )
    expect(queued.status).toBe("awaiting_approval")
    expect(await prisma.creditNote.count({ where: { invoiceId: invoice.id } })).toBe(0)
    const request = await prisma.approvalRequest.findFirstOrThrow({
      where: { organizationId: context.org.organizationId },
    })
    expect(request.summary).toContain("Agent refund")

    if (queued.status !== "awaiting_approval") throw new Error("expected approval")
    const approved = await executeIssuanceCommand(
      issueCreditNote,
      { invoiceId: invoice.id, reason: "Agent refund", mode: "amount", amount: 50 },
      { actor: agent, approvedByUserId: context.org.actors.admin.userId, resumeReceiptId: queued.commandId }
    )
    expect(approved.status).toBe("completed")
    expect(await prisma.creditNote.count({ where: { invoiceId: invoice.id } })).toBe(1)
  })

  describe("sending", () => {
    beforeAll(() => {
      process.env.RESEND_API_KEY = "re_test_credit_notes"
      process.env.FROM_EMAIL = "noreply@example.test"
    })
    afterAll(() => {
      for (const key of emailEnvKeys) delete process.env[key]
    })

    async function issuedCreditNote() {
      const context = await setup()
      // Invoices are sent without email here; the credit note email is mocked.
      const savedKey = process.env.RESEND_API_KEY
      delete process.env.RESEND_API_KEY
      const invoice = await issuedInvoice(context)
      process.env.RESEND_API_KEY = savedKey
      const outcome = await issue(context, { invoiceId: invoice.id, mode: "amount", amount: 50 })
      if (outcome.status !== "completed") throw new Error(JSON.stringify(outcome))
      return { context, creditNote: outcome.result }
    }

    it("emails the credit note to the invoice contact and records the attempt", async () => {
      const { context, creditNote } = await issuedCreditNote()
      const outcome = await executeIssuanceCommand(sendCreditNote, { id: creditNote.id }, {
        actor: context.org.actors.admin,
      })
      expect(outcome).toMatchObject({ status: "completed", result: { recipient: "billing@acme.test" } })
      expect(deliver).toHaveBeenCalledTimes(1)
      const [message, options] = vi.mocked(deliver).mock.calls[0]!
      expect(message.to).toBe("billing@acme.test")
      expect(message.subject).toContain(creditNote.number)
      expect(message.html).toContain("INV-0001")
      expect(options).toEqual({ provider: "resend", idempotencyKey: expect.stringMatching(/^credit-note-send:cmd_/) })
      const stored = await prisma.creditNote.findUniqueOrThrow({ where: { id: creditNote.id } })
      expect(stored.lastEmailAttemptOutcome).toBe("sent")
      const activity = await readActivity({
        organizationId: context.org.organizationId,
        aggregateType: "credit_note",
        aggregateId: creditNote.id,
      })
      expect(activity.events.map((event) => event.type)).toContain("credit_note.sent")
    })

    it("records a refused email on the credit note while the command completes", async () => {
      const { context, creditNote } = await issuedCreditNote()
      vi.mocked(deliver).mockRejectedValueOnce(new EmailSendError("validation_error", "Invalid recipient"))
      const outcome = await executeIssuanceCommand(sendCreditNote, { id: creditNote.id }, {
        actor: context.org.actors.admin,
      })
      expect(outcome.status).toBe("completed")
      const stored = await prisma.creditNote.findUniqueOrThrow({ where: { id: creditNote.id } })
      expect(stored).toMatchObject({
        lastEmailAttemptOutcome: "failed",
        lastEmailAttemptCode: "send_failed",
        lastEmailAttemptMessage: "The email provider refused the email. Check the email configuration.",
      })
      const activity = await readActivity({
        organizationId: context.org.organizationId,
        aggregateType: "credit_note",
        aggregateId: creditNote.id,
      })
      expect(activity.events.map((event) => event.type)).toContain("credit_note.email_failed")
    })
  })
})
