import { afterEach, describe, expect, it, vi } from "vitest"
import { AsyncLocalStorage } from "node:async_hooks"
vi.mock("../../lib/email", async () => ({ ...(await vi.importActual<typeof import("../../lib/email")>("../../lib/email")), deliver: vi.fn() }))
import { deliver } from "../../lib/email"
import { getPrisma, prisma } from "../../lib/db"
import { getRuntimePlatform, resetRuntimePlatform, setRuntimePlatform } from "../../lib/runtime/platform"
import { runDueJobs } from "../../domain/jobs"
import { createTestOrganization, hasTestDatabase } from "../../test-utils/organization"
import { appRouter } from "../../trpc/router"
import { issueDocument } from "../issuance"

afterEach(() => { resetRuntimePlatform(); vi.unstubAllEnvs(); vi.mocked(deliver).mockClear() })
;(hasTestDatabase ? describe : describe.skip)("bounded invoice send", () => {
  it("delivers a Worker send before the response ends, issuing and sending it once", async () => {
    // MOCK: synthetic provider and Worker request/client lifetime; real command, jobs and DB writes.
    vi.stubEnv("RESEND_API_KEY", "synthetic-key")
    vi.stubEnv("FROM_EMAIL", "billing@example.test")
    vi.stubEnv("QUITS_PUBLIC_PAYMENT_SECRET", "synthetic-qui60-public-secret")
    const org = await createTestOrganization()
    const database = getPrisma()
    const platform = getRuntimePlatform()
    const requestScope = new AsyncLocalStorage<{ ended: boolean }>()
    const request = { ended: false }
    let release!: () => void
    let providerStarted!: () => void
    const started = new Promise<void>(resolve => { providerStarted = resolve })
    const stalled = new Promise<void>(resolve => { release = resolve })
    vi.mocked(deliver).mockImplementation(async () => { providerStarted(); await stalled; return { id: "synthetic-worker-email" } })
    setRuntimePlatform({ ...platform, id: "synthetic-worker", getRuntimeKind: () => "worker", getPrisma: () => {
      if (requestScope.getStore()?.ended) throw new Error("Request database clients released at response end")
      return database
    } })
    try {
      const caller = appRouter.createCaller({ session: { user: { id: org.actors.admin.userId, email: "admin@example.test", name: "Test" }, session: { activeOrganizationId: org.organizationId } } } as never)
      const contact = await prisma.contact.create({ data: { organizationId: org.organizationId, name: "Synthetic Buyer", company: "Synthetic Buyer ApS", email: "buyer@example.test" } })
      const invoice = await caller.invoices.create({ contactId: contact.id, dueDate: "2099-01-01", items: [{ description: "Work", quantity: 1, unitPrice: 100 }] })
      const send = () => issueDocument({ kind: "invoice", actor: org.actors.admin, commandInput: { id: invoice.id }, options: { jobWaitTimeoutMs: 25 } })
      const response = requestScope.run(request, send).finally(() => { request.ended = true })
      await started
      // The bound does not end a Worker request while its delivery still needs the request's clients.
      await new Promise(resolve => setTimeout(resolve, 100))
      expect(request.ended).toBe(false)
      expect((await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).lastEmailAttemptOutcome).toBe("sending")
      release()
      expect(await response).toMatchObject({ status: "completed" })
      const job = await prisma.job.findFirstOrThrow({ where: { organizationId: org.organizationId, type: "email.deliver" } })
      expect(job).toMatchObject({ status: "done", attempts: 1, result: { outcome: "delivered" }, payload: { providerMessageId: "synthetic-worker-email" } })
      expect(await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).toMatchObject({ status: "sent", lastEmailAttemptOutcome: "sent" })
      expect(await runDueJobs({ organizationIds: [org.organizationId] })).toMatchObject({ processed: 0 })
      expect(vi.mocked(deliver)).toHaveBeenCalledTimes(1)
      expect(await prisma.domainEvent.count({ where: { aggregateId: invoice.id, type: "invoice.issued" } })).toBe(1)
      expect(await prisma.domainEvent.count({ where: { aggregateId: invoice.id, type: "invoice.sent" } })).toBe(1)
    } finally {
      resetRuntimePlatform()
      release()
      // Let any inline delivery finish before cleanup.
      await new Promise(resolve => setTimeout(resolve, 100))
      await org.cleanup()
    }
  })
  it("returns a queued invoice while a provider stalls, then delivers exactly once", async () => {
    vi.stubEnv("RESEND_API_KEY", "synthetic-key")
    vi.stubEnv("FROM_EMAIL", "billing@example.test")
    vi.stubEnv("QUITS_PUBLIC_PAYMENT_SECRET", "synthetic-qui60-public-secret")
    const org = await createTestOrganization()
    let release!: () => void
    const stalled = new Promise<void>(resolve => { release = resolve })
    vi.mocked(deliver).mockImplementation(async () => { await stalled; return { id: "synthetic-email" } })
    const caller = appRouter.createCaller({ session: { user: { id: org.actors.admin.userId, email: "admin@example.test", name: "Test" }, session: { activeOrganizationId: org.organizationId } } } as never)
    await caller.paymentDetails.update({ bankAccount: { regNumber: "0040", accountNumber: "0440116243" } })
    const contact = await prisma.contact.create({ data: { organizationId: org.organizationId, name: "Synthetic Buyer", company: "Synthetic Buyer ApS", email: "buyer@example.test" } })
    const invoice = await caller.invoices.create({ contactId: contact.id, dueDate: "2099-01-01", items: [{ description: "Work", quantity: 1, unitPrice: 100 }] })
    // The real command and outbox path must return even though the mocked provider has no response.
    const sending = issueDocument({ kind: "invoice", actor: org.actors.admin, commandInput: { id: invoice.id }, options: { jobWaitTimeoutMs: 25 } })
    try {
      const result = await Promise.race([sending, new Promise(resolve => setTimeout(() => resolve("still waiting for provider"), 500))])
      expect(result).toMatchObject({ status: "completed", result: { emailPending: true } })
    } finally {
      release()
      await sending
      await new Promise(resolve => setTimeout(resolve, 100))
      expect(vi.mocked(deliver)).toHaveBeenCalledTimes(1)
      await org.cleanup()
    }
  })
})
