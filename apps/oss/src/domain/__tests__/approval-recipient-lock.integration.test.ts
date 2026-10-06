import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("../../lib/email", async () => {
  const actual = await vi.importActual<typeof import("../../lib/email")>("../../lib/email")
  return { ...actual, sendInvoiceEmail: vi.fn() }
})

import { sendInvoiceEmail } from "../../lib/email"
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
    vi.mocked(sendInvoiceEmail).mockReset()
    vi.unstubAllEnvs()
    while (cleanups.length) await cleanups.pop()?.()
  })

  it("keeps the reviewed recipient while an approved send is delivering", async () => {
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

    let releaseDelivery: () => void = () => undefined
    const deliveryStarted = new Promise<void>((started) => {
      vi.mocked(sendInvoiceEmail).mockImplementation(
        () =>
          new Promise((resolve) => {
            started()
            releaseDelivery = () => resolve({ id: "email_1" })
          })
      )
    })

    const approval = decideApproval({
      approvalRequestId: queued.approvalRequestId,
      decider: org.actors.admin,
      decision: "approve",
    })
    await deliveryStarted

    let contactChanged = false
    const change = executeCommand(
      updateContact,
      { id: contact.result.id, email: "attacker@example.test" },
      { actor: org.actors.admin }
    ).then((outcome) => {
      contactChanged = true
      return outcome
    })

    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(contactChanged).toBe(false)

    releaseDelivery()
    await expect(approval).resolves.toMatchObject({ status: "completed" })
    await expect(change).resolves.toMatchObject({ status: "completed" })
    expect(sendInvoiceEmail).toHaveBeenCalledTimes(1)
    expect(vi.mocked(sendInvoiceEmail).mock.calls[0]?.[0]).toMatchObject({ to: "approved@example.test" })
  })
})
