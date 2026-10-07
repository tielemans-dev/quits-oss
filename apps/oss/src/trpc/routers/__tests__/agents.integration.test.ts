import { afterEach, describe, expect, it } from "vitest"
import { authenticateAgentSecret, createAgentKey } from "../../../domain/agent-keys"
import { runAgentTool } from "../../../domain/agent-tools/mcp"
import { createContact } from "../../../domain/commands/contacts"
import { createInvoiceDraft, sendInvoice } from "../../../domain/commands/invoices"
import { executeCommand } from "../../../domain/execute"
import { prisma } from "../../../lib/db"
import { createTestOrganization, hasTestDatabase } from "../../../test-utils/organization"
import { appRouter } from "../../router"

const describeIfDatabase = hasTestDatabase ? describe : describe.skip

type Role = "admin" | "member" | "accountant"
type Org = Awaited<ReturnType<typeof createTestOrganization>>

function callerFor(org: Org, role: Role) {
  const userId = org.actors[role].userId
  return appRouter.createCaller({
    session: {
      user: { id: userId, email: `${userId}@test.quits.invalid`, name: userId },
      session: { activeOrganizationId: org.organizationId },
    },
  } as never)
}

describeIfDatabase("agents router", () => {
  const cleanups: Array<() => Promise<void>> = []
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()?.()
  })

  async function setup(roles: Role[]) {
    const org = await createTestOrganization({ roles })
    cleanups.push(org.cleanup)
    return org
  }

  /** Queues an invoice send from an approval_required agent. */
  async function queueSend(org: Org) {
    const contact = await executeCommand(
      createContact,
      { name: "Acme", email: "billing@acme.test" },
      { actor: org.actors.admin }
    )
    if (contact.status !== "completed") throw new Error("contact setup failed")
    const draft = await executeCommand(
      createInvoiceDraft,
      {
        contactId: contact.result.id,
        dueDate: "2026-12-01",
        items: [{ description: "Design", quantity: 1, unitPrice: 100 }],
      },
      { actor: org.actors.admin }
    )
    if (draft.status !== "completed") throw new Error("draft setup failed")

    const { secret } = await createAgentKey(org.actors.admin, {
      name: "Sender",
      mode: "approval_required",
      scopes: ["invoice:read", "invoice:send"],
    })
    const agent = await authenticateAgentSecret(secret)
    const queued = await executeCommand(
      sendInvoice,
      { id: draft.result.id, allowSendWithoutEmail: true },
      { actor: agent, clientRequestId: "send-1" }
    )
    if (queued.status !== "awaiting_approval") throw new Error("expected approval")
    return { ...queued, invoiceId: draft.result.id }
  }

  describe("agent keys", () => {
    it("lets admins create, list, and revoke keys and shows the secret only once", async () => {
      const org = await setup(["admin"])
      const admin = callerFor(org, "admin")

      const created = await admin.agents.createKey({
        name: "Bookkeeper",
        mode: "read_only",
        scopes: ["invoice:read", "contact:read"],
        expiresInDays: 30,
      })
      expect(created.secret).toMatch(/^quits_ak_/)
      expect(created.key.displayPrefix).toBe(created.secret.slice(0, created.key.displayPrefix.length))
      expect(created.key.expiresAt).toBeInstanceOf(Date)

      const [listed] = await admin.agents.listKeys()
      expect(listed).toMatchObject({ id: created.key.id, mode: "read_only", createdByName: org.actors.admin.userId })
      expect(JSON.stringify(listed)).not.toContain(created.secret)

      await admin.agents.revokeKey({ id: created.key.id })
      const [revoked] = await admin.agents.listKeys()
      expect(revoked?.revokedAt).toBeInstanceOf(Date)
      // Revoking again is safe: it finishes any cleanup an interrupted revocation left behind.
      await expect(admin.agents.revokeKey({ id: created.key.id })).resolves.toBeTruthy()
      await expect(admin.agents.revokeKey({ id: "does-not-exist" })).rejects.toMatchObject({
        code: "NOT_FOUND",
      })
    })

    it("keeps key management to roles that hold agent permissions", async () => {
      const org = await setup(["admin", "member", "accountant"])
      const member = callerFor(org, "member")

      const access = await member.agents.access()
      expect(access).toMatchObject({ canRead: false, canCreate: false, canRevoke: false })
      expect(access.grantableScopes).toContain("invoice:send")
      expect(access.grantableScopes).not.toContain("invoice:delete")

      await expect(member.agents.listKeys()).rejects.toMatchObject({ code: "FORBIDDEN" })
      await expect(
        member.agents.createKey({ name: "x", mode: "full_access", scopes: ["invoice:read"] })
      ).rejects.toMatchObject({ code: "FORBIDDEN" })
      await expect(callerFor(org, "accountant").agents.revokeKey({ id: "x" })).rejects.toMatchObject({
        code: "FORBIDDEN",
      })
    })

    it("refuses agent management scopes and scopes beyond the creator", async () => {
      const org = await setup(["admin"])
      const admin = callerFor(org, "admin")
      await expect(
        admin.agents.createKey({ name: "x", mode: "full_access", scopes: ["agent:create"] })
      ).rejects.toMatchObject({ code: "BAD_REQUEST" })
      await expect(
        admin.agents.createKey({ name: "x", mode: "full_access", scopes: ["not:a-scope"] })
      ).rejects.toMatchObject({ code: "BAD_REQUEST" })
    })
  })

  describe("approvals", () => {
    it("only lets people holding the command's permission decide", async () => {
      const org = await setup(["admin", "member", "accountant"])
      const queued = await queueSend(org)
      const accountant = callerFor(org, "accountant")

      const [pending] = await accountant.agents.approvals({ view: "pending" })
      expect(pending).toMatchObject({
        commandType: "invoice.send",
        canDecide: false,
        requiredPermission: "invoice:send",
      })
      for (const decision of ["approve", "reject"] as const) {
        await expect(
          accountant.agents.decide({ approvalRequestId: queued.approvalRequestId, decision })
        ).rejects.toMatchObject({ code: "FORBIDDEN" })
      }

      const member = callerFor(org, "member")
      const rejected = await member.agents.decide({
        approvalRequestId: queued.approvalRequestId,
        decision: "reject",
        note: "Wrong amount",
      })
      expect(rejected).toMatchObject({
        status: "rejected",
        commandId: queued.commandId,
        error: { tag: "Rejected", message: "Wrong amount" },
      })

      const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: queued.invoiceId } })
      expect(invoice.status).toBe("draft")
      const [history] = await member.agents.approvals({ view: "history" })
      expect(history).toMatchObject({ status: "rejected", commandStatus: "rejected", decidedByName: org.actors.member.userId })

      // Deciding again returns the settled outcome instead of running anything.
      const again = await callerFor(org, "admin").agents.decide({
        approvalRequestId: queued.approvalRequestId,
        decision: "approve",
      })
      expect(again.status).toBe("rejected")
    })

    it("hides other organizations' requests", async () => {
      const org = await setup(["admin"])
      const other = await setup(["admin"])
      const queued = await queueSend(org)

      const outsider = callerFor(other, "admin")
      expect(await outsider.agents.approvals({ view: "pending" })).toEqual([])
      await expect(
        outsider.agents.decide({ approvalRequestId: queued.approvalRequestId, decision: "approve" })
      ).rejects.toMatchObject({ code: "NOT_FOUND" })
    })
  })

  it("rejects hidden tools when an agent calls them directly", async () => {
    const org = await setup(["admin"])
    const { secret } = await createAgentKey(org.actors.admin, {
      name: "Reader",
      mode: "read_only",
      scopes: ["contact:read", "contact:create"],
    })
    const agent = await authenticateAgentSecret(secret)

    const result = await runAgentTool(agent, "contact_create", { name: "Nope", clientRequestId: "c-1" })
    expect(result).toEqual({
      ok: false,
      error: {
        tag: "Forbidden",
        message: "This agent key is read-only and cannot call contact_create",
      },
    })
    expect(await runAgentTool(agent, "invoices_list", {})).toMatchObject({
      ok: false,
      error: { tag: "Forbidden" },
    })
  })
})
