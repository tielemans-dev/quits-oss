import { randomUUID } from "node:crypto"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
vi.mock("../../../lib/email", async () => {
  const actual = await vi.importActual<typeof import("../../../lib/email")>("../../../lib/email")
  return { ...actual, deliver: vi.fn().mockResolvedValue({ id: "email-fixture" }) }
})
import { prisma } from "../../../lib/db"
import { deliver } from "../../../lib/email"
import { createTestOrganization, hasTestDatabase } from "../../../test-utils/organization"
import { EMAIL_DELIVERY_JOB, settleAbandonedDeliveries } from "../../delivery/outbox"
import "../../documents/document-delivery"
import { MANUAL_REMINDER_PREFIX } from "../../commands/reminders"
import { runDueJobs } from "../../jobs"
import { eventDefinition } from "../registry"

const describeIfDatabase = hasTestDatabase ? describe : describe.skip
const completions = ["invoice.send", "invoice.email", "quote.send", "quote.email", "creditNote.send", "creditNote.email", "agreement.send", "agreement.email", "reminder"] as const
const outcomes = ["delivered", "rejected", "unconfirmed", "withdrawn", "abandoned", "abandoned_accepted", "legacy_abandoned"] as const

describeIfDatabase("delivery completion with strict event registry", () => {
  const cleanups: Array<() => Promise<void>> = []
  const env = { RESEND_API_KEY: process.env.RESEND_API_KEY, FROM_EMAIL: process.env.FROM_EMAIL }
  beforeEach(() => {
    process.env.RESEND_API_KEY = "test-only"
    process.env.FROM_EMAIL = "sender@example.test"
    vi.mocked(deliver).mockClear()
  })
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()?.()
    if (env.RESEND_API_KEY === undefined) delete process.env.RESEND_API_KEY
    else process.env.RESEND_API_KEY = env.RESEND_API_KEY
    if (env.FROM_EMAIL === undefined) delete process.env.FROM_EMAIL
    else process.env.FROM_EMAIL = env.FROM_EMAIL
  })

  for (const completion of completions) for (const outcome of outcomes) {
    it(`${completion}: ${outcome} settles and appends a valid v1 event`, async () => {
      const org = await createTestOrganization()
      cleanups.push(org.cleanup)
      const at = new Date()
      const contact = await prisma.contact.create({ data: { organizationId: org.organizationId, name: "Customer", email: "customer@example.test" } })
      const base = { organizationId: org.organizationId, contactId: contact.id, number: "DOC-1", subtotalNet: 100, totalGross: 100 }
      const marker = { lastEmailAttemptAt: at, lastEmailAttemptOutcome: "sending" }
      const [kind, mode] = completion.split(".")
      const status = mode === "send" ? "draft" : "sent"
      const invoice = await prisma.invoice.create({ data: { ...base, dueDate: at, ...(kind === "invoice" ? { ...marker, status } : kind === "reminder" ? { status: "sent" } : {}) } })
      let documentId = invoice.id
      let readDocument: () => Promise<{ status: string; lastEmailAttemptOutcome: string | null }> = () => prisma.invoice.findUniqueOrThrow({ where: { id: documentId } })
      if (kind === "quote") {
        documentId = (await prisma.quote.create({ data: { ...base, ...marker, status, expiryDate: at } })).id
        readDocument = () => prisma.quote.findUniqueOrThrow({ where: { id: documentId } })
      } else if (kind === "creditNote") {
        documentId = (await prisma.creditNote.create({ data: { ...base, ...marker, status, invoiceId: invoice.id, reason: "Correction", currency: "USD", countryCode: "US", locale: "en-US", timezone: "UTC", taxRegime: "us_sales_tax" } })).id
        readDocument = () => prisma.creditNote.findUniqueOrThrow({ where: { id: documentId } })
      } else if (kind === "agreement") {
        documentId = (await prisma.agreement.create({ data: { ...base, ...marker, status, title: "Website", termsMarkdown: "Terms", validUntil: at } })).id
        readDocument = () => prisma.agreement.findUniqueOrThrow({ where: { id: documentId } })
      }
      const target: Record<string, string> = { documentId, attemptAt: at.toISOString(), number: "DOC-1", recipient: "customer@example.test" }
      if (kind === "reminder") {
        const reminder = await prisma.invoiceReminder.create({ data: { invoiceId: invoice.id, offsetDays: 7, scheduledFor: at, sentAt: at, outcome: "sending", outcomeMessage: `${MANUAL_REMINDER_PREFIX}Fixture` } })
        Object.assign(target, { reminderId: reminder.id, invoiceId: invoice.id, manual: "true", offsetDays: "7", balanceDue: "100" })
      }
      const abandoned = outcome.startsWith("abandoned") || outcome === "legacy_abandoned"
      const key = randomUUID()
      const job = await prisma.job.create({ data: {
        organizationId: org.organizationId, type: EMAIL_DELIVERY_JOB, dedupeKey: key,
        status: abandoned ? "failed" : "pending", attempts: abandoned ? 5 : 0,
        payload: {
          message: { from: "sender@example.test", to: "customer@example.test", subject: "Fixture", html: "Fixture" },
          idempotencyKey: key, completion: { kind: completion, target }, actor: org.actors.admin,
          commandId: "fixture-command", approvedByUserId: null,
          ...(outcome !== "legacy_abandoned" ? { requests: abandoned ? 1 : 0 } : {}),
          ...(outcome === "abandoned_accepted" ? { providerMessageId: "email-already-accepted" } : {}),
          ...(["rejected", "unconfirmed", "withdrawn"].includes(outcome) ? { decision: { reason: outcome, message: "Fixture outcome" } } : {}),
        },
      } })
      if (abandoned) expect(await settleAbandonedDeliveries({ organizationIds: [org.organizationId] })).toMatchObject({ abandoned: 1, settled: 1, failed: 0 })
      else await runDueJobs({ organizationIds: [org.organizationId] })
      const expectedOutcome = outcome === "abandoned_accepted" ? "delivered" : abandoned ? "unconfirmed" : outcome
      expect((await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).result).toMatchObject({ outcome: expectedOutcome })
      const events = await prisma.domainEvent.findMany({ where: { organizationId: org.organizationId } })
      expect(events).toHaveLength(1)
      const event = events[0]
      expect(event.schemaVersion).toBe(1)
      expect(eventDefinition(event.type)?.schema.safeParse(event.payload).success).toBe(true)
      const aggregate = kind === "creditNote" ? "credit_note" : kind
      const suffix = expectedOutcome === "delivered" ? mode === "email" && kind !== "creditNote" ? "email_resent" : "sent" : expectedOutcome === "unconfirmed" ? "email_unconfirmed" : "email_failed"
      expect(event.type).toBe(kind === "reminder" ? `invoice.reminder_${expectedOutcome === "delivered" ? "sent" : expectedOutcome === "withdrawn" ? "skipped" : expectedOutcome === "rejected" ? "failed" : "unconfirmed"}` : `${aggregate}.${suffix}`)
      if (kind !== "reminder") {
        const document = await readDocument()
        expect(document.lastEmailAttemptOutcome).toBe(expectedOutcome === "delivered" ? "sent" : expectedOutcome === "unconfirmed" ? "unconfirmed" : "failed")
        expect(document.status).toBe(mode === "send" && ["delivered", "unconfirmed"].includes(expectedOutcome) ? "sent" : status)
      }
      expect(deliver).toHaveBeenCalledTimes(outcome === "delivered" ? 1 : 0)
    })
  }
})
