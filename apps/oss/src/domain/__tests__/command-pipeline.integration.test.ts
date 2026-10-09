import { Effect } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import { z } from "zod"
import { prisma } from "../../lib/db"
import { createTestOrganization, hasTestDatabase } from "../../test-utils/organization"
import type { AgentActor } from "../actor"
import { authenticateAgentSecret, createAgentKey, hashAgentSecret, revokeAgentKey } from "../agent-keys"
import { defineCommand } from "../command"
import { createContact, deleteContact } from "../commands/contacts"
import { registerTestEventTypes } from "../events/registry"
import { readActivity } from "../events"
import { executeCommand } from "../execute"
import { Command } from "../services"

const describeIfDatabase = hasTestDatabase ? describe : describe.skip

const testTypes = registerTestEventTypes({ "test.pinged": { version: 1, schema: z.object({ message: z.string() }).strict() } })

/** A stand-in for commands that leave the system, e.g. sending an email. */
const pingCustomer = defineCommand({
  type: "test.ping_customer",
  permission: "contact:update",
  outwardFacing: true,
  input: z.object({ message: z.string() }),
  summarize: (input) => `Ping customer: ${input.message}`,
  handle: (input) =>
    Effect.gen(function* () {
      const command = yield* Command
      command.emit({ aggregateType: "test", aggregateId: "ping", type: testTypes["test.pinged"], payload: input })
      return { delivered: true }
    }),
})

describeIfDatabase("command pipeline", () => {
  const cleanups: Array<() => Promise<void>> = []
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()?.()
  })

  async function setup(roles: Array<"admin" | "member" | "accountant"> = ["admin"]) {
    const org = await createTestOrganization({ roles })
    cleanups.push(org.cleanup)
    return org
  }

  it("records events with a per-organization sequence and the acting user", async () => {
    const org = await setup()
    const first = await executeCommand(createContact, { name: "Acme" }, { actor: org.actors.admin })
    const second = await executeCommand(createContact, { name: "Globex" }, { actor: org.actors.admin })
    expect(first.status).toBe("completed")
    expect(second.status).toBe("completed")

    const activity = await readActivity({ organizationId: org.organizationId })
    expect(activity.events.map((event) => [event.sequence, event.type, event.actor.kind])).toEqual([
      [1, "contact.created", "user"],
      [2, "contact.created", "user"],
    ])

    const page = await readActivity({ organizationId: org.organizationId, afterSequence: 1 })
    expect(page.events).toHaveLength(1)
    expect(page.nextSequence).toBe(2)
  })

  it("returns the first outcome when a client request id is retried", async () => {
    const org = await setup()
    const options = { actor: org.actors.admin, clientRequestId: "create-acme-1" }
    const first = await executeCommand(createContact, { name: "Acme" }, options)
    const retry = await executeCommand(createContact, { name: "Acme" }, options)

    expect(retry).toEqual(first)
    expect(await prisma.contact.count({ where: { organizationId: org.organizationId } })).toBe(1)
  })

  it("denies commands outside the actor's role", async () => {
    const org = await setup(["admin", "accountant"])
    const outcome = await executeCommand(createContact, { name: "Acme" }, { actor: org.actors.accountant })

    expect(outcome.status).toBe("failed")
    expect(outcome.status === "failed" && outcome.error.tag).toBe("Forbidden")
    expect(await prisma.contact.count({ where: { organizationId: org.organizationId } })).toBe(0)
  })

  it("rolls back state and events when a handler fails", async () => {
    const org = await setup()
    const created = await executeCommand(createContact, { name: "Acme" }, { actor: org.actors.admin })
    if (created.status !== "completed") throw new Error("setup failed")
    await prisma.invoice.create({
      data: {
        organizationId: org.organizationId,
        contactId: created.result.id,
        number: "INV-0001",
        dueDate: new Date(),
        subtotalNet: 10,
        totalGross: 10,
      },
    })

    const outcome = await executeCommand(deleteContact, { id: created.result.id }, { actor: org.actors.admin })
    expect(outcome.status === "failed" && outcome.error.code).toBe("contact_in_use")
    const activity = await readActivity({ organizationId: org.organizationId })
    expect(activity.events.map((event) => event.type)).toEqual(["contact.created"])
  })

  describe("agents", () => {
    async function agentFor(
      org: Awaited<ReturnType<typeof setup>>,
      mode: AgentActor["mode"],
      scopes: string[] = ["contact:create", "contact:update", "contact:read"]
    ) {
      const { secret, key } = await createAgentKey(org.actors.admin, { name: "Bookkeeper", mode, scopes })
      return { actor: await authenticateAgentSecret(secret), secret, keyId: key.id }
    }

    it("lets full-access agents run commands and labels events with the agent", async () => {
      const org = await setup()
      const { actor } = await agentFor(org, "full_access")
      const outcome = await executeCommand(pingCustomer, { message: "hi" }, { actor, clientRequestId: "p1" })

      expect(outcome).toMatchObject({ status: "completed", result: { delivered: true } })
      const activity = await readActivity({ organizationId: org.organizationId, aggregateType: "test" })
      expect(activity.events[0]?.actor).toMatchObject({ kind: "agent", label: "Agent: Bookkeeper" })
    })

    it("queues outward-facing commands for approval and keeps the queue idempotent", async () => {
      const org = await setup()
      const { actor } = await agentFor(org, "approval_required")

      const draft = await executeCommand(createContact, { name: "Drafted" }, { actor, clientRequestId: "c1" })
      expect(draft.status).toBe("completed")

      const queued = await executeCommand(pingCustomer, { message: "hi" }, { actor, clientRequestId: "p1" })
      const retried = await executeCommand(pingCustomer, { message: "hi" }, { actor, clientRequestId: "p1" })
      expect(queued.status).toBe("awaiting_approval")
      expect(retried).toEqual(queued)

      const requests = await prisma.approvalRequest.findMany({ where: { organizationId: org.organizationId } })
      expect(requests).toHaveLength(1)
      expect(requests[0]).toMatchObject({ summary: "Ping customer: hi", status: "pending" })
    })

    it("runs a queued command once a person approves it", async () => {
      const org = await setup()
      const { actor } = await agentFor(org, "approval_required")
      const queued = await executeCommand(pingCustomer, { message: "hi" }, { actor, clientRequestId: "p1" })
      if (queued.status !== "awaiting_approval") throw new Error("expected approval")

      const approved = await executeCommand(pingCustomer, { message: "hi" }, {
        actor,
        approvedByUserId: org.actors.admin.userId,
        resumeReceiptId: queued.commandId,
      })
      expect(approved).toMatchObject({ status: "completed", commandId: queued.commandId, result: { delivered: true } })
      expect((await prisma.commandReceipt.findUniqueOrThrow({ where: { id: queued.commandId } })).result).toMatchObject({ json: { delivered: true } })

      const retried = await executeCommand(pingCustomer, { message: "hi" }, { actor, clientRequestId: "p1" })
      expect(retried.status).toBe("completed")
      const pinged = await readActivity({ organizationId: org.organizationId, aggregateType: "test" })
      expect(pinged.events[0]?.approvedByUserId).toBe(org.actors.admin.userId)
    })

    it("blocks read-only agents and scopes the agent never received", async () => {
      const org = await setup()
      const readOnly = await agentFor(org, "read_only")
      const narrow = await agentFor(org, "full_access", ["contact:read"])

      for (const actor of [readOnly.actor, narrow.actor]) {
        const outcome = await executeCommand(createContact, { name: "Nope" }, { actor })
        expect(outcome.status === "failed" && outcome.error.tag).toBe("Forbidden")
      }
    })

    it("never lets an agent exceed the role of the person who created it", async () => {
      const org = await setup(["admin", "member"])
      await expect(
        createAgentKey(org.actors.member, { name: "Too much", scopes: ["settings:update"] })
      ).rejects.toMatchObject({ _tag: "Forbidden" })
    })

    it("still accepts keys issued with the pre-rename yaip_ak_ prefix", async () => {
      const org = await setup()
      const { secret, keyId } = await agentFor(org, "full_access")
      expect(secret).toMatch(/^quits_ak_/)
      const legacy = `yaip_ak_${secret.slice("quits_ak_".length)}`
      await prisma.agentKey.update({ where: { id: keyId }, data: { secretHash: hashAgentSecret(legacy) } })

      await expect(authenticateAgentSecret(legacy)).resolves.toMatchObject({ agentKeyId: keyId })
    })

    it("rejects revoked keys", async () => {
      const org = await setup()
      const { secret, keyId } = await agentFor(org, "full_access")
      await revokeAgentKey(org.actors.admin, keyId)

      await expect(authenticateAgentSecret(secret)).rejects.toMatchObject({ _tag: "Forbidden" })
      await expect(authenticateAgentSecret("yaip_ak_not-a-real-key")).rejects.toMatchObject({
        _tag: "Forbidden",
      })
    })
  })
})
