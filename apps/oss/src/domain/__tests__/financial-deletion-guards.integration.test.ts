import { randomUUID } from "node:crypto"
import { betterAuth } from "better-auth"
import { afterEach, describe, expect, it } from "vitest"
import { prisma } from "../../lib/db"
import { buildQuitsAuthOptions } from "../../lib/runtime/auth-config"
import { createTestOrganization, hasTestDatabase } from "../../test-utils/organization"
import { createAgreementDraft, deleteAgreementDraft } from "../commands/agreements"
import { createContact, deleteContact } from "../commands/contacts"
import { createInvoiceDraft, deleteInvoiceDraft } from "../commands/invoices"
import { createQuoteDraft, deleteQuoteDraft } from "../commands/quotes"
import { createAgentKey } from "../agent-keys"
import { executeCommand, type CommandOutcome } from "../execute"

function completed<T>(outcome: CommandOutcome<T>): T {
  expect(outcome.status).toBe("completed")
  if (outcome.status !== "completed") throw new Error(JSON.stringify(outcome))
  return outcome.result
}

describe.runIf(hasTestDatabase)("financial deletion guards", () => {
  const cleanups: Array<() => Promise<void>> = []
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()?.()
  })

  async function setup() {
    const org = await createTestOrganization()
    cleanups.push(org.cleanup)
    const actor = org.actors.admin
    const contact = completed(await executeCommand(createContact, { name: "Retained buyer" }, { actor }))
    const items = [{ description: "Retained work", quantity: 1, unitPrice: 100 }]
    const invoice = completed(await executeCommand(createInvoiceDraft, {
      contactId: contact.id, dueDate: "2099-12-01", items,
    }, { actor }))
    return { org, actor, contact, invoice, items }
  }

  async function financialEvidence() {
    const fixture = await setup()
    const { org, contact, invoice } = fixture
    await prisma.invoice.update({ where: { id: invoice.id }, data: {
      status: "sent", sellerSnapshot: { name: "Frozen seller" }, buyerSnapshot: { name: contact.name },
      artifactPdfRef: "retained/invoice.pdf", artifactPdfHash: "retained-hash",
    } })
    const payment = await prisma.payment.create({ data: {
      organizationId: org.organizationId, invoiceId: invoice.id, amount: 50,
      currency: "USD", paidAt: new Date(), method: "bank_transfer", source: "user",
    } })
    const credit = await prisma.creditNote.create({ data: {
      organizationId: org.organizationId, invoiceId: invoice.id, contactId: contact.id,
      number: "CN-RETAINED", reason: "Return", subtotalNet: 25, totalGross: 25,
      currency: "USD", countryCode: "US", locale: "en-US", timezone: "UTC", taxRegime: "us_sales_tax",
      items: { create: { description: "Return", quantity: 1, unitPriceNet: 25, unitPriceGross: 25,
        lineNet: 25, lineGross: 25, taxRate: 0 } },
    } })
    return { ...fixture, payment, credit }
  }

  async function retainedRows(organizationId: string) {
    return Promise.all([
      prisma.invoice.findMany({ where: { organizationId }, include: { items: true } }),
      prisma.payment.findMany({ where: { organizationId } }),
      prisma.creditNote.findMany({ where: { organizationId }, include: { items: true } }),
      prisma.domainEvent.findMany({ where: { organizationId }, orderBy: { sequence: "asc" } }),
    ])
  }

  it.each(["selfhost", "cloud"])("rejects Better Auth organization and user deletion in %s before changing memberships or records", async (distribution) => {
    const { org, actor } = await financialEvidence()
    const user = await prisma.user.findUniqueOrThrow({ where: { id: actor.userId } })
    const accountId = randomUUID()
    await prisma.account.create({ data: {
      id: accountId, accountId: actor.userId, userId: actor.userId, providerId: "credential",
      password: "guard-password", createdAt: new Date(), updatedAt: new Date(),
    } })
    cleanups.push(async () => { await prisma.user.deleteMany({ where: { id: actor.userId } }) })
    const env = {
      BETTER_AUTH_SECRET: "deletion-guard-test-secret-at-least-32-characters",
      BETTER_AUTH_URL: "http://localhost:3000",
      QUITS_DISTRIBUTION: distribution,
      QUITS_AUTH_CROSS_SUBDOMAIN: "false",
    } as Record<string, string>
    const auth = betterAuth({ ...buildQuitsAuthOptions({
      prisma, env: { getEnv: (name) => env[name] },
      hooks: { password: { verify: async ({ hash, password }) => hash === password } },
    }), baseURL: env.BETTER_AUTH_URL, secret: env.BETTER_AUTH_SECRET, logger: { disabled: true } })
    const signIn = await auth.api.signInEmail({ body: { email: user.email, password: "guard-password" }, asResponse: true })
    expect(signIn.status).toBe(200)
    const cookie = signIn.headers.get("set-cookie")!.split(";")[0]!
    const before = await retainedRows(org.organizationId)
    const request = (path: string, body: object) => auth.handler(new Request(`http://localhost:3000/api/auth/${path}`, {
      method: "POST", headers: { cookie, "content-type": "application/json", origin: "http://localhost:3000" },
      body: JSON.stringify(body),
    }))
    const deleted = await request("organization/delete", { organizationId: org.organizationId })
    expect(deleted.status).toBe(404)
    expect(await deleted.json()).toMatchObject({ code: "ORGANIZATION_DELETION_DISABLED" })
    expect((await request("delete-user", { password: "guard-password" })).ok).toBe(false)
    expect(await prisma.organization.findUnique({ where: { id: org.organizationId } })).not.toBeNull()
    expect(await prisma.member.count({ where: { organizationId: org.organizationId, userId: actor.userId } })).toBe(1)
    expect(await prisma.account.count({ where: { id: accountId } })).toBe(1)
    expect(await retainedRows(org.organizationId)).toEqual(before)
  })

  it("blocks direct organization deletion and preserves auth rows when the statement fails", async () => {
    const { org, actor } = await financialEvidence()
    const before = await retainedRows(org.organizationId)
    await expect(prisma.organization.delete({ where: { id: org.organizationId } })).rejects.toMatchObject({ code: "P2003" })
    expect(await prisma.member.count({ where: { organizationId: org.organizationId, userId: actor.userId } })).toBe(1)
    expect(await retainedRows(org.organizationId)).toEqual(before)
  })

  it("keeps session, account and membership cascades for direct user deletion without removing financial evidence", async () => {
    const { org, actor } = await financialEvidence()
    const before = await retainedRows(org.organizationId)
    await prisma.session.create({ data: { id: randomUUID(), token: randomUUID(), userId: actor.userId,
      activeOrganizationId: org.organizationId, expiresAt: new Date("2099-12-01"), createdAt: new Date(), updatedAt: new Date() } })
    await prisma.account.create({ data: { id: randomUUID(), accountId: actor.userId, providerId: "credential",
      userId: actor.userId, createdAt: new Date(), updatedAt: new Date() } })
    await prisma.user.delete({ where: { id: actor.userId } })
    expect(await prisma.session.count({ where: { userId: actor.userId } })).toBe(0)
    expect(await prisma.account.count({ where: { userId: actor.userId } })).toBe(0)
    expect(await prisma.member.count({ where: { userId: actor.userId } })).toBe(0)
    expect(await retainedRows(org.organizationId)).toEqual(before)
  })

  it("blocks direct document and agent-key deletion when children contain financial details or approval evidence", async () => {
    const { org, actor, contact, invoice, credit, items } = await financialEvidence()
    const quote = completed(await executeCommand(createQuoteDraft, { contactId: contact.id, expiryDate: "2099-12-01", items }, { actor }))
    const agreement = completed(await executeCommand(createAgreementDraft, {
      contactId: contact.id, title: "Retained offer", termsMarkdown: "Work", validUntil: "2099-12-01",
      deliverables: [{ title: "Work", ...items[0]! }],
    }, { actor }))
    const { key } = await createAgentKey(actor, {
      name: "Approval evidence", mode: "approval_required", scopes: ["invoice:send"] })
    await prisma.approvalRequest.create({ data: { organizationId: org.organizationId, agentKeyId: key.id,
      commandReceiptId: randomUUID(), commandType: "invoice.send", command: { id: invoice.id },
      summary: "Retained approval", expiresAt: new Date("2099-12-01") } })
    for (const remove of [
      () => prisma.invoice.delete({ where: { id: invoice.id } }),
      () => prisma.quote.delete({ where: { id: quote.id } }),
      () => prisma.creditNote.delete({ where: { id: credit.id } }),
      () => prisma.agreement.delete({ where: { id: agreement.id } }),
      () => prisma.agentKey.delete({ where: { id: key.id } }),
    ]) await expect(remove()).rejects.toMatchObject({ code: "P2003" })
    expect(await prisma.invoiceItem.count({ where: { invoiceId: invoice.id } })).toBe(1)
    expect(await prisma.quoteItem.count({ where: { quoteId: quote.id } })).toBe(1)
    expect(await prisma.creditNoteItem.count({ where: { creditNoteId: credit.id } })).toBe(1)
    expect(await prisma.deliverable.count({ where: { agreementId: agreement.id } })).toBe(1)
    expect(await prisma.approvalRequest.count({ where: { agentKeyId: key.id } })).toBe(1)
  })

  it("removes supported drafts and their children explicitly while retaining deletion events", async () => {
    const { org, actor, contact, invoice, items } = await setup()
    await prisma.invoiceReminder.create({ data: { invoiceId: invoice.id, offsetDays: 7, scheduledFor: new Date("2099-12-08") } })
    const quote = completed(await executeCommand(createQuoteDraft, { contactId: contact.id, expiryDate: "2099-12-01", items }, { actor }))
    const agreement = completed(await executeCommand(createAgreementDraft, {
      contactId: contact.id, title: "Draft offer", termsMarkdown: "Work", validUntil: "2099-12-01",
      deliverables: [{ title: "Work", ...items[0]! }],
    }, { actor }))
    // Each parent is protected even while it is a draft.
    await expect(prisma.invoice.delete({ where: { id: invoice.id } })).rejects.toMatchObject({ code: "P2003" })
    completed(await executeCommand(deleteInvoiceDraft, { id: invoice.id }, { actor }))
    completed(await executeCommand(deleteQuoteDraft, { id: quote.id }, { actor }))
    completed(await executeCommand(deleteAgreementDraft, { id: agreement.id }, { actor }))
    expect(await prisma.invoice.count({ where: { id: invoice.id } })).toBe(0)
    expect(await prisma.invoiceItem.count({ where: { invoiceId: invoice.id } })).toBe(0)
    expect(await prisma.invoiceReminder.count({ where: { invoiceId: invoice.id } })).toBe(0)
    expect(await prisma.quote.count({ where: { id: quote.id } })).toBe(0)
    expect(await prisma.quoteItem.count({ where: { quoteId: quote.id } })).toBe(0)
    expect(await prisma.agreement.count({ where: { id: agreement.id } })).toBe(0)
    expect(await prisma.deliverable.count({ where: { agreementId: agreement.id } })).toBe(0)
    expect((await prisma.domainEvent.findMany({ where: { organizationId: org.organizationId, type: { endsWith: ".draft_deleted" } } }))
      .map(({ type }) => type).sort()).toEqual(["agreement.draft_deleted", "invoice.draft_deleted", "quote.draft_deleted"])
  })

  it("preserves issued children and the existing linked-contact guard", async () => {
    const { actor, contact, invoice } = await financialEvidence()
    expect(await executeCommand(deleteInvoiceDraft, { id: invoice.id }, { actor })).toMatchObject({ status: "failed", error: { code: "not_draft" } })
    expect(await executeCommand(deleteContact, { id: contact.id }, { actor })).toMatchObject({ status: "failed" })
    expect(await prisma.invoiceItem.count({ where: { invoiceId: invoice.id } })).toBe(1)
    expect(await prisma.contact.findUnique({ where: { id: contact.id } })).not.toBeNull()
    const unused = completed(await executeCommand(createContact, { name: "Unused buyer", taxIds: [{ scheme: "vat", value: "123" }] }, { actor }))
    completed(await executeCommand(deleteContact, { id: unused.id }, { actor }))
    expect(await prisma.contact.findUnique({ where: { id: unused.id } })).toBeNull()
    expect(await prisma.contactTaxId.count({ where: { contactId: unused.id } })).toBe(0)
  })

  it("rolls back explicit child removal when a parent still has financial references", async () => {
    const { org, actor, invoice } = await setup()
    await prisma.invoiceReminder.create({ data: { invoiceId: invoice.id, offsetDays: 7, scheduledFor: new Date("2099-12-08") } })
    // An inconsistent imported draft with a payment must not lose its lines on a failed delete.
    await prisma.payment.create({ data: { organizationId: org.organizationId, invoiceId: invoice.id,
      amount: 50, currency: "USD", paidAt: new Date(), method: "bank_transfer", source: "user" } })
    const before = await retainedRows(org.organizationId)
    await expect(executeCommand(deleteInvoiceDraft, { id: invoice.id }, { actor })).rejects.toMatchObject({ code: "P2003" })
    expect(await retainedRows(org.organizationId)).toEqual(before)
    expect(await prisma.invoiceReminder.count({ where: { invoiceId: invoice.id } })).toBe(1)
    expect(await prisma.domainEvent.count({ where: { organizationId: org.organizationId, type: "invoice.draft_deleted" } })).toBe(0)
  })

  it("cleans up fixtures bottom-up without touching another organization's records", async () => {
    const first = await financialEvidence()
    const second = await financialEvidence()
    const secondRows = await retainedRows(second.org.organizationId)
    await first.org.cleanup()
    expect(await prisma.organization.findUnique({ where: { id: first.org.organizationId } })).toBeNull()
    expect(await retainedRows(first.org.organizationId)).toEqual([[], [], [], []])
    expect(await retainedRows(second.org.organizationId)).toEqual(secondRows)
  })
})
