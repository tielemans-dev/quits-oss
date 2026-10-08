import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { prisma } from "../../../lib/db"
import { createTestOrganization, hasTestDatabase } from "../../../test-utils/organization"
import { authenticateAgentSecret, createAgentKey } from "../../../domain/agent-keys"
import { decideApproval } from "../../../domain/approvals"
import { generateRecurringRun, recurringSystemActor, resumeRecurringInvoice, runRecurringInvoiceNow } from "../../../domain/commands/recurring"
import { executeCommand } from "../../../domain/execute"
import { appRouter } from "../../router"

const cleanups: Array<() => Promise<void>> = []
beforeEach(() => { vi.stubEnv("RESEND_API_KEY", "") })
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.()
  vi.unstubAllEnvs()
})
async function setup() {
  const org = await createTestOrganization()
  cleanups.push(org.cleanup)
  const api = appRouter.createCaller({ session: {
    user: { id: org.actors.admin.userId, email: "test@example.test", name: "Test" },
    session: { activeOrganizationId: org.organizationId },
  } } as never)
  const contact = await api.contacts.create({ name: "Buyer", email: "buyer@example.test", country: "DK", peppolEndpointScheme: "0088", peppolEndpointId: "5790000000005" })
  const input = { contactId: contact.id, name: "Monthly", startDate: "2099-01-01", taxRate: "25",
    items: [{ description: "Work", quantity: "1", unitPrice: "100" }] }
  return { api, input, org }
}

;(hasTestDatabase ? describe : describe.skip)("recurring purchase order references", () => {
  for (const version of ["V1", "V2"] as const) {
    it(`round-trips ${version} create, update, get and list with clear and omission semantics`, async () => {
      const { api, input } = await setup()
      const create = version === "V1" ? api.recurring.create : api.recurring.createV2
      const update = version === "V1" ? api.recurring.update : api.recurring.updateV2
      const schedule = await create({ ...input, purchaseOrderRef: " PO-monthly " })
      const id = schedule.id
      expect(schedule.purchaseOrderRef).toBe("PO-monthly")
      expect((await api.recurring.get({ id })).purchaseOrderRef).toBe("PO-monthly")
      expect((await api.recurring.list())[0]?.purchaseOrderRef).toBe("PO-monthly")
      expect((await update({ id, purchaseOrderRef: " PO-edited " })).purchaseOrderRef).toBe("PO-edited")
      expect((await update({ id, notes: "Keep reference" })).purchaseOrderRef).toBe("PO-edited")
      expect((await update({ id, purchaseOrderRef: "   " })).purchaseOrderRef).toBeNull()
      await update({ id, purchaseOrderRef: "PO-restored" })
      expect((await update({ id, purchaseOrderRef: null })).purchaseOrderRef).toBeNull()
      for (const purchaseOrderRef of [undefined, null, "", "   "]) {
        expect((await create({ ...input, purchaseOrderRef })).purchaseOrderRef).toBeNull()
      }
    })

    it(`validates ${version} references without writing invalid changes`, async () => {
      const { api, input, org } = await setup()
      const create = version === "V1" ? api.recurring.create : api.recurring.createV2
      const update = version === "V1" ? api.recurring.update : api.recurring.updateV2
      const schedule = await create({ ...input, purchaseOrderRef: `  ${"Æ".repeat(200)}  ` })
      expect(schedule.purchaseOrderRef).toBe("Æ".repeat(200))
      expect((await update({ id: schedule.id, purchaseOrderRef: `  ${"B".repeat(200)}  ` })).purchaseOrderRef).toBe("B".repeat(200))
      const before = await api.recurring.get({ id: schedule.id })
      for (const purchaseOrderRef of ["A".repeat(201), "\u200b", "\ufeffPO", "PO\n", "\t", "PO\u0000", "PO\uffff"]) {
        await expect(create({ ...input, purchaseOrderRef })).rejects.toMatchObject({ code: "BAD_REQUEST" })
        await expect(update({ id: schedule.id, purchaseOrderRef })).rejects.toMatchObject({ code: "BAD_REQUEST" })
      }
      expect(await prisma.recurringInvoice.count({ where: { organizationId: org.organizationId } })).toBe(1)
      expect(await api.recurring.get({ id: schedule.id })).toEqual(before)
    })
  }

  it("copies references only to future invoices and freezes the generated draft's BT-13 on issue", async () => {
    const { api, input, org } = await setup()
    const schedule = await api.recurring.createV2({ ...input, purchaseOrderRef: " PO-original " })
    const issued = (await api.recurring.runNow({ id: schedule.id })).invoice!
    const draft = (await api.recurring.runNow({ id: schedule.id })).invoice!
    expect((await api.invoices.view({ id: issued.id })).view.buyer?.purchaseOrderRef).toBe("PO-original")
    expect((await api.invoices.view({ id: draft.id })).view.buyer?.purchaseOrderRef).toBe("PO-original")
    await api.invoices.send({ id: issued.id, allowSendWithoutEmail: true })
    const candidate = await prisma.issuanceCandidate.findFirstOrThrow({ where: {
      organizationId: org.organizationId, documentId: issued.id, status: "published",
    } })
    expect(candidate.renderInput).toMatchObject({ snapshot: { purchaseOrderRef: "PO-original" }, ubl: { orderReference: "PO-original" } })
    await api.recurring.updateV2({ id: schedule.id, purchaseOrderRef: " PO-next " })
    const next = (await api.recurring.runNow({ id: schedule.id })).invoice!
    expect((await api.invoices.view({ id: next.id })).view.buyer?.purchaseOrderRef).toBe("PO-next")
    await api.recurring.update({ id: schedule.id, purchaseOrderRef: " " })
    const cleared = (await api.recurring.runNow({ id: schedule.id })).invoice!
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: cleared.id } })).purchaseOrderRef).toBeNull()
    for (const previous of [issued, draft]) {
      const row = await prisma.invoice.findUniqueOrThrow({ where: { id: previous.id } })
      expect(row.purchaseOrderRef).toBe("PO-original")
      expect((await api.invoices.view({ id: previous.id })).view.buyer?.purchaseOrderRef).toBe("PO-original")
    }
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: issued.id } })).status).toBe("sent")
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: draft.id } })).status).toBe("draft")
    expect((await prisma.issuanceCandidate.findUniqueOrThrow({ where: { id: candidate.id } })).renderInput).toEqual(candidate.renderInput)
  })

  it("copies the reference through the scheduler generation command too", async () => {
    const { api, input, org } = await setup()
    const schedule = await api.recurring.createV2({ ...input, purchaseOrderRef: "PO-scheduler" })
    const generated = await executeCommand(generateRecurringRun, { id: schedule.id, runDate: schedule.nextRunAt.toISOString() }, {
      actor: recurringSystemActor(org.organizationId), clientRequestId: "reference-scheduled-run",
    })
    if (generated.status !== "completed" || !generated.result.invoice) throw new Error(JSON.stringify(generated))
    expect(await prisma.invoice.findUniqueOrThrow({ where: { id: generated.result.invoice.id } }))
      .toMatchObject({ status: "draft", purchaseOrderRef: "PO-scheduler" })
  })

  for (const action of ["resume", "run_now"] as const) {
    it(`shows the reference and invalidates ${action} approval after a schedule edit`, async () => {
      const { api, input, org } = await setup()
      const schedule = await api.recurring.createV2({ ...input, autoSend: true, purchaseOrderRef: "PO-reviewed" })
      if (action === "resume") await api.recurring.setStatus({ id: schedule.id, status: "paused" })
      const { secret } = await createAgentKey(org.actors.admin, { name: "Scheduler", mode: "approval_required", scopes: ["recurring:update"] })
      const actor = await authenticateAgentSecret(secret)
      const options = { actor, clientRequestId: `reference-${action}` }
      const queued = action === "resume"
        ? await executeCommand(resumeRecurringInvoice, { id: schedule.id }, options)
        : await executeCommand(runRecurringInvoiceNow, { id: schedule.id }, options)
      if (queued.status !== "awaiting_approval") throw new Error(JSON.stringify(queued))
      expect((await api.agents.approvals({ view: "pending" }))[0]?.reviewDetails).toMatchObject({ purchaseOrderRef: "PO-reviewed" })
      await api.recurring.update({ id: schedule.id, purchaseOrderRef: "PO-changed" })
      expect(await decideApproval({ approvalRequestId: queued.approvalRequestId, decider: org.actors.admin, decision: "approve" }))
        .toMatchObject({ status: "failed", error: { code: "changed_since_review" } })
      expect(await prisma.invoice.count({ where: { recurringInvoiceId: schedule.id } })).toBe(0)
    })
  }
})
