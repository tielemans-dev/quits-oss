import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
vi.mock("../../lib/email", async () => ({
  ...(await vi.importActual<typeof import("../../lib/email")>(
    "../../lib/email"
  )),
  deliver: vi.fn().mockResolvedValue({ id: "accepted_1" })
}))
import { executeIssuanceCommand } from "../../application/issuance"
import { getPrisma, prisma } from "../../lib/db"
import { deliver, EmailSendError } from "../../lib/email"
import {
  resetRuntimeServices,
  setRuntimeServices
} from "../../lib/runtime/services"
import { Prisma } from "../../../generated/prisma/client"
import { defaultNodePlatform } from "../../lib/runtime/node-platform"
import {
  resetRuntimePlatform,
  setRuntimePlatform
} from "../../lib/runtime/platform"
import {
  createTestOrganization,
  hasTestDatabase
} from "../../test-utils/organization"
import { authenticateAgentSecret, createAgentKey } from "../agent-keys"
import { createContact } from "../commands/contacts"
import {
  createInvoiceDraft,
  resendInvoiceEmail,
  sendInvoice
} from "../commands/invoices"
import {
  documentJournal,
  manualResendCommand,
  reconcileDelivery,
  recoverDelivery
} from "../delivery/journal"
import { EMAIL_DELIVERY_JOB } from "../delivery/outbox"
import { executeCommand } from "../execute"
import { runDueJobs, runJobsNow } from "../jobs"
import { appRouter } from "../../trpc/router"

const suite = hasTestDatabase ? describe : describe.skip
suite("operation journal and bounded recovery", () => {
  const cleanup: Array<() => Promise<void>> = []
  beforeEach(() => {
    vi.stubEnv("RESEND_API_KEY", "synthetic_test_key")
    vi.stubEnv("FROM_EMAIL", "sender@example.test")
    vi.stubEnv("EMAIL_PROVIDER", "resend")
    vi.mocked(deliver).mockReset()
    vi.mocked(deliver).mockResolvedValue({ id: "accepted_1" })
  })
  afterEach(async () => {
    resetRuntimePlatform()
    while (cleanup.length) await cleanup.pop()?.()
    vi.unstubAllEnvs()
    resetRuntimeServices()
  })
  async function setup() {
    const org = await createTestOrganization({ roles: ["admin", "accountant"] })
    cleanup.push(org.cleanup)
    const actor = org.actors.admin
    const contact = await executeCommand(
      createContact,
      { name: "Journal customer", email: "recipient@example.test" },
      { actor }
    )
    if (contact.status !== "completed") throw new Error("contact setup failed")
    const requestId = crypto.randomUUID()
    const input = {
      contactId: contact.result.id,
      dueDate: "2099-12-01",
      taxRate: 0,
      items: [{ description: "Consulting", quantity: 1, unitPrice: 100 }]
    }
    const created = await executeCommand(createInvoiceDraft, input, {
      actor,
      clientRequestId: requestId
    })
    if (created.status !== "completed") throw new Error("invoice setup failed")
    const scope = {
      documentType: "invoice" as const,
      documentId: created.result.id
    }
    return { org, actor, scope, created, input, requestId }
  }
  function beforeJobWrite(before: (args: Prisma.JobUpdateManyArgs) => void) {
    const extended = getPrisma().$extends({
      query: {
        job: {
          updateMany({ args, query }) {
            before(args)
            return query(args)
          }
        }
      }
    })
    setRuntimePlatform({ ...defaultNodePlatform, getPrisma: () => extended })
  }
  const findJob = (organizationId: string) =>
    prisma.job.findFirstOrThrow({
      where: { organizationId, type: EMAIL_DELIVERY_JOB },
      orderBy: { createdAt: "asc" }
    })
  async function uncertain() {
    const context = await setup()
    vi.stubEnv("EMAIL_PROVIDER", "smtp")
    vi.stubEnv("SMTP_HOST", "relay.example.test")
    vi.mocked(deliver).mockRejectedValueOnce(
      new Error("Response lost after possible SMTP acceptance")
    )
    await executeIssuanceCommand(
      sendInvoice,
      { id: context.scope.documentId },
      { actor: context.actor, clientRequestId: "send-original" }
    )
    const job = await findJob(context.org.organizationId)
    return {
      ...context,
      job,
      delivery: { ...context.scope, deliveryId: job.id }
    }
  }
  it("retains the created record and receipt after a caller interruption, and recovers only a never-submitted outbox step", async () => {
    const { actor, scope, created, requestId, input, org } = await setup()
    // A caller loses its response after creation commits. The same request returns the same record.
    const retried = await executeCommand(createInvoiceDraft, input, {
      actor,
      clientRequestId: requestId
    })
    expect(retried).toMatchObject({
      status: "completed",
      result: { id: scope.documentId }
    })
    expect(
      await prisma.invoice.count({
        where: { organizationId: org.organizationId }
      })
    ).toBe(1)
    expect((await documentJournal(actor, scope)).commands).toContainEqual(
      expect.objectContaining({
        id: created.commandId,
        state: "effects_completed",
        steps: expect.arrayContaining([
          expect.objectContaining({ type: "invoice.draft_created" })
        ])
      })
    )
    // Interrupt the job before its durable pre-request marker. The command transaction
    // has committed its receipt, candidate and outbox together, but no provider was called.
    let stop = true
    beforeJobWrite((args) => {
      if (
        stop &&
        (args.data as { payload?: { requests?: number } }).payload?.requests ===
          1
      ) {
        stop = false
        throw new Error("interrupted before submission")
      }
    })
    await executeIssuanceCommand(
      sendInvoice,
      { id: scope.documentId },
      { actor, clientRequestId: "queued-send" }
    )
    resetRuntimePlatform()
    const job = await findJob(org.organizationId)
    expect(vi.mocked(deliver)).not.toHaveBeenCalled()
    expect((await documentJournal(actor, scope)).deliveries[0]).toMatchObject({
      canRecover: true,
      state: "queued"
    })
    await recoverDelivery(actor, { ...scope, deliveryId: job.id })
    expect(vi.mocked(deliver)).toHaveBeenCalledTimes(1)
    expect(
      await prisma.invoice.count({
        where: { organizationId: org.organizationId }
      })
    ).toBe(1)
    expect(
      await prisma.domainEvent.count({
        where: {
          organizationId: org.organizationId,
          type: "invoice.draft_created"
        }
      })
    ).toBe(1)
  })
  it.each(["accepted", "rejected"] as const)(
    "recovers settlement after %s evidence without calling the provider or issuing twice",
    async (outcome) => {
      const { actor, scope, org } = await setup()
      const base = getPrisma()
      let stopSettlement = false
      setRuntimePlatform({
        ...defaultNodePlatform,
        getPrisma: () =>
          new Proxy(base, {
            get(target, property) {
              if (property === "$transaction")
                return (...args: unknown[]) => {
                  if (stopSettlement) {
                    stopSettlement = false
                    return Promise.reject(new Error("settlement interrupted"))
                  }
                  return Reflect.apply(target.$transaction, target, args)
                }
              const value = Reflect.get(target, property)
              return typeof value === "function" ? value.bind(target) : value
            }
          })
      })
      vi.mocked(deliver).mockImplementationOnce(async () => {
        stopSettlement = true
        if (outcome === "rejected")
          throw new EmailSendError("validation_error", "refused submission")
        return { id: "accepted_1" }
      })
      await executeIssuanceCommand(
        sendInvoice,
        { id: scope.documentId },
        { actor, clientRequestId: "acceptance-stored" }
      )
      resetRuntimePlatform()
      const job = await findJob(org.organizationId)
      expect(job.payload).toMatchObject(
        outcome === "accepted"
          ? { providerMessageId: "accepted_1", requests: 1 }
          : { decision: { reason: "rejected" }, requests: 1 }
      )
      expect((await documentJournal(actor, scope)).deliveries[0]?.state).toBe(
        outcome === "accepted" ? "delivery_confirmed" : "failed_step"
      )
      expect(vi.mocked(deliver)).toHaveBeenCalledTimes(1)
      await recoverDelivery(actor, { ...scope, deliveryId: job.id })
      expect(vi.mocked(deliver)).toHaveBeenCalledTimes(1)
      expect(
        await prisma.invoice.findUniqueOrThrow({
          where: { id: scope.documentId }
        })
      ).toMatchObject({ status: outcome === "accepted" ? "sent" : "draft" })
      expect(
        await prisma.domainEvent.count({
          where: { organizationId: org.organizationId, type: "invoice.sent" }
        })
      ).toBe(outcome === "accepted" ? 1 : 0)
      await runJobsNow([job.id])
      expect(
        await prisma.domainEvent.count({
          where: { organizationId: org.organizationId, type: "invoice.sent" }
        })
      ).toBe(outcome === "accepted" ? 1 : 0)
    }
  )
  it("distinguishes missing configuration from a delivery failure", async () => {
    const { actor, scope, org } = await setup()
    beforeJobWrite((args) => {
      if ((args.data as { status?: string }).status === "running")
        vi.stubEnv("RESEND_API_KEY", "")
    })
    await executeIssuanceCommand(
      sendInvoice,
      { id: scope.documentId },
      { actor, clientRequestId: "wait-for-config" }
    )
    resetRuntimePlatform()
    const job = await findJob(org.organizationId)
    expect((await documentJournal(actor, scope)).deliveries[0]).toMatchObject({
      state: "waiting_prerequisite",
      canRecover: true
    })
    expect(vi.mocked(deliver)).not.toHaveBeenCalled()
    vi.stubEnv("RESEND_API_KEY", "synthetic_test_key")
    await recoverDelivery(actor, { ...scope, deliveryId: job.id })
    expect(vi.mocked(deliver)).toHaveBeenCalledTimes(1)
  })
  it("joins a failed business step and an approval prerequisite even when neither emitted a document event", async () => {
    const { actor, scope } = await setup()
    const failed = await executeCommand(
      resendInvoiceEmail,
      { id: scope.documentId },
      { actor }
    )
    expect(failed.status).toBe("failed")
    expect((await documentJournal(actor, scope)).commands).toContainEqual(
      expect.objectContaining({
        id: failed.commandId,
        type: "invoice.resend_email",
        state: "failed_step",
        steps: []
      })
    )
    const { secret } = await createAgentKey(actor, {
      name: "Approval operator",
      mode: "approval_required",
      scopes: ["invoice:read", "invoice:send"]
    })
    const agent = await authenticateAgentSecret(secret)
    if (!agent) throw new Error("Agent authentication failed")
    const waiting = await executeIssuanceCommand(
      sendInvoice,
      { id: scope.documentId },
      { actor: agent, clientRequestId: "waiting-send" }
    )
    expect(waiting.status).toBe("awaiting_approval")
    expect((await documentJournal(actor, scope)).commands).toContainEqual(
      expect.objectContaining({
        id: waiting.commandId,
        type: "invoice.send",
        state: "waiting_prerequisite",
        steps: []
      })
    )
    expect(vi.mocked(deliver)).not.toHaveBeenCalled()
  })
  it("rolls back an interrupted creation and records only the successful retry", async () => {
    const { actor, input, org } = await setup()
    const extended = getPrisma().$extends({
      query: {
        invoice: {
          async create({ args, query }) {
            await query(args)
            throw new Error("creation interrupted before commit")
          }
        }
      }
    })
    setRuntimePlatform({ ...defaultNodePlatform, getPrisma: () => extended })
    await expect(
      executeCommand(createInvoiceDraft, input, {
        actor,
        clientRequestId: "creation-interrupted"
      })
    ).rejects.toThrow("creation interrupted before commit")
    resetRuntimePlatform()
    expect(
      await prisma.invoice.count({
        where: { organizationId: org.organizationId }
      })
    ).toBe(1)
    expect(
      await prisma.commandReceipt.count({
        where: {
          organizationId: org.organizationId,
          clientRequestId: "creation-interrupted"
        }
      })
    ).toBe(0)
    const created = await executeCommand(createInvoiceDraft, input, {
      actor,
      clientRequestId: "creation-interrupted"
    })
    expect(created.status).toBe("completed")
    expect(
      await executeCommand(createInvoiceDraft, input, {
        actor,
        clientRequestId: "creation-interrupted"
      })
    ).toEqual(created)
    expect(
      await prisma.invoice.count({
        where: { organizationId: org.organizationId }
      })
    ).toBe(2)
    expect(
      await prisma.domainEvent.count({
        where: {
          organizationId: org.organizationId,
          type: "invoice.draft_created"
        }
      })
    ).toBe(2)
  })
  it("keeps SMTP uncertainty visible and forbids automatic and unacknowledged resends", async () => {
    const { actor, scope, job, delivery } = await uncertain()
    const journal = await documentJournal(actor, scope)
    expect(journal.deliveries[0]).toMatchObject({
      state: "uncertain",
      recipient: "recipient@example.test",
      canRecover: false,
      canManualResend: true,
      attempts: [{ outcome: "uncertain", startedAt: expect.any(String) }]
    })
    await expect(recoverDelivery(actor, delivery)).rejects.toMatchObject({
      code: "unsafe_retry"
    })
    const normal = await executeCommand(
      resendInvoiceEmail,
      { id: scope.documentId },
      { actor }
    )
    expect(normal).toMatchObject({
      status: "failed",
      error: { code: "manual_resend_required" }
    })
    const unacknowledged = await executeCommand(
      manualResendCommand("invoice"),
      { ...delivery, reason: "verified", clientRequestId: "manual-1" },
      { actor }
    )
    expect(unacknowledged.status).toBe("failed")
    await runDueJobs({ organizationIds: [actor.organizationId] })
    expect(vi.mocked(deliver)).toHaveBeenCalledTimes(1)
    expect(job.result).toMatchObject({ outcome: "unconfirmed" })
  })
  it("records one manual decision, sends the stored communication for the same invoice, and replays its receipt", async () => {
    const { actor, scope, job, delivery } = await uncertain()
    vi.mocked(deliver).mockResolvedValue({ id: "manual_accepted" })
    const input = {
      ...delivery,
      reason: "Recipient checked and requested another copy",
      acknowledgeDuplicateRisk: true as const,
      clientRequestId: "manual-1"
    }
    const decision = manualResendCommand("invoice")
    const result = await executeCommand(decision, input, {
      actor,
      clientRequestId: input.clientRequestId
    })
    expect(result.status).toBe("completed")
    expect(
      await executeCommand(decision, input, {
        actor,
        clientRequestId: input.clientRequestId
      })
    ).toEqual(result)
    expect(vi.mocked(deliver)).toHaveBeenCalledTimes(2)
    expect(vi.mocked(deliver).mock.calls[1]?.[0]).toEqual(
      (job.payload as { message: unknown }).message
    )
    expect(
      await prisma.invoice.count({
        where: { organizationId: actor.organizationId }
      })
    ).toBe(1)
    expect(
      await prisma.domainEvent.count({
        where: {
          organizationId: actor.organizationId,
          type: "invoice.draft_created"
        }
      })
    ).toBe(1)
    expect(
      await prisma.domainEvent.count({
        where: { organizationId: actor.organizationId, type: "invoice.sent" }
      })
    ).toBe(0)
    expect(
      await prisma.domainEvent.count({
        where: { organizationId: actor.organizationId, type: "invoice.issued" }
      })
    ).toBe(1)
    expect(
      await prisma.domainEvent.count({
        where: {
          organizationId: actor.organizationId,
          type: "delivery.manual_resend_requested"
        }
      })
    ).toBe(1)
    expect((await documentJournal(actor, scope)).deliveries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          recoveryOf: job.id,
          manualReason: input.reason
        }),
        expect.objectContaining({
          id: job.id,
          state: "uncertain",
          canManualResend: false
        })
      ])
    )
    expect(
      (
        await executeCommand(
          decision,
          { ...input, clientRequestId: "manual-2" },
          { actor, clientRequestId: "manual-2" }
        )
      ).status
    ).toBe("failed")
  })
  it("applies repeated and out-of-order status evidence monotonically and leaves unknown unresolved", async () => {
    const { actor, scope, delivery } = await uncertain()
    const lookup = vi.fn().mockResolvedValue({
      evidenceId: "lookup-1",
      observedAt: new Date(),
      outcome: "unknown"
    })
    setRuntimeServices({
      emailDeliveryStatusProvider: { supports: () => true, lookup }
    })
    await reconcileDelivery(actor, delivery)
    await reconcileDelivery(actor, delivery)
    expect((await documentJournal(actor, scope)).deliveries[0]).toMatchObject({
      state: "uncertain",
      evidence: [{ outcome: "unknown" }]
    })
    expect(
      await prisma.domainEvent.count({
        where: {
          organizationId: actor.organizationId,
          type: "delivery.provider_evidence"
        }
      })
    ).toBe(1)
    lookup.mockResolvedValue({
      evidenceId: "lookup-2",
      observedAt: new Date(),
      outcome: "accepted",
      providerMessageId: "smtp-evidence"
    })
    await reconcileDelivery(actor, delivery)
    await reconcileDelivery(actor, delivery)
    lookup.mockResolvedValue({
      evidenceId: "old-unknown",
      observedAt: new Date(0),
      outcome: "unknown"
    })
    await reconcileDelivery(actor, delivery)
    expect((await documentJournal(actor, scope)).deliveries[0]).toMatchObject({
      state: "delivery_confirmed",
      providerReference: "smtp-evidence",
      canManualResend: false
    })
    expect(
      await prisma.domainEvent.count({
        where: {
          organizationId: actor.organizationId,
          type: "delivery.provider_evidence"
        }
      })
    ).toBe(2)
    expect(
      await prisma.invoice.findUniqueOrThrow({
        where: { id: scope.documentId }
      })
    ).toMatchObject({ status: "sent", lastEmailAttemptOutcome: "sent" })
    expect(vi.mocked(deliver)).toHaveBeenCalledTimes(1)
  })
  it("fences a stopped SMTP runner before recovery, including a request with no recorded answer", async () => {
    const { actor, scope, org } = await setup()
    // Crash after the provider effect, before recording acceptance. The persisted started
    // marker must force uncertainty and must not cause another SMTP submission.
    beforeJobWrite((args) => {
      if (
        (args.data as { payload?: { providerMessageId?: string } }).payload
          ?.providerMessageId
      )
        throw new Error("process stopped before acceptance write")
    })
    vi.stubEnv("EMAIL_PROVIDER", "smtp")
    vi.stubEnv("SMTP_HOST", "relay.example.test")
    await executeIssuanceCommand(
      sendInvoice,
      { id: scope.documentId },
      { actor, clientRequestId: "crashed-smtp" }
    )
    resetRuntimePlatform()
    const job = await findJob(org.organizationId)
    await recoverDelivery(actor, { ...scope, deliveryId: job.id }).catch(
      (error) => expect(error).toMatchObject({ code: "unsafe_retry" })
    )
    await prisma.job.update({
      where: { id: job.id },
      data: { runAfter: new Date(0) }
    })
    await runDueJobs({ organizationIds: [org.organizationId] })
    expect(vi.mocked(deliver)).toHaveBeenCalledTimes(1)
    expect((await documentJournal(actor, scope)).deliveries[0]?.state).toBe(
      "uncertain"
    )
  })
  it("does not replay a revoked public link or change a newer delivery marker when old evidence arrives", async () => {
    const { actor, scope, delivery } = await uncertain()
    await prisma.invoice.update({
      where: { id: scope.documentId },
      data: { publicPaymentKeyVersion: { increment: 1 } }
    })
    expect(
      (await documentJournal(actor, scope)).deliveries[0]?.canManualResend
    ).toBe(false)
    const refused = await executeCommand(
      manualResendCommand("invoice"),
      {
        ...delivery,
        reason: "Recipient asked",
        acknowledgeDuplicateRisk: true,
        clientRequestId: "revoked-send"
      },
      { actor, clientRequestId: "revoked-send" }
    )
    expect(refused).toMatchObject({
      status: "failed",
      error: { code: "manual_resend_unavailable" }
    })
    const newer = new Date("2099-01-01T00:00:00Z")
    await prisma.invoice.update({
      where: { id: scope.documentId },
      data: { lastEmailAttemptAt: newer, lastEmailAttemptOutcome: "sending" }
    })
    setRuntimeServices({
      emailDeliveryStatusProvider: {
        supports: () => true,
        lookup: async () => ({
          evidenceId: "old-confirmation",
          observedAt: new Date(),
          outcome: "accepted",
          providerMessageId: "old-message"
        })
      }
    })
    await reconcileDelivery(actor, delivery)
    expect(
      await prisma.invoice.findUniqueOrThrow({
        where: { id: scope.documentId }
      })
    ).toMatchObject({
      lastEmailAttemptAt: newer,
      lastEmailAttemptOutcome: "sending"
    })
    expect(vi.mocked(deliver)).toHaveBeenCalledTimes(1)
  })
  it("leaves a failed provider lookup unresolved and prevents recovery of a claimed delivery", async () => {
    const { actor, scope, delivery, job } = await uncertain()
    setRuntimeServices({
      emailDeliveryStatusProvider: {
        supports: () => true,
        lookup: async () => {
          throw new Error("lookup unavailable")
        }
      }
    })
    await expect(reconcileDelivery(actor, delivery)).rejects.toThrow(
      "lookup unavailable"
    )
    expect((await documentJournal(actor, scope)).deliveries[0]?.state).toBe(
      "uncertain"
    )
    expect(
      await prisma.domainEvent.count({
        where: {
          organizationId: actor.organizationId,
          type: "delivery.provider_evidence"
        }
      })
    ).toBe(0)
    await prisma.job.update({
      where: { id: job.id },
      data: {
        result: Prisma.DbNull,
        status: "running",
        claimToken: "other-run"
      }
    })
    await expect(recoverDelivery(actor, delivery)).rejects.toMatchObject({
      code: "unsafe_retry"
    })
    expect(vi.mocked(deliver)).toHaveBeenCalledTimes(1)
  })
  it("hides journal details across organizations and from an actor missing document read permission", async () => {
    const { actor, scope, org } = await setup()
    await expect(
      documentJournal({ ...actor, roles: [] }, scope)
    ).rejects.toMatchObject({ _tag: "Forbidden" })
    const stranger = await createTestOrganization({ roles: ["admin"] })
    cleanup.push(stranger.cleanup)
    const caller = appRouter.createCaller({
      session: {
        user: { id: stranger.actors.admin.userId },
        session: { activeOrganizationId: stranger.organizationId }
      }
    } as never)
    await expect(caller.journal.forDocument(scope)).rejects.toMatchObject({
      code: "NOT_FOUND"
    })
    const accountant = appRouter.createCaller({
      session: {
        user: { id: org.actors.accountant.userId },
        session: { activeOrganizationId: org.organizationId }
      }
    } as never)
    expect((await accountant.journal.forDocument(scope)).commands.length).toBe(
      1
    )
    await expect(
      accountant.journal.recover({ ...scope, deliveryId: "private-job" })
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
  })
})
