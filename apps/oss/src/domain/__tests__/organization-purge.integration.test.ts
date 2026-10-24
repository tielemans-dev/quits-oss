import { randomUUID } from "node:crypto"
import { afterAll, describe, expect, it } from "vitest"
import { prisma } from "../../lib/db"
import type { ArtifactMeta, DocumentArtifactStore } from "../../lib/runtime/services"
import { cleanupTestOrganizations, hasTestDatabase } from "../../test-utils/organization"
import { purgeOrganization } from "../organization-purge"

// Tables that hold no organization data. A new table must be seeded below or listed here.
const NOT_ORGANIZATION_OWNED = new Set([
  "_prisma_migrations", "verification", "auth_recovery_rate_limit", "installation_state", "cvr_trial_usage",
])

type Seeded = Map<string, { column: string; values: string[] }>

/** One row in every organization-owned table, plus a user who belongs only to this organization. */
async function seedOrganization(shared: string) {
  const run = randomUUID().slice(0, 8)
  const organizationId = `purge-${run}`
  const userId = `${organizationId}-owner`
  const now = new Date()
  const money = { subtotalNet: 100, totalGross: 125 }
  const line = { description: "Work", quantity: 1, unitPriceNet: 100, unitPriceGross: 125, lineNet: 100, lineGross: 125, taxRate: 25 }
  const actor = { actorKey: `user:${userId}`, commandId: randomUUID() }
  const ref = (id: string, format: string) => `${organizationId}/invoice/${id}/${"a".repeat(64)}.${format}`

  await prisma.organization.create({ data: { id: organizationId, name: "Purge", slug: organizationId, createdAt: now } })
  await prisma.user.create({ data: { id: userId, name: "Owner", email: `${userId}@test.quits.invalid`, emailVerified: true, createdAt: now, updatedAt: now } })
  const session = await prisma.session.create({ data: { id: `${userId}-s`, token: `${userId}-t`, userId, expiresAt: now, createdAt: now, updatedAt: now, activeOrganizationId: organizationId } })
  const account = await prisma.account.create({ data: { id: `${userId}-a`, accountId: userId, providerId: "credential", userId, createdAt: now, updatedAt: now } })
  const member = await prisma.member.create({ data: { id: `${userId}-m`, organizationId, userId, role: "admin", createdAt: now } })
  const sharedMember = await prisma.member.create({ data: { id: `${organizationId}-shared`, organizationId, userId: shared, role: "member", createdAt: now } })
  const invitation = await prisma.invitation.create({ data: { id: `${userId}-i`, organizationId, email: "invitee@test.quits.invalid", status: "pending", inviterId: userId, expiresAt: now, createdAt: now } })
  const settings = await prisma.orgSettings.create({ data: { organizationId } })
  const contact = await prisma.contact.create({ data: { organizationId, name: "Buyer", email: "buyer@test.quits.invalid" } })
  const contactTaxId = await prisma.contactTaxId.create({ data: { contactId: contact.id, scheme: "dk_cvr", value: "12345678" } })
  const learned = await prisma.learnedDefaultClear.create({ data: { organizationId, contactId: contact.id, field: "dueDays", clearedValue: 14 } })
  const catalog = await prisma.catalogItem.create({ data: { organizationId, name: "Work", defaultUnitPrice: 100 } })
  const taxId = await prisma.organizationTaxId.create({ data: { organizationId, scheme: "dk_cvr", value: "87654321" } })
  const template = await prisma.agreementTemplate.create({ data: { organizationId, name: "Terms", termsMarkdown: "Terms" } })
  const quote = await prisma.quote.create({ data: { organizationId, contactId: contact.id, expiryDate: now, ...money, items: { create: line } }, include: { items: true } })
  const agreement = await prisma.agreement.create({ data: { organizationId, contactId: contact.id, title: "Deal", termsMarkdown: "Terms", ...money, validUntil: now, templateId: template.id, sourceQuoteId: quote.id } })
  const deliverable = await prisma.deliverable.create({ data: { agreementId: agreement.id, title: "Work", ...line } })
  const recurring = await prisma.recurringInvoice.create({ data: { organizationId, contactId: contact.id, name: "Monthly", startDate: now, nextRunAt: now, currency: "DKK", taxRate: 25, items: [] } })
  const invoiceId = randomUUID()
  const invoice = await prisma.invoice.create({ data: {
    id: invoiceId, organizationId, contactId: contact.id, dueDate: now, ...money, quoteId: quote.id, agreementId: agreement.id,
    recurringInvoiceId: recurring.id, artifactPdfRef: ref(invoiceId, "pdf"), artifactUblRef: ref(invoiceId, "xml"),
    items: { create: { ...line, deliverableId: deliverable.id } }, reminders: { create: { offsetDays: 3, scheduledFor: now } },
  }, include: { items: true, reminders: true } })
  const creditNote = await prisma.creditNote.create({ data: {
    organizationId, invoiceId: invoice.id, contactId: contact.id, number: `CN-${run}`, reason: "Error", ...money, currency: "DKK",
    countryCode: "DK", locale: "da-DK", timezone: "Europe/Copenhagen", taxRegime: "dk_moms", items: { create: line },
  }, include: { items: true } })
  const rebill = await prisma.deliverableRebill.create({ data: {
    agreementId: agreement.id, deliverableId: deliverable.id, generation: 1, priorInvoiceId: invoice.id,
    priorInvoiceItemId: invoice.items[0]!.id, creditNoteId: creditNote.id, reason: "Redo", decidedBy: userId, commandId: actor.commandId,
  } })
  const receipt = await prisma.settlementReceipt.create({ data: {
    organizationId, contactId: contact.id, currency: "DKK", grossAmount: 125, netAmount: 125, feeAmount: 0, paidAt: now,
    method: "bank", reference: `R-${run}`, reason: "Paid", evidence: "Statement", ...actor,
  } })
  const settlementRefund = await prisma.settlementRefund.create({ data: { receiptId: receipt.id, amount: 1, reason: "Fee", evidence: "Statement", ...actor } })
  const payment = await prisma.payment.create({ data: { organizationId, invoiceId: invoice.id, amount: 125, currency: "DKK", paidAt: now, method: "bank", source: "manual", receiptId: receipt.id, receiptAmount: 125, allocationReason: "Paid", allocationEvidence: "Statement" } })
  const paymentRefund = await prisma.paymentRefund.create({ data: { organizationId, invoiceId: invoice.id, amount: 1, currency: "DKK", refundedAt: now, ...actor } })
  const event = await prisma.domainEvent.create({ data: { organizationId, sequence: 1, aggregateType: "invoice", aggregateId: invoice.id, type: "invoice.issued", payload: {}, actorKind: "user" } })
  const receiptRow = await prisma.commandReceipt.create({ data: { organizationId, actorKey: actor.actorKey, clientRequestId: run, commandType: "invoice.issue", status: "done" } })
  const agentKey = await prisma.agentKey.create({ data: { organizationId, name: "Agent", secretHash: `hash-${run}`, displayPrefix: "quits_ak", createdByUserId: userId } })
  const approval = await prisma.approvalRequest.create({ data: { organizationId, agentKeyId: agentKey.id, commandReceiptId: receiptRow.id, commandType: "invoice.issue", command: {}, summary: "Issue", expiresAt: now } })
  const job = await prisma.job.create({ data: { organizationId, type: "bulk-send", payload: {}, steps: { create: { position: 0, label: "Send" } } }, include: { steps: true } })
  const staging = await prisma.artifactStaging.create({ data: {
    organizationId, documentKind: "invoice", documentId: invoice.id, renderInputHash: run, renderInput: {}, rendererVersion: "v1", leaseUntil: now,
    artifacts: { pdf: { ref: `${organizationId}/staged.pdf`, hash: "a", size: 1 } },
  } })
  const candidate = await prisma.issuanceCandidate.create({ data: {
    organizationId, documentKind: "invoice", documentId: invoice.id, stagingId: staging.id, renderInput: {}, renderInputHash: run, attemptAt: now,
    artifacts: { pdf: { ref: `${organizationId}/candidate.pdf`, hash: "a", size: 1 } },
  } })
  const link = await prisma.publicLinkAttempt.create({ data: { documentKind: "invoice", documentId: invoice.id, scope: "view", keyVersion: 1, revision: 1 } })
  const preference = await prisma.recipientReminderPreference.create({ data: { organizationId, recipient: "buyer@test.quits.invalid", locale: "da" } })
  await prisma.accountingConnection.create({ data: { organizationId, provider: "economic", remoteAccountId: run, mappingRevision: "1" } })
  await prisma.vatPeriodEntry.create({ data: { organizationId, from: "2026-01-01", to: "2026-03-31", updatedBy: userId } })
  await prisma.schedulerScan.create({ data: { task: "reminders", organizationId } })
  await prisma.eventConsumerCursor.create({ data: { organizationId, consumerKey: "ledger" } })
  await prisma.eventConsumerDelivery.create({ data: { organizationId, consumerKey: "ledger", sequence: 1 } })
  await prisma.organizationCvrVerification.create({ data: { organizationId, cvr: "87654321", status: "verified" } })

  const byOrganization = { column: "organizationId", values: [organizationId] }
  const byId = (...rows: Array<{ id: string }>) => ({ column: "id", values: rows.map(({ id }) => id) })
  const seeded: Seeded = new Map(Object.entries({
    organization: { column: "id", values: [organizationId] }, user: { column: "id", values: [userId] },
    session: byId(session), account: byId(account), member: byId(member, sharedMember), invitation: byId(invitation),
    org_settings: byId(settings), contact: byId(contact), contact_tax_id: byId(contactTaxId), learned_default_clear: byId(learned),
    catalog_item: byId(catalog), organization_tax_id: byId(taxId), agreement_template: byId(template), quote: byId(quote),
    quote_item: byId(...quote.items), agreement: byId(agreement), deliverable: byId(deliverable), recurring_invoice: byId(recurring),
    invoice: byId(invoice), invoice_item: byId(...invoice.items), invoice_reminder: byId(...invoice.reminders),
    credit_note: byId(creditNote), credit_note_item: byId(...creditNote.items), deliverable_rebill: byId(rebill),
    settlement_receipt: byId(receipt), settlement_refund: byId(settlementRefund), payment: byId(payment),
    payment_refund: byId(paymentRefund), domain_event: byId(event), command_receipt: byId(receiptRow), agent_key: byId(agentKey),
    approval_request: byId(approval), job: byId(job), job_step: byId(...job.steps), artifact_staging: byId(staging),
    issuance_candidate: byId(candidate), public_link_attempt: byId(link), recipient_reminder_preference: byId(preference),
    accounting_connection: byOrganization, vat_period_entry: byOrganization, scheduler_scan: byOrganization,
    event_consumer_cursor: byOrganization, event_consumer_delivery: byOrganization, organization_cvr_verification: byOrganization,
  }))
  const refs = [ref(invoiceId, "pdf"), ref(invoiceId, "xml"), `${organizationId}/staged.pdf`, `${organizationId}/candidate.pdf`]
  return { organizationId, userId, sessionId: session.id, seeded, refs }
}

function memoryStore(refs: string[]) {
  const objects = new Set(refs)
  const store: DocumentArtifactStore = {
    async put(_bytes: Uint8Array, meta: ArtifactMeta) { return meta.documentId },
    async get() { return null },
    async head() { return null },
    async delete(ref: string) { objects.delete(ref) },
  }
  return { store, objects }
}

async function rows(table: string, { column, values }: { column: string; values: string[] }) {
  return prisma.$queryRawUnsafe<Array<{ row: unknown }>>(
    `SELECT to_jsonb(t) AS row FROM "${table}" t WHERE "${column}" = ANY($1) ORDER BY to_jsonb(t)::text`, values)
}

describe.skipIf(!hasTestDatabase)("purgeOrganization", () => {
  const created: string[] = []
  const users: string[] = []
  afterAll(async () => {
    await cleanupTestOrganizations({ where: { id: { in: created } } })
    await prisma.user.deleteMany({ where: { id: { in: users } } })
  })

  it("deletes every row and file of one organization and nothing of another", async () => {
    const sharedId = `purge-shared-${randomUUID().slice(0, 8)}`
    const now = new Date()
    await prisma.user.create({ data: { id: sharedId, name: "Shared", email: `${sharedId}@test.quits.invalid`, emailVerified: true, createdAt: now, updatedAt: now } })
    const sharedSession = await prisma.session.create({ data: { id: `${sharedId}-s`, token: `${sharedId}-t`, userId: sharedId, expiresAt: now, createdAt: now, updatedAt: now } })
    users.push(sharedId)
    const target = await seedOrganization(sharedId)
    const other = await seedOrganization(sharedId)
    created.push(target.organizationId, other.organizationId)
    users.push(target.userId, other.userId)
    await prisma.session.update({ where: { id: sharedSession.id }, data: { activeOrganizationId: target.organizationId } })

    const tables = await prisma.$queryRaw<Array<{ table_name: string }>>`
      SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'`
    const unknown = tables.map(({ table_name }) => table_name)
      .filter(table => !target.seeded.has(table) && !NOT_ORGANIZATION_OWNED.has(table))
    expect(unknown, "seed new tables in this test or list them as not organization-owned").toEqual([])

    const before = new Map<string, unknown>()
    for (const [table, key] of other.seeded) before.set(table, await rows(table, key))
    const { store, objects } = memoryStore([...target.refs, ...other.refs])

    await expect(purgeOrganization(target.organizationId, { artifactStore: store }))
      .resolves.toEqual({ purged: true, artifacts: target.refs.length, users: 1 })

    for (const [table, key] of target.seeded) expect(await rows(table, key), table).toEqual([])
    for (const [table, key] of other.seeded) expect(await rows(table, key), table).toEqual(before.get(table))
    expect([...objects].sort()).toEqual([...other.refs].sort())
    // A user who also belongs to another organization keeps the account and the other membership.
    await expect(prisma.user.count({ where: { id: sharedId } })).resolves.toBe(1)
    await expect(prisma.session.findUnique({ where: { id: sharedSession.id } })).resolves.toMatchObject({ activeOrganizationId: null })

    await expect(purgeOrganization(target.organizationId, { artifactStore: store }))
      .resolves.toEqual({ purged: false, artifacts: 0, users: 0 })
  })

  it("refuses to drop rows that point at files when no artifact store is configured", async () => {
    const sharedId = `purge-shared-${randomUUID().slice(0, 8)}`
    const now = new Date()
    await prisma.user.create({ data: { id: sharedId, name: "Shared", email: `${sharedId}@test.quits.invalid`, emailVerified: true, createdAt: now, updatedAt: now } })
    users.push(sharedId)
    const target = await seedOrganization(sharedId)
    created.push(target.organizationId)
    users.push(target.userId)

    await expect(purgeOrganization(target.organizationId, { artifactStore: null })).rejects.toThrow("artifact store")
    await expect(prisma.organization.count({ where: { id: target.organizationId } })).resolves.toBe(1)
  })
})
