import { afterEach, describe, expect, it, vi } from "vitest"
import { prisma } from "../../../lib/db"
import { createTestOrganization, hasTestDatabase } from "../../../test-utils/organization"
import { executeCommand } from "../../execute"
import { executeIssuanceCommand } from "../../../application/issuance"
import { createAgreementDraft } from "../../commands/agreements"
import { createInvoiceFromDeliverables } from "../../commands/invoices-from-deliverables"
import { sendInvoice } from "../../commands/invoices"

const cases = [
  { timezone: "Europe/Copenhagen", instant: "2026-07-07T22:30:00Z", day: "2026-07-08", due: "2026-07-22" },
  { timezone: "America/New_York", instant: "2026-11-08T01:00:00Z", day: "2026-11-07", due: "2026-11-21" },
  { timezone: "America/New_York", instant: "2026-03-08T04:30:00Z", day: "2026-03-07", due: "2026-03-21" },
]

;(hasTestDatabase ? describe : describe.skip)("deliverable invoice calendar-date writer", () => {
  const cleanups: Array<() => Promise<void>> = []
  afterEach(async () => { vi.useRealTimers(); while (cleanups.length) await cleanups.pop()?.() })

  it.each(cases)("adds calendar days to $day in $timezone and freezes that due date", async ({ timezone, instant, day, due }) => {
    const org = await createTestOrganization({ settings: { timezone } })
    cleanups.push(org.cleanup)
    const actor = org.actors.admin
    const contact = await prisma.contact.create({ data: { organizationId: org.organizationId, name: "Buyer", email: "buyer@example.test" } })
    const created = await executeCommand(createAgreementDraft, {
      contactId: contact.id, title: "Work", validUntil: "2099-01-01", dueInDays: 14,
      deliverables: [{ title: "Work", quantity: "1", unitPrice: "100" }],
    }, { actor })
    if (created.status !== "completed") throw new Error(JSON.stringify(created))
    const agreement = created.result
    // Accepted commercial terms and accepted work are the preconditions of this writer.
    await prisma.agreement.update({ where: { id: agreement.id }, data: { status: "accepted" } })
    await prisma.deliverable.update({ where: { id: agreement.deliverables[0]!.id }, data: { status: "accepted" } })
    const now = new Date(instant)
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(now)
    const result = await executeCommand(createInvoiceFromDeliverables, {
      agreementId: agreement.id, deliverableIds: [agreement.deliverables[0]!.id],
    }, { actor, now })
    if (result.status !== "completed") throw new Error(JSON.stringify(result))
    const id = result.result.saleInvoiceId!
    const draft = await prisma.invoice.findUniqueOrThrow({ where: { id } })
    expect(draft.issueDate).toEqual(now)
    expect(draft.dueDate.toISOString()).toBe(`${due}T00:00:00.000Z`)
    expect(draft.supplyDate?.toISOString()).toBe(`${day}T00:00:00.000Z`)
    const issued = await executeIssuanceCommand(sendInvoice, { id, allowSendWithoutEmail: true }, { actor, now })
    expect(issued, JSON.stringify(issued)).toMatchObject({ status: "completed" })
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id } })).issuanceSnapshot)
      .toMatchObject({ dueDate: due, supplyDate: day })
  })
})
