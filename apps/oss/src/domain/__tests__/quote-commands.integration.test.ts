import { afterEach, describe, expect, it } from "vitest"
import { prisma } from "../../lib/db"
import { signQuotePublicToken } from "../../lib/quotes/public"
import { decidePublicQuoteByToken } from "../../lib/quotes/public-access"
import { createTestOrganization, hasTestDatabase } from "../../test-utils/organization"
import { createContact } from "../commands/contacts"
import {
  convertQuoteToInvoice,
  createQuoteDraft,
  recordQuoteCustomerDecision,
  sendQuote,
} from "../commands/quotes"
import { readActivity } from "../events"
import { executeCommand } from "../execute"

const describeIfDatabase = hasTestDatabase ? describe : describe.skip
const secret = "quote-commands-test-secret"

describeIfDatabase("quote commands", () => {
  const cleanups: Array<() => Promise<void>> = []
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()?.()
  })

  async function setupWithContact() {
    const org = await createTestOrganization({ roles: ["admin", "member"] })
    cleanups.push(org.cleanup)
    const contact = await executeCommand(
      createContact,
      { name: "Acme", email: "billing@acme.test" },
      { actor: org.actors.admin }
    )
    if (contact.status !== "completed") throw new Error("contact setup failed")
    return { org, contactId: contact.result.id }
  }

  const draft = (contactId: string) => ({
    contactId,
    expiryDate: "2026-12-01",
    taxRate: 25,
    items: [{ description: "Design", quantity: 2, unitPrice: 100 }],
  })

  it("allocates unique sequential numbers under concurrent creates", async () => {
    const { org, contactId } = await setupWithContact()
    const outcomes = await Promise.all(
      Array.from({ length: 6 }, () =>
        executeCommand(createQuoteDraft, draft(contactId), { actor: org.actors.admin })
      )
    )

    const numbers = outcomes.map((outcome) => {
      if (outcome.status !== "completed") throw new Error(JSON.stringify(outcome))
      return outcome.result.number
    })
    expect(new Set(numbers).size).toBe(6)
    expect([...numbers].sort()).toEqual([
      "QTE-0001",
      "QTE-0002",
      "QTE-0003",
      "QTE-0004",
      "QTE-0005",
      "QTE-0006",
    ])
  })

  it("records the full lifecycle and converts into an identical invoice", async () => {
    const { org, contactId } = await setupWithContact()
    const created = await executeCommand(createQuoteDraft, draft(contactId), { actor: org.actors.admin })
    if (created.status !== "completed") throw new Error("create failed")
    expect(created.result.totalGross.toNumber()).toBe(250)

    const sent = await executeCommand(
      sendQuote,
      { id: created.result.id, allowSendWithoutEmail: true },
      { actor: org.actors.admin }
    )
    expect(sent).toMatchObject({ status: "completed", result: { status: "sent" } })

    const token = signQuotePublicToken(
      { quoteId: created.result.id, keyVersion: 1, scope: "quote_public" },
      secret
    )
    const decided = await decidePublicQuoteByToken(token, secret, { decision: "accepted" })
    expect(decided.decisionState).toBe("accepted")

    const converted = await executeCommand(
      convertQuoteToInvoice,
      { id: created.result.id },
      { actor: org.actors.member }
    )
    if (converted.status !== "completed") throw new Error(JSON.stringify(converted))
    const invoice = converted.result
    const quote = await prisma.quote.findUniqueOrThrow({
      where: { id: created.result.id },
      include: { items: { orderBy: { sortOrder: "asc" } } },
    })

    expect(invoice).toMatchObject({
      number: "INV-0001",
      status: "draft",
      quoteId: quote.id,
      contactId: quote.contactId,
      dueDate: quote.expiryDate,
      currency: quote.currency,
      complianceStatus: quote.complianceStatus,
      sellerSnapshot: quote.sellerSnapshot,
      buyerSnapshot: quote.buyerSnapshot,
    })
    expect(invoice.totalGross.toNumber()).toBe(quote.totalGross.toNumber())
    expect(invoice.items.map((item) => [item.description, item.lineGross.toNumber()])).toEqual(
      quote.items.map((item) => [item.description, item.lineGross.toNumber()])
    )

    const quoteActivity = await readActivity({
      organizationId: org.organizationId,
      aggregateType: "quote",
      aggregateId: quote.id,
    })
    expect(quoteActivity.events.map((event) => event.type)).toEqual([
      "quote.draft_created",
      "quote.sent",
      "quote.accepted",
      "quote.converted",
    ])
    expect(quoteActivity.events[2]?.actor).toMatchObject({
      kind: "system",
      label: "Customer (public quote link)",
    })

    const invoiceActivity = await readActivity({
      organizationId: org.organizationId,
      aggregateType: "invoice",
      aggregateId: invoice.id,
    })
    expect(invoiceActivity.events.map((event) => event.type)).toEqual(["invoice.draft_created"])
  })

  it("does not let users record a customer decision", async () => {
    const { org, contactId } = await setupWithContact()
    const created = await executeCommand(createQuoteDraft, draft(contactId), { actor: org.actors.admin })
    if (created.status !== "completed") throw new Error("create failed")
    await executeCommand(
      sendQuote,
      { id: created.result.id, allowSendWithoutEmail: true },
      { actor: org.actors.admin }
    )

    const outcome = await executeCommand(
      recordQuoteCustomerDecision,
      { quoteId: created.result.id, keyVersion: 1, decision: "accepted" },
      { actor: org.actors.admin }
    )
    expect(outcome).toMatchObject({ status: "failed", error: { code: "customer_only" } })
  })
})
