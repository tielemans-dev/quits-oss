import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
vi.mock("../../lib/email", async () => ({
  ...await vi.importActual<typeof import("../../lib/email")>("../../lib/email"), deliver: vi.fn(),
}))
import { prisma } from "../../lib/db"
import { deliver, EmailSendError } from "../../lib/email"
import { createTestOrganization, hasTestDatabase } from "../../test-utils/organization"
import { createInvoiceDraft, sendInvoice, updateInvoiceDraft } from "../../domain/commands/invoices"
import { createAgreementDraft } from "../../domain/commands/agreements"
import { executeCommand } from "../../domain/execute"
import { createAgentKey, authenticateAgentSecret } from "../../domain/agent-keys"
import { decideApproval, recoverInterruptedApprovals } from "../../domain/approvals"
import { sweepOrganizationArtifacts, runArtifactSweep, RETIRED_ARTIFACT_RETENTION_MS } from "../../domain/features/artifact-sweep"
import { settleAbandonedDeliveries } from "../../domain/delivery/outbox"
import { setRuntimeServices, resetRuntimeServices, type ArtifactMeta, type DocumentArtifactStore } from "../../lib/runtime/services"
import { setRuntimeExtensions } from "../../lib/runtime/extensions"
import { issueDocument, reserveDocument, prepareDocument } from "../issuance"
import { hashBytes, type RenderInput } from "../../domain/documents/render-input"
import { bootstrapQuitsRuntime } from "../../lib/runtime/bootstrap"
import { createRecurringInvoice, runRecurringInvoiceNow } from "../../domain/commands/recurring"
import { runOrganizationJobs } from "../../domain/scheduler"
import { documentPdf } from "../../lib/documents/pdf-access"

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
  vi.stubEnv("RESEND_API_KEY", "synthetic-a3a")
  vi.stubEnv("FROM_EMAIL", "billing@example.test")
  vi.stubEnv("BETTER_AUTH_SECRET", "synthetic-a3a-secret-over-thirty-two-characters")
  vi.mocked(deliver).mockReset().mockResolvedValue({ id: "synthetic-delivery" })
  render.mockClear(); bytes.clear(); meta.clear()
  setRuntimeServices({ documentRenderer: { version: "test-v1", renderPdf: render }, documentArtifactStore: store })
})
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.()
  resetRuntimeServices(); setRuntimeExtensions([]); vi.unstubAllEnvs()
})
async function setup() {
  const org = await createTestOrganization()
  cleanups.push(org.cleanup)
  const contact = await prisma.contact.create({ data: { organizationId: org.organizationId, name: "Customer", email: "customer@example.test" } })
  const draft = await executeCommand(createInvoiceDraft, { contactId: contact.id, dueDate: "2099-01-01", taxRate: 0,
    items: [{ description: "Work", quantity: 1, unitPrice: 100 }] }, { actor: org.actors.admin })
  if (draft.status !== "completed") throw new Error(JSON.stringify(draft))
  const args = { kind: "invoice" as const, commandInput: { id: draft.result.id }, actor: org.actors.admin, clientRequestId: "first" }
  return { org, contact, invoice: draft.result, args }
}
async function prepare(args: Parameters<typeof reserveDocument>[0]) {
  const reservation = await reserveDocument(args)
  return prepareDocument(reservation.id)
}
const expire = (id: string) => prisma.artifactStaging.update({ where: { id }, data: { leaseUntil: new Date(Date.now() - 1) } })
const candidates = (organizationId: string) => prisma.issuanceCandidate.findMany({ where: { organizationId }, orderBy: { createdAt: "asc" } })
const voids = (organizationId: string) => prisma.domainEvent.findMany({ where: { organizationId, type: "document.number_voided" } })
const afterRetention = () => new Date(Date.now() + RETIRED_ARTIFACT_RETENTION_MS + 1000)

;(hasTestDatabase ? describe : describe.skip)("issuance artifact protocol", () => {
  it("crash after put retries the immutable write and reuses the reservation", async () => {
    const { args, org } = await setup()
    let crash = true
    setRuntimeServices({ documentArtifactStore: { ...store, async put(value, metadata) {
      const ref = await store.put(value, metadata)
      if (crash) { crash = false; throw new Error("crash after put") }
      return ref
    } } })
    await expect(issueDocument(args)).rejects.toThrow("crash after put")
    const reserved = await prisma.artifactStaging.findFirstOrThrow({ where: { organizationId: org.organizationId } })
    expect(reserved).toMatchObject({ status: "reserved", prepToken: null })
    expect(bytes.size).toBe(1)
    expect(await issueDocument(args)).toMatchObject({ status: "completed" })
    expect(await prisma.artifactStaging.count({ where: { organizationId: org.organizationId } })).toBe(1)
    expect(bytes.size).toBe(1)
    expect((await candidates(org.organizationId))[0]).toMatchObject({ stagingId: reserved.id, status: "published" })
  })
  it("lease expiry before commit refuses issuance and leaves staging for sweep", async () => {
    const { args, invoice, org } = await setup()
    const staging = await prepare(args); await expire(staging.id)
    expect(await executeCommand(sendInvoice, args.commandInput, { actor: args.actor, clientRequestId: "first", issuanceStagingId: staging.id }))
      .toMatchObject({ status: "failed", error: { code: "reservation_expired" } })
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).status).toBe("draft")
    expect(await candidates(org.organizationId)).toEqual([])
    expect((await prisma.artifactStaging.findUniqueOrThrow({ where: { id: staging.id } })).status).toBe("stored")
  })
  it("concurrent preparation renders once and both callers get the same refs", async () => {
    const { args } = await setup()
    const staging = await reserveDocument(args)
    const [a, b] = await Promise.all([prepareDocument(staging.id), prepareDocument(staging.id)])
    expect(render).toHaveBeenCalledTimes(1)
    expect(a.artifacts).toEqual(b.artifacts)
    expect(a.status).toBe("stored")
  })
  it("a concurrent edit between reserve and commit fails with document_changed", async () => {
    const { args, invoice, org } = await setup()
    const staging = await prepare(args)
    await prisma.invoice.update({ where: { id: invoice.id }, data: { notes: "Changed after reservation" } })
    expect(await executeCommand(sendInvoice, args.commandInput, { actor: args.actor, clientRequestId: "first", issuanceStagingId: staging.id }))
      .toMatchObject({ status: "failed", error: { code: "document_changed" } })
    expect(await candidates(org.organizationId)).toEqual([])
    expect((await prisma.artifactStaging.findUniqueOrThrow({ where: { id: staging.id } })).status).toBe("stored")
  })
  it("rejection then unchanged retry then sweep keeps the shared published bytes", async () => {
    const { args, org } = await setup()
    vi.mocked(deliver).mockRejectedValueOnce(new EmailSendError("validation_error", "refused"))
    await issueDocument(args)
    const first = (await candidates(org.organizationId))[0]
    expect(first.status).toBe("retired")
    await issueDocument({ ...args, clientRequestId: "retry" })
    const second = (await candidates(org.organizationId))[1]
    expect(second.status).toBe("published")
    expect(second.stagingId).toBe(first.stagingId)
    expect(second.artifacts).toEqual(first.artifacts)
    expect(render).toHaveBeenCalledTimes(1)
    await sweepOrganizationArtifacts(org.organizationId, afterRetention())
    expect(bytes.size).toBe(1)
    expect(await voids(org.organizationId)).toEqual([])
  })
  it("rejection then edited retry retains old bytes for seven days and sweeps only the old bytes", async () => {
    const { args, org, invoice } = await setup()
    vi.mocked(deliver).mockRejectedValueOnce(new EmailSendError("validation_error", "refused"))
    await issueDocument(args)
    await prisma.invoice.update({ where: { id: invoice.id }, data: { notes: "Edited retry" } })
    await issueDocument({ ...args, clientRequestId: "edited" })
    const [a, b] = await candidates(org.organizationId)
    expect(a.stagingId).not.toBe(b.stagingId)
    expect(bytes.size).toBe(2)
    await sweepOrganizationArtifacts(org.organizationId)
    expect(bytes.size).toBe(2)
    await sweepOrganizationArtifacts(org.organizationId, afterRetention())
    expect(bytes.size).toBe(1)
    expect(await documentPdf("invoice", invoice.id, org.organizationId)).toMatchObject({ status: 200 })
  })
  it("approval execution refuses a changed stored snapshot and never prepares while awaiting approval", async () => {
    const { org, contact } = await setup()
    const draft = await executeCommand(createAgreementDraft, { contactId: contact.id, title: "Reviewed A", termsMarkdown: "Terms A",
      validUntil: "2099-01-01", deliverables: [{ title: "Work", quantity: 1, unitPrice: 100 }] }, { actor: org.actors.admin })
    if (draft.status !== "completed") throw new Error("agreement setup failed")
    const key = await createAgentKey(org.actors.admin, { name: "Agent", mode: "approval_required", scopes: ["agreement:send"] })
    const agent = await authenticateAgentSecret(key.secret)
    const queued = await issueDocument({ kind: "agreement", commandInput: { id: draft.result.id }, actor: agent,
      clientRequestId: "approval", options: { method: "manual" } })
    expect(render).not.toHaveBeenCalled()
    expect(await prisma.artifactStaging.count({ where: { organizationId: org.organizationId } })).toBe(0)
    if (queued.status !== "awaiting_approval") throw new Error("approval not queued")
    await prisma.agreement.update({ where: { id: draft.result.id }, data: { title: "Live B" } })
    expect(await decideApproval({ approvalRequestId: queued.approvalRequestId, decider: org.actors.admin, decision: "approve" }))
      .toMatchObject({ status: "failed", error: { code: "changed_since_review" } })
    expect(await candidates(org.organizationId)).toEqual([])
  })
  it("sweep voids an abandoned reservation that allocated a fresh credit-note number exactly once", async () => {
    const { args, org, invoice } = await setup()
    await issueDocument(args)
    const staging = await reserveDocument({ kind: "creditNote", commandInput: { invoiceId: invoice.id, mode: "full", reason: "Correction" },
      actor: args.actor, clientRequestId: "credit" })
    expect(staging.numberWasAllocated).toBe(true)
    await expire(staging.id)
    await sweepOrganizationArtifacts(org.organizationId)
    await sweepOrganizationArtifacts(org.organizationId)
    const events = await voids(org.organizationId)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ schemaVersion: 1, payload: { number: staging.reservedNumber, reservationId: staging.id, reason: "reservation_expired" } })
  })
  it("sweep never voids a reused invoice number", async () => {
    const { args, org } = await setup()
    const staging = await reserveDocument(args)
    expect(staging.numberWasAllocated).toBe(false)
    await expire(staging.id)
    await sweepOrganizationArtifacts(org.organizationId)
    expect(await voids(org.organizationId)).toEqual([])
  })
  it.each(["delivered", "unconfirmed"] as const)("delayed %s settlement after lease expiry publishes and never voids an unsettled candidate", async outcome => {
    const { args, org, invoice } = await setup()
    vi.mocked(deliver).mockRejectedValueOnce(new Error("provider result lost"))
    await issueDocument(args)
    const candidate = (await candidates(org.organizationId))[0]
    const staging = await expire(candidate.stagingId)
    const job = await prisma.job.findFirstOrThrow({ where: { organizationId: org.organizationId, type: "email.deliver" } })
    await prisma.job.update({ where: { id: job.id }, data: { status: "failed", claimToken: null, payload: {
      ...(job.payload as Record<string, any>), ...(outcome === "delivered" ? { providerMessageId: "provider-accepted" } : {}),
    } } })
    await sweepOrganizationArtifacts(org.organizationId, afterRetention())
    expect(await voids(org.organizationId)).toEqual([])
    expect((await prisma.artifactStaging.findUniqueOrThrow({ where: { id: staging.id } })).status).toBe("candidate_bound")
    expect(await settleAbandonedDeliveries({ organizationIds: [org.organizationId] })).toMatchObject({ settled: 1, failed: 0 })
    expect((await candidates(org.organizationId))[0].status).toBe("published")
    const document = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })
    expect(document.status).toBe("sent")
    expect(document.issueDate.toISOString()).toBe((staging.renderInput as unknown as RenderInput).issuedAt)
    expect(hashBytes(bytes.get(document.artifactPdfRef!)!)).toBe(document.artifactPdfHash)
    expect(render).toHaveBeenCalledTimes(1)
  })
  it("retrying the same client request id reuses id, number and timestamp, including concurrent reservations", async () => {
    const { args, org, invoice } = await setup()
    await issueDocument(args)
    const creditArgs = { kind: "creditNote" as const, commandInput: { invoiceId: invoice.id, mode: "full", reason: "Correction" },
      actor: args.actor, clientRequestId: "same-credit" }
    const [a, b] = await Promise.all([reserveDocument(creditArgs), reserveDocument(creditArgs)])
    expect(a.id).toBe(b.id); expect(a.documentId).toBe(b.documentId); expect(a.reservedNumber).toBe(b.reservedNumber)
    expect(a.renderInput).toEqual(b.renderInput)
    expect((await prisma.orgSettings.findUniqueOrThrow({ where: { organizationId: org.organizationId } })).creditNoteNextNum).toBe(2)
  })
  it("publishes artifact_missing without adapters and advertises optional artifacts", async () => {
    const { args, org } = await setup()
    resetRuntimeServices()
    expect(await issueDocument(args)).toMatchObject({ status: "completed" })
    const event = await prisma.domainEvent.findFirstOrThrow({ where: { organizationId: org.organizationId, type: "document.artifact_missing" } })
    expect(event).toMatchObject({ schemaVersion: 1, payload: { reason: "renderer_unavailable" } })
  })
  it("approval recovery uses the receipt request identity, approver and reviewed version", async () => {
    const { org, args } = await setup()
    const key = await createAgentKey(org.actors.admin, { name: "Recovery", mode: "approval_required", scopes: ["invoice:send"] })
    const agent = await authenticateAgentSecret(key.secret)
    const queued = await issueDocument({ ...args, actor: agent, clientRequestId: "recover-original" })
    if (queued.status !== "awaiting_approval") throw new Error("approval not queued")
    await prisma.approvalRequest.update({ where: { id: queued.approvalRequestId }, data: {
      status: "approved", decidedByUserId: org.actors.admin.userId, decidedAt: new Date(),
    } })
    await prisma.commandReceipt.update({ where: { id: queued.commandId }, data: { updatedAt: new Date(Date.now() - 3600_000) } })
    expect(await recoverInterruptedApprovals({ organizationIds: [org.organizationId] })).toMatchObject({ recovered: 1, failed: 0 })
    const staging = await prisma.artifactStaging.findFirstOrThrow({ where: { organizationId: org.organizationId } })
    expect(staging.requestKey).toBe(`${org.organizationId}:agent:${agent.agentKeyId}:recover-original`)
    const event = await prisma.domainEvent.findFirstOrThrow({ where: { organizationId: org.organizationId, type: "document.artifact_stored" } })
    expect(event).toMatchObject({ commandId: queued.commandId, approvedByUserId: org.actors.admin.userId })
  })
  it("preparation allows a real command to edit concurrently and commit detects it", async () => {
    const { args, invoice, org } = await setup()
    let entered!: () => void, finish!: () => void
    const rendering = new Promise<void>(resolve => { entered = resolve })
    const release = new Promise<void>(resolve => { finish = resolve })
    render.mockImplementationOnce(async input => {
      entered(); await release
      return new TextEncoder().encode(JSON.stringify(input))
    })
    const issuance = issueDocument(args)
    await rendering
    try {
      expect(await executeCommand(updateInvoiceDraft, { id: invoice.id, notes: "Concurrent edit" }, { actor: args.actor }))
        .toMatchObject({ status: "completed" })
    } finally { finish() }
    expect(await issuance).toMatchObject({ status: "failed", error: { code: "document_changed" } })
    expect(await candidates(org.organizationId)).toEqual([])
  })
  it("sweep progresses past 200 abandoned rows and restricts the scheduler to its organization", async () => {
    const { org, invoice } = await setup()
    await prisma.artifactStaging.createMany({ data: Array.from({ length: 205 }, (_, index) => ({
      organizationId: org.organizationId, documentKind: "invoice", documentId: invoice.id,
      requestKey: `sweep-${index}`, renderInputHash: `hash-${index}`, renderInput: {},
      rendererVersion: "test-v1", leaseUntil: new Date(Date.now() - 1000), reservedNumber: invoice.number,
    })) })
    expect(await sweepOrganizationArtifacts(org.organizationId)).toMatchObject({ abandoned: 200, more: 1 })
    expect(await runArtifactSweep(new Date(), { organizationIds: [org.organizationId] })).toMatchObject({
      organizations: 1, abandoned: 5, failed: 0,
    })
    expect(await runArtifactSweep(new Date(), { organizationIds: [org.organizationId] })).toMatchObject({ organizations: 0 })
    expect(await voids(org.organizationId)).toEqual([])
  })
  it("recurring auto-send uses the bootstrap dispatcher and publishes its candidate", async () => {
    const { org, contact } = await setup()
    bootstrapQuitsRuntime({})
    const schedule = await executeCommand(createRecurringInvoice, { name: "Recurring artifacts", contactId: contact.id,
      items: [{ description: "Retainer", quantity: 1, unitPrice: 100 }], taxRate: 0, intervalCount: 1,
      intervalUnit: "month", startDate: new Date().toISOString().slice(0, 10), dueInDays: 14, autoSend: true },
      { actor: org.actors.admin })
    if (schedule.status !== "completed") throw new Error(JSON.stringify(schedule))
    expect(await executeCommand(runRecurringInvoiceNow, { id: schedule.result.id }, { actor: org.actors.admin }))
      .toMatchObject({ status: "completed" })
    await runOrganizationJobs([org.organizationId])
    const generated = await prisma.invoice.findFirstOrThrow({ where: { recurringInvoiceId: schedule.result.id } })
    expect(generated).toMatchObject({ status: "sent", artifactPdfRef: expect.any(String) })
    expect(await candidates(org.organizationId)).toHaveLength(1)
    expect(render).toHaveBeenCalledTimes(1)
  })
  it("an already issued agreement offer keeps its number after a rejected email and sweep", async () => {
    const { org, contact, args } = await setup()
    const draft = await executeCommand(createAgreementDraft, { contactId: contact.id, title: "Offer",
      termsMarkdown: "Terms", validUntil: "2099-01-01", deliverables: [{ title: "Work", quantity: 1, unitPrice: 100 }] }, { actor: args.actor })
    if (draft.status !== "completed") throw new Error("draft failed")
    vi.mocked(deliver).mockRejectedValueOnce(new EmailSendError("validation_error", "refused"))
    await issueDocument({ kind: "agreement", commandInput: { id: draft.result.id }, actor: args.actor, clientRequestId: "offer" })
    const before = await prisma.agreement.findUniqueOrThrow({ where: { id: draft.result.id } })
    expect(before.offerSnapshot).toBeTruthy()
    expect(before.number).toBeTruthy()
    await sweepOrganizationArtifacts(org.organizationId, afterRetention())
    expect(await voids(org.organizationId)).toEqual([])
    expect((await prisma.agreement.findUniqueOrThrow({ where: { id: before.id } })).number).toBe(before.number)
  })

})
