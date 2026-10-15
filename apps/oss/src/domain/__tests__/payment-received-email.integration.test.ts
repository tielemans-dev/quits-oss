import { executeIssuanceCommand } from "../../application/issuance"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../../lib/email", async () => {
  const actual = await vi.importActual<typeof import("../../lib/email")>("../../lib/email")
  return { ...actual, deliver: vi.fn().mockResolvedValue({ id: "email_123" }) }
})

import { prisma } from "../../lib/db"
import { deliver } from "../../lib/email"
import { findEmailDeliveryJobs } from "../../test-utils/email-outbox"
import { createTestOrganization, hasTestDatabase } from "../../test-utils/organization"
import { createContact } from "../commands/contacts"
import { createInvoiceDraft, sendInvoice } from "../commands/invoices"
import { markInvoicePaid } from "../commands/paid-moment"
import { recordPayment, recordStripeCheckoutPayment } from "../commands/payments"
import { runDueJobs } from "../jobs"
import "../delivery/outbox"

const describeIfDatabase = hasTestDatabase ? describe : describe.skip

describeIfDatabase("payment received emails", () => {
  const cleanups: Array<() => Promise<void>> = []
  const previousEnv = { RESEND_API_KEY: process.env.RESEND_API_KEY, FROM_EMAIL: process.env.FROM_EMAIL }

  beforeEach(() => {
    process.env.RESEND_API_KEY = "resend_test_key"
    process.env.FROM_EMAIL = "billing@example.com"
    vi.mocked(deliver).mockReset()
    vi.mocked(deliver).mockResolvedValue({ id: "email_123" })
  })

  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()?.()
    process.env.RESEND_API_KEY = previousEnv.RESEND_API_KEY
    process.env.FROM_EMAIL = previousEnv.FROM_EMAIL
  })

  /** One sent invoice totalling 250.00 (200 + 25% tax). */
  async function setup(options: { locale?: string; currency?: string; contactEmail?: string | null } = {}) {
    const org = await createTestOrganization({
      roles: ["admin"],
      settings: { locale: options.locale, currency: options.currency ?? "USD", timezone: "Europe/Copenhagen", companyName: "Acme ApS", companyEmail: "seller@acme.test" },
    })
    cleanups.push(org.cleanup)
    const contact = await executeIssuanceCommand(
      createContact,
      { name: "Kunde & Co", email: "customer@kunde.test" },
      { actor: org.actors.admin }
    )
    if (contact.status !== "completed") throw new Error("contact setup failed")
    const draft = await executeIssuanceCommand(
      createInvoiceDraft,
      { contactId: contact.result.id, dueDate: "2099-12-01", currency: options.currency, taxRate: 25, items: [{ description: "Design", quantity: 2, unitPrice: 100 }] },
      { actor: org.actors.admin }
    )
    if (draft.status !== "completed") throw new Error("draft setup failed")
    const sent = await executeIssuanceCommand(sendInvoice, { id: draft.result.id, allowSendWithoutEmail: true }, { actor: org.actors.admin })
    if (sent.status !== "completed") throw new Error(`send setup failed: ${JSON.stringify(sent)}`)
    // The invoice email itself is not under test; deliver it so only payment emails remain queued.
    await runDueJobs({ organizationIds: [org.organizationId] })
    vi.mocked(deliver).mockClear()
    return { org, invoiceId: draft.result.id }
  }

  const webhook = (organizationId: string) =>
    ({ kind: "system", organizationId, reason: "stripe_webhook", label: "Stripe" }) as const

  const stripePayment = (invoiceId: string, session: string, amount: number, currency = "usd") => ({
    invoiceId, checkoutSessionId: session, paymentIntentId: `pi_${session}`, amount, currency, paidAt: "2026-06-01T22:30:00.000Z",
  })

  /** The payment emails queued so far; the invoice's own email is delivered during setup. */
  const queuedPaymentEmails = async (organizationId: string) =>
    (await findEmailDeliveryJobs(organizationId)).filter((job) => job.dedupeKey?.startsWith("email:payment-received-"))

  /** Messages handed to the provider since the last call; the commit already ran the queued jobs. */
  async function sentMessages(organizationId: string) {
    await runDueJobs({ organizationIds: [organizationId] })
    const messages = vi.mocked(deliver).mock.calls.map(([message]) => message)
    vi.mocked(deliver).mockClear()
    return messages
  }

  it("emails the customer and the seller once when a Stripe payment pays the invoice", async () => {
    const { org, invoiceId } = await setup({ locale: "en-US" })
    const outcome = await executeIssuanceCommand(recordStripeCheckoutPayment, stripePayment(invoiceId, "cs_1", 250), { actor: webhook(org.organizationId) })
    expect(outcome.status).toBe("completed")

    const messages = await sentMessages(org.organizationId)
    expect(messages.map((message) => message.to).sort()).toEqual(["customer@kunde.test", "seller@acme.test"])
    const client = messages.find((message) => message.to === "customer@kunde.test")!
    const seller = messages.find((message) => message.to === "seller@acme.test")!
    expect(client.subject).toMatch(/^Payment received for invoice /)
    expect(client.html).toContain("Acme ApS has received your payment")
    expect(client.html).toContain("$250.00")
    expect(client.html).toContain("June 2, 2026")
    expect(seller.subject).toMatch(/^Kunde & Co paid invoice /)
  })

  it("sends nothing more when the webhook is delivered again", async () => {
    const { org, invoiceId } = await setup()
    const input = stripePayment(invoiceId, "cs_retry", 250)
    await executeIssuanceCommand(recordStripeCheckoutPayment, input, { actor: webhook(org.organizationId) })
    await executeIssuanceCommand(recordStripeCheckoutPayment, input, { actor: webhook(org.organizationId) })

    const keys = (await queuedPaymentEmails(org.organizationId)).map((job) => job.dedupeKey)
    expect(keys).toHaveLength(2)
    expect(new Set(keys).size).toBe(2)
    expect(await sentMessages(org.organizationId)).toHaveLength(2)
    await executeIssuanceCommand(recordStripeCheckoutPayment, input, { actor: webhook(org.organizationId) })
    expect(await sentMessages(org.organizationId)).toHaveLength(0)
  })

  it("writes both emails in the Danish document locale", async () => {
    const { org, invoiceId } = await setup({ locale: "da-DK", currency: "DKK" })
    await executeIssuanceCommand(recordStripeCheckoutPayment, stripePayment(invoiceId, "cs_da", 250, "dkk"), { actor: webhook(org.organizationId) })

    const messages = await sentMessages(org.organizationId)
    expect(messages).toHaveLength(2)
    const client = messages.find((message) => message.to === "customer@kunde.test")!
    expect(client.subject).toMatch(/^Betaling modtaget for faktura /)
    expect(client.html).toContain("har modtaget din betaling")
    expect(client.html).toContain("2. juni 2026")
    expect(messages.find((message) => message.to === "seller@acme.test")!.subject).toMatch(/^Kunde & Co har betalt faktura /)
  })

  it("waits for the invoice to be paid in full", async () => {
    const { org, invoiceId } = await setup()
    await executeIssuanceCommand(recordStripeCheckoutPayment, stripePayment(invoiceId, "cs_part", 100), { actor: webhook(org.organizationId) })
    expect(await queuedPaymentEmails(org.organizationId)).toHaveLength(0)

    await executeIssuanceCommand(recordStripeCheckoutPayment, stripePayment(invoiceId, "cs_rest", 150), { actor: webhook(org.organizationId) })
    const messages = await sentMessages(org.organizationId)
    expect(messages).toHaveLength(2)
    expect(messages.find((message) => message.to === "customer@kunde.test")!.html).toContain("$150.00")
  })

  it("tells only the seller about a payment recorded by hand", async () => {
    const { org, invoiceId } = await setup()
    await executeIssuanceCommand(recordPayment, { invoiceId, amount: 100, paidAt: "2026-06-01", method: "bank_transfer" }, { actor: org.actors.admin })
    expect(await queuedPaymentEmails(org.organizationId)).toHaveLength(0)

    await executeIssuanceCommand(recordPayment, { invoiceId, amount: 150, paidAt: "2026-06-02", method: "bank_transfer" }, { actor: org.actors.admin })
    const messages = await sentMessages(org.organizationId)
    expect(messages.map((message) => message.to)).toEqual(["seller@acme.test"])
  })

  it("tells only the seller about an invoice marked paid", async () => {
    const { org, invoiceId } = await setup()
    await executeIssuanceCommand(markInvoicePaid, { invoiceId, requestId: crypto.randomUUID() }, { actor: org.actors.admin })
    const messages = await sentMessages(org.organizationId)
    expect(messages.map((message) => message.to)).toEqual(["seller@acme.test"])
  })

  it("skips a customer without a valid address and still tells the seller", async () => {
    const { org, invoiceId } = await setup()
    await prisma.contact.updateMany({ where: { organizationId: org.organizationId }, data: { email: "not-an-address" } })
    await executeIssuanceCommand(recordStripeCheckoutPayment, stripePayment(invoiceId, "cs_noemail", 250), { actor: webhook(org.organizationId) })
    expect((await sentMessages(org.organizationId)).map((message) => message.to)).toEqual(["seller@acme.test"])
  })

  it("queues nothing where this installation cannot send email", async () => {
    delete process.env.RESEND_API_KEY
    const { org, invoiceId } = await setup()
    const outcome = await executeIssuanceCommand(recordStripeCheckoutPayment, stripePayment(invoiceId, "cs_nomail", 250), { actor: webhook(org.organizationId) })
    expect(outcome.status).toBe("completed")
    expect(await queuedPaymentEmails(org.organizationId)).toHaveLength(0)
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } })).status).toBe("paid")
  })

  it("does not confirm to the customer a payment that merely claims to be Stripe", async () => {
    const { org, invoiceId } = await setup()
    await executeIssuanceCommand(recordPayment, { invoiceId, amount: 250, paidAt: "2026-06-01", method: "stripe" }, { actor: org.actors.admin })
    expect((await sentMessages(org.organizationId)).map((message) => message.to)).toEqual(["seller@acme.test"])
  })
})
