import { randomUUID } from "node:crypto"
import { afterEach, describe, expect, it } from "vitest"
import { prisma } from "../../lib/db"
import { createTestOrganization, hasTestDatabase } from "../../test-utils/organization"
import { actorKey } from "../actor"
import { authenticateAgentSecret, createAgentKey } from "../agent-keys"
import { decideApproval } from "../approvals"

const describeIfDatabase = hasTestDatabase ? describe : describe.skip

// MOCK: register facts an agent made up; 24256790 passes the CVR check digit.
const forged = { cvr: "24256790", legalName: "Forged A/S", secondaryNames: ["Forged Café"], address: "Falskvej 1", zip: "8000", city: "Aarhus C" }

describeIfDatabase("approved agent requests and the CVR register", () => {
  const cleanups: Array<() => Promise<void>> = []
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()?.()
  })

  /** Stores a request as the approval queue would, with whatever command input the agent chose. */
  async function approveStored(commandType: string, command: object) {
    const org = await createTestOrganization({ roles: ["admin"] })
    cleanups.push(org.cleanup)
    const { secret, key } = await createAgentKey(org.actors.admin, { name: "Bookkeeper", mode: "approval_required", scopes: ["contact:create", "contact:update", "contact:read"] })
    const agent = await authenticateAgentSecret(secret)
    const receipt = await prisma.commandReceipt.create({
      data: { organizationId: org.organizationId, actorKey: actorKey(agent), clientRequestId: randomUUID(), commandType, status: "awaiting_approval" },
    })
    const request = await prisma.approvalRequest.create({
      data: { organizationId: org.organizationId, agentKeyId: key.id, commandReceiptId: receipt.id, commandType, command, summary: "Agent request", expiresAt: new Date(Date.now() + 60_000) },
    })
    const decide = () => decideApproval({ approvalRequestId: request.id, decider: org.actors.admin, decision: "approve" })
    return { org, decide }
  }

  it("creates an ordinary customer and drops register facts the agent supplied", async () => {
    const { org, decide } = await approveStored("contact.create", { name: "Mette Jensen", company: "Typed ApS", taxId: "24256790", country: "DK", registry: forged })
    expect(await decide()).toMatchObject({ status: "completed" })
    const contact = await prisma.contact.findFirstOrThrow({ where: { organizationId: org.organizationId } })
    expect(contact).toMatchObject({ name: "Mette Jensen", company: "Typed ApS", registrySource: null, legalName: null, registrySecondaryNames: [], registeredAddress: null })
  })

  it("never refreshes a customer's register identity from stored input", async () => {
    const { org, decide } = await approveStored("contact.registry_refresh", { id: "placeholder", registry: forged })
    const contact = await prisma.contact.create({ data: { organizationId: org.organizationId, name: "Register A/S", company: "Register A/S", taxId: "24256790", country: "DK", registrySource: "cvr", legalName: "Register A/S" } })
    await prisma.approvalRequest.updateMany({ where: { organizationId: org.organizationId }, data: { command: { id: contact.id, registry: forged } } })
    await expect(decide()).rejects.toMatchObject({ code: "unknown_command" })
    expect(await prisma.contact.findUniqueOrThrow({ where: { id: contact.id } })).toMatchObject({ company: "Register A/S", legalName: "Register A/S", registeredAddress: null })
  })
})
