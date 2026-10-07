import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
vi.mock("../../../lib/email", async () => ({ ...await vi.importActual<typeof import("../../../lib/email")>("../../../lib/email"), deliver: vi.fn() }))
import { prisma } from "../../../lib/db"
import { deliver, EmailSendError } from "../../../lib/email"
import { createTestOrganization, hasTestDatabase } from "../../../test-utils/organization"
import type { AnyCommandDefinition } from "../../command"
import { executeCommand, type CommandOutcome } from "../../execute"
import { issueDocument } from "../../../application/issuance"
import { createAgreementDraft, updateDeliverable } from "../../commands/agreements"
import { issueAgreement, recordAgreementAcceptance, revokeAgreementLinks } from "../../commands/agreement-lifecycle"
import { markDeliverableDelivered } from "../../commands/deliverables"
import { publicAcceptDeliverable, publicRequestDeliverableChanges } from "../../commands/public-deliverables"
import { createInvoiceFromDeliverables } from "../../commands/invoices-from-deliverables"
import { getAgreement } from "../queries"
import { decidePublicAgreementByToken, decidePublicDeliverableByToken, loadPublicAgreementByToken } from "../../../lib/agreements/public-access"
import { mintAgreementLink, mintDeliverableSignOffLink, getAgreementPublicSecret, signAgreementPublicToken, verifyAgreementPublicToken } from "../../../lib/agreements/tokens"
import { publicAgreementPdf } from "../../../lib/agreements/pdf-access"
import { publicDeliverableDto } from "../../../lib/agreements/public"
import { findEmailDeliveryJobs, retryEmailDeliveries } from "../../../test-utils/email-outbox"
import { authenticateAgentSecret, createAgentKey } from "../../agent-keys"
import { decideApproval } from "../../approvals"
import { getCommandDefinition } from "../../registry"
import { agreementTools } from "../../agent-tools/tools/agreements"
import { getAgentTool } from "../../agent-tools/registry"

const cleanups: Array<() => Promise<void>> = []
const now = new Date()
function completed<T>(outcome: CommandOutcome<T>): T {
  expect(outcome.status, JSON.stringify(outcome)).toBe("completed")
  if (outcome.status !== "completed") throw new Error(JSON.stringify(outcome))
  return outcome.result
}
beforeEach(() => {
  vi.stubEnv("RESEND_API_KEY", "synthetic-sign-off")
  vi.stubEnv("FROM_EMAIL", "billing@example.test")
  vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-0123456789abcdef0123456789abcdef")
  vi.mocked(deliver).mockReset().mockResolvedValue({ id: "synthetic" })
})
afterEach(async () => { while (cleanups.length) await cleanups.pop()?.(); vi.unstubAllEnvs(); vi.restoreAllMocks() })
async function setup(count = 1, recipient: string | null = "customer@example.test") {
  const org = await createTestOrganization(); cleanups.push(org.cleanup)
  const actor = org.actors.admin
  const contact = await prisma.contact.create({ data: { organizationId: org.organizationId, name: "Customer", email: "customer@example.test" } })
  const agreement = completed(await executeCommand(createAgreementDraft, {
    title: "Work", contactId: contact.id, validUntil: "2099-01-01", billingTrigger: "on_delivery",
    deliverables: Array.from({ length: count }, (_, i) => ({ title: `Work ${i}`, description: "Agreed work", quantity: "1", unitPrice: "100" })),
  }, { actor, now }))
  completed(await executeCommand(issueAgreement, { id: agreement.id, ...(recipient ? { recipient } : {}) }, { actor, now }))
  completed(await executeCommand(recordAgreementAcceptance, { id: agreement.id, acceptedByName: "Customer", evidenceNote: "Written confirmation" }, { actor, now }))
  const get = () => getAgreement(org.organizationId, agreement.id)
  const input = { agreementId: agreement.id, id: agreement.deliverables[0]!.id }
  const delivery = completed(await executeCommand(markDeliverableDelivered, input, { actor, now }))
  return { org, actor, agreement, get, input, token: delivery.signOffLink.token, line: () => prisma.deliverable.findUniqueOrThrow({ where: { id: input.id } }) }
}
const accept = { decision: "accept", confirmed: true }
const changes = { decision: "request_changes", note: "  Please revise the heading  " }

describe.runIf(hasTestDatabase)("customer delivery sign-off", () => {
  it("notifies the frozen recipient; accepts a revision; replay at expiry preserves evidence and emits/emails once", async () => {
    const ctx = await setup()
    expect(verifyAgreementPublicToken(ctx.token, getAgreementPublicSecret())).toMatchObject({ scope: "sign_off", deliveryRevision: 1, exp: new Date(now.getTime() + 90 * 86400_000).toISOString() })
    const initialJobs = await findEmailDeliveryJobs(ctx.org.organizationId)
    expect(initialJobs.at(-1)?.payload).toMatchObject({ message: { to: "customer@example.test" }, completion: { kind: "agreement.notification" } })
    expect(await loadPublicAgreementByToken(ctx.token, undefined, now)).not.toBeNull()
    await decidePublicDeliverableByToken(ctx.token, accept, now)
    expect(await ctx.line()).toMatchObject({ status: "accepted", acceptedRevision: 1, acceptedVia: "customer_link", acceptedAt: now })
    const before = await ctx.line()
    const events = await prisma.domainEvent.count({ where: { organizationId: ctx.org.organizationId } })
    const jobs = await prisma.job.count({ where: { organizationId: ctx.org.organizationId } })
    await decidePublicDeliverableByToken(ctx.token, accept, new Date(now.getTime() + 91 * 86400_000))
    expect(await ctx.line()).toEqual(before)
    expect(await prisma.domainEvent.count({ where: { organizationId: ctx.org.organizationId } })).toBe(events)
    expect(await prisma.job.count({ where: { organizationId: ctx.org.organizationId } })).toBe(jobs)
    await expect(decidePublicDeliverableByToken(ctx.token, changes, now)).rejects.toMatchObject({ code: "already_decided" })
    expect(await loadPublicAgreementByToken(ctx.token, undefined, new Date(now.getTime() + 91 * 86400_000))).toBeNull()
    const signoffJobs = (await findEmailDeliveryJobs(ctx.org.organizationId)).filter(job => JSON.stringify(job.payload).includes(`-signoff-1`))
    expect(signoffJobs).toHaveLength(1)
    expect(signoffJobs[0]?.payload).toMatchObject({ message: { to: (await prisma.orgSettings.findUniqueOrThrow({ where: { organizationId: ctx.org.organizationId } })).companyEmail } })
  })
  it("refuses stale delivery revisions and stale keys, including replay", async () => {
    const ctx = await setup()
    await decidePublicDeliverableByToken(ctx.token, changes, now)
    const originalNote = (await ctx.line()).changeRequestNote
    await decidePublicDeliverableByToken(ctx.token, { decision: "request_changes", note: "Ignore this replay note" }, new Date(now.getTime() + 91 * 86400_000))
    expect((await ctx.line()).changeRequestNote).toBe(originalNote)
    const delivered = completed(await executeCommand(markDeliverableDelivered, ctx.input, { actor: ctx.actor, now }))
    expect(delivered).toMatchObject({ deliveryRevision: 2, changeRequestNote: null })
    await expect(decidePublicDeliverableByToken(ctx.token, accept, now)).rejects.toMatchObject({ code: "invalid" })
    expect(await loadPublicAgreementByToken(ctx.token, undefined, now)).toBeNull()
    completed(await executeCommand(revokeAgreementLinks, { id: ctx.agreement.id }, { actor: ctx.actor, now }))
    await expect(decidePublicDeliverableByToken(delivered.signOffLink.token, accept, now)).rejects.toMatchObject({ code: "invalid" })
    expect(await loadPublicAgreementByToken(delivered.signOffLink.token, undefined, now)).toBeNull()
  })
  for (const status of ["draft", "sent", "completed", "cancelled", "declined", "expired"]) it(`refuses sign-off on a ${status} agreement`, async () => {
    const ctx = await setup()
    await prisma.agreement.update({ where: { id: ctx.agreement.id }, data: { status } })
    await expect(decidePublicDeliverableByToken(ctx.token, changes, now)).rejects.toMatchObject({ code: "not_accepted" })
    await expect(decidePublicDeliverableByToken(ctx.token, accept, now)).rejects.toMatchObject({ code: "not_accepted" })
    expect(await loadPublicAgreementByToken(ctx.token, undefined, now)).toBeNull()
    expect((await ctx.line()).status).toBe("delivered")
  })
  it("allows changes while reserved, flags the draft, refuses send until acknowledged and exposes the note to agents", async () => {
    const ctx = await setup()
    const drafts = completed(await executeCommand(createInvoiceFromDeliverables, { agreementId: ctx.agreement.id, deliverableIds: [ctx.input.id] }, { actor: ctx.actor, now }))
    const id = drafts.saleInvoiceId!
    await decidePublicDeliverableByToken(ctx.token, changes, now)
    expect(await ctx.line()).toMatchObject({ status: "changes_requested", billingStatus: "reserved", changeRequestNote: "Please revise the heading" })
    expect(await prisma.invoice.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "draft", disputed: true, disputedRevision: 1 })
    expect(await issueDocument({ kind: "invoice", commandInput: { id }, actor: ctx.actor })).toMatchObject({ status: "failed", error: { code: "disputed_deliverables" } })
    const agent = await authenticateAgentSecret((await createAgentKey(ctx.actor, { name: "Helper", mode: "full_access", scopes: ["deliverable:read", "invoice:read", "invoice:send"] })).secret)
    expect(await agreementTools.find(tool => tool.name === "deliverable_list")!.run({ actor: agent }, { agreementId: ctx.agreement.id })).toEqual(expect.arrayContaining([expect.objectContaining({ status: "changes_requested", changeRequestNote: "Please revise the heading" })]))
    expect(await getAgentTool(agent, "invoice_get")!.run({ actor: agent }, { id })).toMatchObject({ disputed: true })
    expect(await getAgentTool(agent, "invoice_send")!.run({ actor: agent }, { id, clientRequestId: "refused" })).toMatchObject({ status: "failed", error: { code: "disputed_deliverables" } })
    expect(await getAgentTool(agent, "invoice_send")!.run({ actor: agent }, { id, acknowledgeDisputed: true, clientRequestId: "acknowledged" })).toMatchObject({ status: "completed" })
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id } })).status).toBe("sent")
    expect(await prisma.domainEvent.findFirst({ where: { aggregateId: id, type: "invoice.dispute_acknowledged" } })).toMatchObject({ schemaVersion: 1, payload: { acknowledgeDisputed: true, disputedRevision: 1 } })
  })
  it("limits submissions by verified identity, counts concurrent and refused submissions, and separates eleven targets", async () => {
    const ctx = await setup(11)
    for (const line of (await ctx.get()).deliverables.slice(1)) completed(await executeCommand(markDeliverableDelivered, { agreementId: ctx.agreement.id, id: line.id }, { actor: ctx.actor, now }))
    for (const line of (await ctx.get()).deliverables) {
      const token = mintDeliverableSignOffLink(await ctx.get(), line).token
      await decidePublicDeliverableByToken(token, accept, now)
    }
    const signed = verifyAgreementPublicToken(ctx.token, getAgreementPublicSecret())!
    const alternate = signAgreementPublicToken({ ...signed, exp: new Date(now.getTime() + 100 * 86400_000).toISOString() }, getAgreementPublicSecret())
    const replies = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => decidePublicDeliverableByToken(i % 2 ? alternate : ctx.token, accept, now)))
    expect(replies.filter(result => result.status === "fulfilled")).toHaveLength(9)
    expect(replies.filter(result => result.status === "rejected")).toHaveLength(1)
    expect(await prisma.publicLinkAttempt.count({ where: { documentId: ctx.agreement.id, targetId: ctx.input.id } })).toBe(11)
    await expect(decidePublicDeliverableByToken(ctx.token, { decision: "request_changes", note: "" }, now)).rejects.toMatchObject({ code: "retry_later" })
  })
  it("requires confirmation or a nonempty note; refuses wrong scope, malformed framing, wrong actors and cross-org calls", async () => {
    const ctx = await setup()
    for (const decision of [{ decision: "accept" }, { decision: "accept", confirmed: false }, { decision: "request_changes", note: "   " }]) await expect(decidePublicDeliverableByToken(ctx.token, decision, now)).rejects.toThrow()
    expect((await publicAgreementPdf(ctx.token)).status).toBe(404)
    const readToken = mintAgreementLink(await ctx.get(), "read", now).token
    await expect(decidePublicDeliverableByToken(readToken, accept, now)).rejects.toMatchObject({ code: "invalid" })
    await expect(decidePublicAgreementByToken(ctx.token, { decision: "accept", acceptedByName: "Wrong scope", confirmed: true }, {}, now)).rejects.toMatchObject({ code: "invalid" })
    await expect(decidePublicDeliverableByToken(`${ctx.token}.suffix`, accept, now)).rejects.toMatchObject({ code: "invalid" })
    for (const command of [publicAcceptDeliverable, publicRequestDeliverableChanges] as AnyCommandDefinition[]) {
      expect(getCommandDefinition(command.type)).toBeUndefined()
      expect(agreementTools.some(tool => tool.commandType === command.type)).toBe(false)
      expect(await executeCommand(command, { token: ctx.token, ...(command === publicAcceptDeliverable ? { confirmed: true } : { note: "Please revise" }) }, { actor: ctx.actor, now })).toMatchObject({ status: "failed", error: { tag: "Forbidden" } })
    }
    const other = await createTestOrganization(); cleanups.push(other.cleanup)
    expect(await executeCommand(publicAcceptDeliverable, { token: ctx.token, confirmed: true }, { actor: { kind: "system", reason: "customer_link", organizationId: other.organizationId, label: "Customer" }, now })).toMatchObject({ status: "failed", error: { tag: "NotFound" } })
    expect(JSON.stringify(publicDeliverableDto(await ctx.get(), await ctx.line()))).not.toContain("acceptanceEvidenceNote")
  })
  it("serializes opposite concurrent decisions with one event and notification", async () => {
    const ctx = await setup()
    const results = await Promise.allSettled([decidePublicDeliverableByToken(ctx.token, accept, now), decidePublicDeliverableByToken(ctx.token, changes, now)])
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1)
    expect(await prisma.domainEvent.count({ where: { aggregateId: ctx.agreement.id, type: { in: ["deliverable.accepted", "deliverable.changes_requested"] } } })).toBe(1)
    expect((await findEmailDeliveryJobs(ctx.org.organizationId)).filter(job => JSON.stringify(job.payload).includes("-signoff-1"))).toHaveLength(1)
  })
  it("refuses a delivery approval after its notification recipient or key changes", async () => {
    const ctx = await setup()
    completed(await executeCommand(updateDeliverable, { ...ctx.input, status: "in_progress" }, { actor: ctx.actor, now }))
    const agent = await authenticateAgentSecret((await createAgentKey(ctx.actor, { name: "Worker", mode: "approval_required", scopes: ["deliverable:deliver"] })).secret)
    const queued = await executeCommand(markDeliverableDelivered, ctx.input, { actor: agent, clientRequestId: "delivery-approval", now })
    expect(queued.status).toBe("awaiting_approval")
    if (queued.status !== "awaiting_approval") throw new Error(JSON.stringify(queued))
    expect((await prisma.approvalRequest.findUniqueOrThrow({ where: { id: queued.approvalRequestId } })).reviewContext).toMatchObject({ details: { recipient: "customer@example.test" } })
    await prisma.agreement.update({ where: { id: ctx.agreement.id }, data: { issuedToEmail: "changed@example.test" } })
    expect(await decideApproval({ approvalRequestId: queued.approvalRequestId, decider: ctx.actor, decision: "approve" })).toMatchObject({ status: "failed", error: { code: "changed_since_review" } })
  })
  it("notification rejection and unconfirmed completion never undo delivery or sign-off; recovery reuses its message", async () => {
    const ctx = await setup()
    const markers = await ctx.get()
    vi.mocked(deliver).mockRejectedValue(new EmailSendError("provider_rejected", "Provider refused"))
    await decidePublicDeliverableByToken(ctx.token, changes, now)
    expect((await ctx.line()).status).toBe("changes_requested")
    const after = await ctx.get()
    expect(after.lastEmailAttemptOutcome).toBe(markers.lastEmailAttemptOutcome)
    const jobs = await findEmailDeliveryJobs(ctx.org.organizationId)
    expect(jobs.at(-1)?.result).toMatchObject({ outcome: "rejected" })
    vi.mocked(deliver).mockResolvedValue({ id: "recovered" })
    await retryEmailDeliveries(ctx.org.organizationId)
    expect((await ctx.line()).status).toBe("changes_requested")
    vi.mocked(deliver).mockRejectedValue(new Error("Unknown provider outcome"))
    completed(await executeCommand(markDeliverableDelivered, ctx.input, { actor: ctx.actor, now }))
    expect((await ctx.line()).status).toBe("delivered")
    for (let attempt = 0; attempt < 3; attempt++) await retryEmailDeliveries(ctx.org.organizationId)
    expect((await findEmailDeliveryJobs(ctx.org.organizationId)).at(-1)?.result).toMatchObject({ outcome: "unconfirmed" })
  })

  it("refuses an acknowledged invoice approval after another delivery is disputed", async () => {
    const ctx = await setup()
    const drafts = completed(await executeCommand(createInvoiceFromDeliverables, { agreementId: ctx.agreement.id, deliverableIds: [ctx.input.id] }, { actor: ctx.actor, now }))
    const id = drafts.saleInvoiceId!
    await decidePublicDeliverableByToken(ctx.token, changes, now)
    const agent = await authenticateAgentSecret((await createAgentKey(ctx.actor, { name: "Billing", mode: "approval_required", scopes: ["invoice:send"] })).secret)
    const queued = await getAgentTool(agent, "invoice_send").run({ actor: agent }, { id, acknowledgeDisputed: true, clientRequestId: "ack-approval" }) as { status: string; approvalRequestId: string }
    expect(queued.status).toBe("awaiting_approval")
    expect((await prisma.approvalRequest.findUniqueOrThrow({ where: { id: queued.approvalRequestId } })).reviewContext).toMatchObject({ details: { disputed: "true", acknowledgeDisputed: "true" } })
    const delivered = completed(await executeCommand(markDeliverableDelivered, ctx.input, { actor: ctx.actor, now }))
    await decidePublicDeliverableByToken(delivered.signOffLink.token, changes, now)
    expect(await decideApproval({ approvalRequestId: queued.approvalRequestId, decider: ctx.actor, decision: "approve" })).toMatchObject({ status: "failed", error: { code: "changed_since_review" } })
    expect(await prisma.invoice.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "draft", disputedRevision: 2 })
  })
  it("records customer changes even while the reserved invoice email is in flight", async () => {
    const ctx = await setup()
    const drafts = completed(await executeCommand(createInvoiceFromDeliverables, { agreementId: ctx.agreement.id, deliverableIds: [ctx.input.id] }, { actor: ctx.actor, now }))
    const id = drafts.saleInvoiceId!
    let settle!: (value: { id: string }) => void
    const provider = new Promise<{ id: string }>(resolve => { settle = resolve })
    vi.mocked(deliver).mockImplementationOnce(() => provider)
    const sending = issueDocument({ kind: "invoice", commandInput: { id }, actor: ctx.actor })
    try {
      await vi.waitFor(async () => expect((await prisma.invoice.findUniqueOrThrow({ where: { id } })).lastEmailAttemptOutcome).toBe("sending"), { timeout: 10_000, interval: 25 })
      await decidePublicDeliverableByToken(ctx.token, changes, now)
      expect(await ctx.line()).toMatchObject({ status: "changes_requested", billingStatus: "reserved" })
      expect(await prisma.invoice.findUniqueOrThrow({ where: { id } })).toMatchObject({ disputed: true })
    } finally { settle({ id: "already-in-flight" }); await sending }
    expect(await ctx.line()).toMatchObject({ status: "changes_requested", billingStatus: "invoiced" })
  })
  it("keeps delivery and sign-off available without configured notifications", async () => {
    vi.stubEnv("RESEND_API_KEY", "")
    const ctx = await setup()
    await prisma.orgSettings.update({ where: { organizationId: ctx.org.organizationId }, data: { companyEmail: null } })
    expect((await findEmailDeliveryJobs(ctx.org.organizationId)).filter(job => JSON.stringify(job.payload).includes("-delivered-1"))).toHaveLength(0)
    const jobs = await prisma.job.count({ where: { organizationId: ctx.org.organizationId } })
    await decidePublicDeliverableByToken(ctx.token, accept, now)
    expect((await ctx.line()).status).toBe("accepted")
    expect(await prisma.job.count({ where: { organizationId: ctx.org.organizationId } })).toBe(jobs)
  })
  it("returns a manual link without emailing when there is no frozen recipient", async () => {
    const ctx = await setup(1, null)
    expect((await findEmailDeliveryJobs(ctx.org.organizationId)).filter(job => JSON.stringify(job.payload).includes("-delivered-1"))).toHaveLength(0)
    expect(await loadPublicAgreementByToken(ctx.token, undefined, now)).not.toBeNull()
    await decidePublicDeliverableByToken(ctx.token, accept, now)
    expect((await ctx.line()).status).toBe("accepted")
  })
})
