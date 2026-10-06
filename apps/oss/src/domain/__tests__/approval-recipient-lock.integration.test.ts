import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("../../lib/email", async () => {
  const actual = await vi.importActual<typeof import("../../lib/email")>("../../lib/email")
  return { ...actual, deliver: vi.fn() }
})

import { prisma } from "../../lib/db"
import { deliver } from "../../lib/email"
import { retryEmailDeliveries } from "../../test-utils/email-outbox"
import { createTestOrganization, hasTestDatabase } from "../../test-utils/organization"
import { authenticateAgentSecret, createAgentKey } from "../agent-keys"
import { decideApproval } from "../approvals"
import { createContact, updateContact } from "../commands/contacts"
import { createInvoiceDraft, sendInvoice } from "../commands/invoices"
import { executeCommand } from "../execute"

const describeIfDatabase = hasTestDatabase ? describe : describe.skip

describeIfDatabase("approved sends and recipient changes", () => {
  const cleanups: Array<() => Promise<void>> = []
  afterEach(async () => {
    vi.mocked(deliver).mockReset()
    vi.unstubAllEnvs()
    while (cleanups.length) await cleanups.pop()?.()
  })

  it("delivers the email queued at approval even if the contact changes before delivery", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test")
    vi.stubEnv("FROM_EMAIL", "billing@example.com")
    const org = await createTestOrganization()
    cleanups.push(org.cleanup)
    const contact = await executeCommand(
      createContact,
      { name: "Acme", email: "approved@example.test" },
      { actor: org.actors.admin }
    )
    if (contact.status !== "completed") throw new Error("contact setup failed")
    const draft = await executeCommand(
      createInvoiceDraft,
      {
        contactId: contact.result.id,
        dueDate: "2099-12-01",
        taxRate: 0,
        items: [{ description: "Design", quantity: 1, unitPrice: 100 }],
      },
      { actor: org.actors.admin }
    )
    if (draft.status !== "completed") throw new Error("draft setup failed")

    const { secret } = await createAgentKey(org.actors.admin, {
      name: "Sender",
      mode: "approval_required",
      scopes: ["invoice:send", "invoice:read"],
    })
    const agent = await authenticateAgentSecret(secret)
    const queued = await executeCommand(sendInvoice, { id: draft.result.id }, { actor: agent, clientRequestId: "s1" })
    if (queued.status !== "awaiting_approval") throw new Error("expected approval")

    // The contact's email changes after the approved send committed but before the provider
    // confirms delivery; the first attempt's outcome is unknown, so it is retried.
    let contactChange: { status: string } | null = null
    vi.mocked(deliver).mockImplementationOnce(async () => {
      contactChange = await executeCommand(
        updateContact,
        { id: contact.result.id, email: "attacker@example.test" },
        { actor: org.actors.admin }
      )
      throw new Error("socket hang up")
    })
    vi.mocked(deliver).mockResolvedValue({ id: "email_1" })

    const approval = await decideApproval({
      approvalRequestId: queued.approvalRequestId,
      decider: org.actors.admin,
      decision: "approve",
    })
    expect(approval).toMatchObject({ status: "completed" })
    expect(contactChange).toMatchObject({ status: "completed" })
    expect(await prisma.contact.findUniqueOrThrow({ where: { id: contact.result.id } })).toMatchObject({
      email: "attacker@example.test",
    })

    await retryEmailDeliveries(org.organizationId)

    // Both attempts deliver the message rendered at approval, to the reviewed recipient.
    const calls = vi.mocked(deliver).mock.calls
    expect(calls).toHaveLength(2)
    expect(calls[0]?.[0]).toMatchObject({ to: "approved@example.test" })
    expect(calls[1]).toEqual(calls[0])
    expect(await prisma.invoice.findUniqueOrThrow({ where: { id: draft.result.id } })).toMatchObject({
      status: "sent",
      lastEmailAttemptOutcome: "sent",
    })
    const [sentEvent] = await prisma.domainEvent.findMany({
      where: { organizationId: org.organizationId, type: "invoice.sent", aggregateId: draft.result.id },
    })
    expect(sentEvent?.payload).toMatchObject({ recipient: "approved@example.test", emailSent: true })
  })
})
