import { randomUUID } from "node:crypto"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../../lib/email", async () => ({
  ...await vi.importActual<typeof import("../../lib/email")>("../../lib/email"), deliver: vi.fn(),
}))

import { executeIssuanceCommand } from "../../application/issuance"
import { prisma } from "../../lib/db"
import { deliver } from "../../lib/email"
import { translate } from "../../lib/i18n/translate"
import { UNDO_HOLD_LEASE_MS, UNDO_WINDOW_MS } from "../../lib/undo-window"
import { createTestOrganization, hasTestDatabase } from "../../test-utils/organization"
import { jobsRouter } from "../../trpc/routers/jobs"
import { runtimeRouter } from "../../trpc/routers/runtime"
import { createContact } from "../commands/contacts"
import { createInvoiceDraft } from "../commands/invoices"
import { DELAYED_INVOICE_SEND_JOB } from "../held-jobs"
import { runDueJobs } from "../jobs"
import { REMINDER_BATCH_JOB } from "../reminder-jobs"

describe.skipIf(!hasTestDatabase)("held sends and Fortryd", () => {
  const cleanups: Array<() => Promise<void>> = []
  beforeEach(() => {
    vi.stubEnv("EMAIL_PROVIDER", "resend")
    vi.stubEnv("RESEND_API_KEY", "test-key")
    vi.stubEnv("FROM_EMAIL", "sender@example.com")
    vi.mocked(deliver).mockReset().mockResolvedValue({ id: "accepted" })
  })
  afterEach(async () => {
    vi.unstubAllEnvs()
    while (cleanups.length) await cleanups.pop()!()
  })

  async function setup() {
    const org = await createTestOrganization({ roles: ["admin", "accountant"],
      settings: { currency: "DKK", timezone: "Europe/Copenhagen", companyName: "Acme ApS", companyEmail: "seller@acme.test" } })
    cleanups.push(org.cleanup)
    const caller = () => jobsRouter.createCaller({ session: {
      user: { id: org.actors.admin.userId }, session: { activeOrganizationId: org.organizationId },
    } } as never)
    /** The undo window closes: what is held becomes due. */
    const closeWindow = () => prisma.job.updateMany({
      where: { organizationId: org.organizationId, status: "pending", type: { in: [REMINDER_BATCH_JOB, DELAYED_INVOICE_SEND_JOB] } },
      data: { runAfter: new Date(0) },
    })
    const sweep = () => runDueJobs({ organizationIds: [org.organizationId] })
    return { org, api: caller(), caller, closeWindow, sweep }
  }

  async function overdueInvoice(organizationId: string) {
    const contact = await prisma.contact.create({ data: { organizationId, name: "Buyer", email: "buyer@example.com" } })
    return (await prisma.invoice.create({ data: {
      organizationId, contactId: contact.id, number: randomUUID(), status: "sent",
      dueDate: new Date("2026-01-01"), totalGross: "100", subtotalNet: "100",
    } })).id
  }

  async function draftInvoice(ctx: Awaited<ReturnType<typeof setup>>, email: string | null = "customer@kunde.test") {
    const contact = await executeIssuanceCommand(createContact, { name: "Kunde & Co", email: email ?? undefined }, { actor: ctx.org.actors.admin })
    if (contact.status !== "completed") throw new Error("contact setup failed")
    const draft = await executeIssuanceCommand(createInvoiceDraft,
      { contactId: contact.result.id, dueDate: "2099-12-01", currency: "DKK", taxRate: 25, items: [{ description: "Design", quantity: 2, unitPrice: 100 }] },
      { actor: ctx.org.actors.admin })
    if (draft.status !== "completed") throw new Error("draft setup failed")
    return draft.result.id
  }

  it("refuses both queues before creating jobs when email is unconfigured, then allows retry after configuration", async () => {
    const ctx = await setup()
    const invoiceId = await overdueInvoice(ctx.org.organizationId)
    const id = await draftInvoice(ctx)
    const runtime = runtimeRouter.createCaller({} as never)
    expect((await runtime.capabilities()).emailDelivery).toMatchObject({ configured: true })
    vi.stubEnv("RESEND_API_KEY", "")
    expect((await runtime.capabilities()).emailDelivery).toMatchObject({ configured: false })

    const request = { invoiceIds: [invoiceId], clientRequestId: randomUUID() }
    for (const send of [() => ctx.api.sendReminders(request), () => ctx.api.sendInvoiceLater({ id })]) {
      await expect(send()).rejects.toMatchObject({ code: "BAD_REQUEST", cause: { tag: "InvalidState", code: "email_unavailable" } })
    }
    expect(await prisma.job.count({ where: { organizationId: ctx.org.organizationId } })).toBe(0)
    expect(await prisma.jobStep.count({ where: { job: { organizationId: ctx.org.organizationId } } })).toBe(0)
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id } })).status).toBe("draft")
    expect(deliver).not.toHaveBeenCalled()
    expect(translate("email.error.email_unavailable", "en-US")).toContain("Configure email delivery")
    expect(translate("email.error.email_unavailable", "da-DK")).toContain("Opsæt e-maillevering")

    vi.stubEnv("RESEND_API_KEY", "test-key")
    await expect(ctx.api.sendReminders(request)).resolves.toHaveProperty("jobId")
    await expect(ctx.api.sendInvoiceLater({ id })).resolves.toHaveProperty("jobId")
  })

  describe("reminder batch", () => {
    it("is held for the undo window: listed with its time left, and nothing is sent before it closes", async () => {
      const ctx = await setup()
      const { jobId } = await ctx.api.sendReminders({ invoiceIds: [await overdueInvoice(ctx.org.organizationId)], clientRequestId: randomUUID() })

      const [held] = await ctx.api.held()
      expect(held).toMatchObject({ id: jobId, type: REMINDER_BATCH_JOB, steps: 1, invoiceId: null })
      expect(held!.heldForMs).toBeGreaterThan(UNDO_WINDOW_MS - 3000)
      expect(held!.heldForMs).toBeLessThanOrEqual(UNDO_WINDOW_MS)
      expect((await ctx.api.get({ jobId })).heldForMs).toBeGreaterThan(0)

      expect(await ctx.sweep()).toMatchObject({ processed: 0 })
      // Releasing early cannot send early: the job is not due.
      expect(await ctx.api.release({ jobId })).toEqual({ status: "pending", error: null })
      expect(deliver).not.toHaveBeenCalled()
    })

    it("is taken back by Fortryd before anything is sent, and then never runs", async () => {
      const ctx = await setup()
      const { jobId } = await ctx.api.sendReminders({ invoiceIds: [await overdueInvoice(ctx.org.organizationId)], clientRequestId: randomUUID() })

      await ctx.api.cancelHeld({ jobId })

      await expect(ctx.api.get({ jobId })).rejects.toThrow("not found")
      expect(await ctx.api.held()).toEqual([])
      expect(await prisma.jobStep.count({ where: { jobId } })).toBe(0)
      await ctx.closeWindow()
      await ctx.sweep()
      expect(deliver).not.toHaveBeenCalled()
    })

    it("refuses Fortryd once the window has closed, and the batch still goes out", async () => {
      const ctx = await setup()
      const { jobId } = await ctx.api.sendReminders({ invoiceIds: [await overdueInvoice(ctx.org.organizationId)], clientRequestId: randomUUID() })
      await ctx.closeWindow()

      await expect(ctx.api.cancelHeld({ jobId })).rejects.toThrow("undo window")

      expect(await ctx.api.release({ jobId })).toMatchObject({ status: expect.stringMatching(/done|pending/) })
      expect(deliver).toHaveBeenCalledTimes(1)
    })

    it("stays held while the countdown is paused, and runs once the time left has passed", async () => {
      const ctx = await setup()
      const { jobId } = await ctx.api.sendReminders({ invoiceIds: [await overdueInvoice(ctx.org.organizationId)], clientRequestId: randomUUID() })

      await ctx.api.holdHeld({ jobId, remainingMs: 2000 + UNDO_HOLD_LEASE_MS })
      const job = await prisma.job.findUniqueOrThrow({ where: { id: jobId } })
      expect(job.runAfter.getTime() - Date.now()).toBeGreaterThan(UNDO_HOLD_LEASE_MS)
      await expect(ctx.api.holdHeld({ jobId, remainingMs: UNDO_WINDOW_MS + UNDO_HOLD_LEASE_MS + 1 })).rejects.toThrow()
      expect(await ctx.sweep()).toMatchObject({ processed: 0 })

      expect(deliver).not.toHaveBeenCalled()

      await ctx.api.holdHeld({ jobId, remainingMs: 0 })
      await ctx.sweep() // the batch and the reminder email it queued
      expect(deliver).toHaveBeenCalledTimes(1)
    })

    it("cannot be taken back or kept held by another organization", async () => {
      const a = await setup(), b = await setup()
      const { jobId } = await a.api.sendReminders({ invoiceIds: [await overdueInvoice(a.org.organizationId)], clientRequestId: randomUUID() })

      await expect(b.api.cancelHeld({ jobId })).rejects.toThrow("undo window")
      await expect(b.api.holdHeld({ jobId, remainingMs: 1000 })).rejects.toThrow("undo window")
      expect(await b.api.held()).toEqual([])
      expect((await a.api.held()).map(job => job.id)).toEqual([jobId])
    })
  })

  describe("invoice send", () => {
    it("survives a reload, waits out the window, then the scheduler sends without a client timer", async () => {
      const ctx = await setup()
      const id = await draftInvoice(ctx)
      const { jobId } = await ctx.api.sendInvoiceLater({ id })
      expect(await ctx.api.sendInvoiceLater({ id })).toEqual({ jobId }) // a second click queues nothing more

      expect(await ctx.caller().held()).toMatchObject([{ id: jobId, type: DELAYED_INVOICE_SEND_JOB, invoiceId: id }])
      await ctx.sweep()
      await ctx.api.release({ jobId })
      expect((await prisma.invoice.findUniqueOrThrow({ where: { id } })).status).toBe("draft")
      expect(deliver).not.toHaveBeenCalled()

      await ctx.closeWindow()
      await ctx.sweep()
      expect((await prisma.job.findUniqueOrThrow({ where: { id: jobId } })).status).toBe("done")
      expect((await prisma.invoice.findUniqueOrThrow({ where: { id } })).status).toMatch(/sent|sending/)
      expect(deliver).toHaveBeenCalledTimes(1)
      expect(vi.mocked(deliver).mock.calls[0]![0]).toMatchObject({ to: "customer@kunde.test" })
      expect(await ctx.api.held()).toEqual([])
    })

    it("is taken back by Fortryd: the draft goes with it and nothing is ever sent", async () => {
      const ctx = await setup()
      const id = await draftInvoice(ctx)
      const { jobId } = await ctx.api.sendInvoiceLater({ id })

      // A freshly loaded tab can still cancel the persisted send and its draft.
      await ctx.caller().cancelHeld({ jobId })

      expect(await prisma.invoice.findUnique({ where: { id } })).toBeNull()
      expect(await prisma.job.findUnique({ where: { id: jobId } })).toBeNull()
      await ctx.closeWindow()
      await ctx.sweep()
      expect(deliver).not.toHaveBeenCalled()
    })

    it("leaves the draft and fails the job when the send is refused after the window", async () => {
      const ctx = await setup()
      const id = await draftInvoice(ctx, null)
      const { jobId } = await ctx.api.sendInvoiceLater({ id })
      await ctx.closeWindow()

      const released = await ctx.api.release({ jobId })

      expect(released.status).toBe("failed")
      expect(released.error).toBeTruthy()
      expect((await prisma.invoice.findUniqueOrThrow({ where: { id } })).status).toBe("draft")
      expect(deliver).not.toHaveBeenCalled()
    })

    it("only queues a draft that belongs to the organization", async () => {
      const a = await setup(), b = await setup()
      const id = await draftInvoice(a)
      await expect(b.api.sendInvoiceLater({ id })).rejects.toThrow("not found")
    })
  })
})
