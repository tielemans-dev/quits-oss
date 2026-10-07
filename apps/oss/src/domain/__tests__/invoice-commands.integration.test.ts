import { executeIssuanceCommand } from "../../application/issuance"
import { afterEach, describe, expect, it } from "vitest"
import { createTestOrganization, hasTestDatabase } from "../../test-utils/organization"
import { createContact } from "../commands/contacts"
import { createInvoiceDraft, sendInvoice } from "../commands/invoices"
import { readActivity } from "../events"


const describeIfDatabase = hasTestDatabase ? describe : describe.skip

describeIfDatabase("invoice commands", () => {
  const cleanups: Array<() => Promise<void>> = []
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()?.()
  })

  async function setupWithContact() {
    const org = await createTestOrganization()
    cleanups.push(org.cleanup)
    const contact = await executeIssuanceCommand(
      createContact,
      { name: "Acme", email: "billing@acme.test" },
      { actor: org.actors.admin }
    )
    if (contact.status !== "completed") throw new Error("contact setup failed")
    return { org, contactId: contact.result.id }
  }

  const draft = (contactId: string) => ({
    contactId,
    dueDate: "2026-12-01",
    taxRate: 25,
    items: [{ description: "Design", quantity: 2, unitPrice: 100 }],
  })

  it("allocates unique sequential numbers under concurrent creates", async () => {
    const { org, contactId } = await setupWithContact()
    const outcomes = await Promise.all(
      Array.from({ length: 6 }, () =>
        executeIssuanceCommand(createInvoiceDraft, draft(contactId), { actor: org.actors.admin })
      )
    )

    const numbers = outcomes.map((outcome) => {
      if (outcome.status !== "completed") throw new Error(JSON.stringify(outcome))
      return outcome.result.number
    })
    expect(new Set(numbers).size).toBe(6)
    expect([...numbers].sort()).toEqual([
      "INV-0001",
      "INV-0002",
      "INV-0003",
      "INV-0004",
      "INV-0005",
      "INV-0006",
    ])
  })

  it("prices drafts and records the lifecycle in the activity log", async () => {
    const { org, contactId } = await setupWithContact()
    const created = await executeIssuanceCommand(createInvoiceDraft, draft(contactId), { actor: org.actors.admin })
    if (created.status !== "completed") throw new Error("create failed")
    expect(created.result.totalGross.toNumber()).toBe(250)

    const sent = await executeIssuanceCommand(
      sendInvoice,
      { id: created.result.id, allowSendWithoutEmail: true },
      { actor: org.actors.admin }
    )
    expect(sent).toMatchObject({ status: "completed", result: { status: "sent" } })

    const activity = await readActivity({
      organizationId: org.organizationId,
      aggregateType: "invoice",
      aggregateId: created.result.id,
    })
    expect(activity.events.map((event) => event.type)).toEqual(["invoice.draft_created", "invoice.sent", "invoice.issued"])
  })
})
