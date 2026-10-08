import "dotenv/config"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const createCheckoutSession = vi.hoisted(() => vi.fn())
const expireCheckoutSession = vi.hoisted(() => vi.fn())
vi.mock("../../payments/stripe", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../payments/stripe")>()),
  createStripeInvoiceCheckoutSession: createCheckoutSession,
  expireOpenStripeCheckoutSession: expireCheckoutSession,
}))
vi.mock("../../email", async () => ({
  ...(await vi.importActual<typeof import("../../email")>("../../email")),
  deliver: vi.fn(),
}))

import { executeIssuanceCommand } from "../../../application/issuance"
import { createInvoiceDraft, sendInvoice } from "../../../domain/commands/invoices"
import { createAgreementDraft } from "../../../domain/commands/agreements"
import {
  issueAgreement,
  recordAgreementAcceptance,
  revokeAgreementLinks,
} from "../../../domain/commands/agreement-lifecycle"
import { markDeliverableDelivered } from "../../../domain/commands/deliverables"
import { executeCommand, type CommandOutcome } from "../../../domain/execute"
import { appRouter } from "../../../trpc/router"
import { createTestOrganization, hasTestDatabase } from "../../../test-utils/organization"
import { prisma } from "../../db"
import { deliver } from "../../email"
import { encryptSecret } from "../../secrets"
import { clientActionDownload } from "../download"
import { performClientAction } from "../actions"
import { resolveClientActionAccess, type ActiveClientActionLink } from "../access"
import { buildClientActionDetail, buildClientActionPage, type ClientActionItem } from "../page"
import { mintClientActionToken, verifyClientActionToken } from "../tokens"
import { checkVerificationCode, requestVerificationCode } from "../verification"

const now = new Date()
const DAY = 86_400_000
const cleanups: Array<() => Promise<void>> = []

function completed<T>(outcome: CommandOutcome<T>): T {
  expect(outcome.status, JSON.stringify(outcome)).toBe("completed")
  if (outcome.status !== "completed") throw new Error(JSON.stringify(outcome))
  return outcome.result
}

beforeEach(() => {
  vi.stubEnv("RESEND_API_KEY", "synthetic-client-actions")
  vi.stubEnv("FROM_EMAIL", "billing@example.test")
  vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-0123456789abcdef0123456789abcdef")
  vi.stubEnv("QUITS_APP_ORIGIN", "https://app.example.test")
  vi.mocked(deliver).mockReset().mockResolvedValue({ id: "synthetic" })
  createCheckoutSession.mockReset().mockResolvedValue({ id: "cs_client_1", url: "https://checkout.stripe.test/cs_client_1" })
  expireCheckoutSession.mockReset().mockResolvedValue("expired")
})
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.()
  vi.unstubAllEnvs()
})

function callerFor(organizationId: string, userId: string) {
  return appRouter.createCaller({
    session: { user: { id: userId, email: `${userId}@test.quits.invalid`, name: userId }, session: { activeOrganizationId: organizationId } },
  } as never)
}

/**
 * One organization, two contacts. The main contact has two invoices (only the first is ever
 * granted), an agreement still waiting for a decision, and an accepted agreement with a delivered
 * line. The other contact has an invoice of their own.
 */
async function setup() {
  const org = await createTestOrganization({ roles: ["admin", "member", "accountant"] })
  cleanups.push(org.cleanup)
  await prisma.orgSettings.update({
    where: { organizationId: org.organizationId },
    data: {
      companyName: "Acme ApS",
      stripePublishableKey: "pk_test_123456789",
      stripeSecretKeyEnc: encryptSecret("sk_test_12345678901234567890"),
      stripeWebhookSecretEnc: encryptSecret("whsec_test_12345678901234567890"),
    },
  })
  const actor = org.actors.admin
  const contact = await prisma.contact.create({ data: { organizationId: org.organizationId, name: "Customer", email: "customer@example.test" } })
  const other = await prisma.contact.create({ data: { organizationId: org.organizationId, name: "Other", email: "other@example.test" } })

  async function invoiceFor(contactId: string, amount: number) {
    const draft = completed(
      await executeIssuanceCommand(createInvoiceDraft, { contactId, dueDate: "2099-12-01", currency: "USD", taxRate: 0, items: [{ description: "Consulting", quantity: 1, unitPrice: amount }] }, { actor }),
    )
    completed(await executeIssuanceCommand(sendInvoice, { id: draft.id, allowSendWithoutEmail: true }, { actor }))
    return prisma.invoice.update({ where: { id: draft.id }, data: { publicPaymentIssuedAt: now } })
  }
  const invoice = await invoiceFor(contact.id, 100)
  const secondInvoice = await invoiceFor(contact.id, 250)
  const otherInvoice = await invoiceFor(other.id, 75)

  async function agreementFor(contactId: string, title: string, accepted: boolean) {
    const draft = completed(
      await executeCommand(createAgreementDraft, { title, contactId, validUntil: "2099-01-01", billingTrigger: "on_delivery", deliverables: [{ title: `${title} work`, description: "Agreed work", quantity: "1", unitPrice: "100" }] }, { actor, now }),
    )
    completed(await executeIssuanceCommand(issueAgreement, { id: draft.id, recipient: "customer@example.test" }, { actor, now }))
    if (accepted) completed(await executeCommand(recordAgreementAcceptance, { id: draft.id, acceptedByName: "Customer", evidenceNote: "Written confirmation" }, { actor, now }))
    return prisma.agreement.findUniqueOrThrow({ where: { id: draft.id }, include: { deliverables: true } })
  }
  const open = await agreementFor(contact.id, "Open offer", false)
  const signed = await agreementFor(contact.id, "Signed offer", true)
  const line = signed.deliverables[0]!
  completed(await executeCommand(markDeliverableDelivered, { agreementId: signed.id, id: line.id }, { actor, now }))

  const member = callerFor(org.organizationId, org.actors.member.userId)
  async function link(grants: Array<{ kind: "agreement" | "deliverable" | "invoice"; recordId: string; capabilities: Array<"view" | "pay" | "approve"> }>, extra: Partial<{ verification: "none" | "email_code"; expiresInDays: number; recipientEmail: string | null; recipientName: string }> = {}) {
    const created = await member.clientLinks.create({
      contactId: contact.id,
      recipientName: extra.recipientName ?? "Pia Payer",
      recipientEmail: extra.recipientEmail === undefined ? "pia@example.test" : extra.recipientEmail,
      expiresInDays: extra.expiresInDays ?? 30,
      verification: extra.verification ?? "none",
      grants,
    })
    const row = await prisma.clientActionLink.findUniqueOrThrow({ where: { id: created.id }, include: { grants: true, organization: { select: { settings: { select: { locale: true, timezone: true, companyName: true, companyLogo: true } } } } } })
    return { ...created, row: row as unknown as ActiveClientActionLink, token: mintClientActionToken(created.id) }
  }
  return { org, actor, member, contact, other, invoice, secondInvoice, otherInvoice, open, signed, line, link }
}
type Ctx = Awaited<ReturnType<typeof setup>>
const reload = async (id: string) => (await resolveClientActionAccess(mintClientActionToken(id), now).then((a) => (a.status === "active" ? a.link : null)))!
const record = (items: ClientActionItem[], id: string) => items.find((item) => item.recordId === id)

describe.runIf(hasTestDatabase)("client action page", () => {
  describe("grants are per record and per capability", () => {
    it("shows a finance contact only the invoices granted, and an approver only the work granted", async () => {
      const ctx = await setup()
      const finance = await ctx.link([{ kind: "invoice", recordId: ctx.invoice.id, capabilities: ["view", "pay"] }])
      const approver = await ctx.link(
        [{ kind: "agreement", recordId: ctx.open.id, capabilities: ["view", "approve"] }, { kind: "deliverable", recordId: ctx.line.id, capabilities: ["view", "approve"] }],
        { verification: "email_code", recipientName: "Alex Approver" },
      )
      const financePage = await buildClientActionPage(await reload(finance.id), { verified: false, now })
      expect(financePage.items.map((item) => item.recordId)).toEqual([ctx.invoice.id])
      expect(record(financePage.items, ctx.invoice.id)).toMatchObject({ kind: "invoice", state: "payable", canPay: true, balanceDue: 100 })
      expect(financePage.verification.required).toBe(false)

      const approverPage = await buildClientActionPage(await reload(approver.id), { verified: false, now })
      expect(approverPage.items.map((item) => item.recordId).sort()).toEqual([ctx.open.id, ctx.line.id].sort())
      expect(approverPage.items.every((item) => item.kind !== "invoice")).toBe(true)
      expect(approverPage.verification).toMatchObject({ required: true, verified: false, emailHint: expect.stringContaining("@example.test") })
      expect(approverPage.attention).toBe(2)
      // Nothing of the page carries internal data: no notes, rates, evidence or other records.
      const serialized = JSON.stringify([financePage, approverPage])
      for (const secret of ["Written confirmation", "customer@example.test", "Customer ", ctx.secondInvoice.id, ctx.otherInvoice.id]) expect(serialized).not.toContain(secret)
    })

    it("does not let a payer decide an agreement or sign off work, nor an approver pay", async () => {
      const ctx = await setup()
      const finance = await ctx.link([{ kind: "invoice", recordId: ctx.invoice.id, capabilities: ["view", "pay"] }])
      const link = await reload(finance.id)
      const context = { token: finance.token, verified: true, now }
      for (const request of [
        { type: "agreement.accept", agreementId: ctx.open.id, offerRevision: ctx.open.offerRevision, acceptedByName: "Pia", confirmed: true },
        { type: "deliverable.accept", deliverableId: ctx.line.id, deliveryRevision: 1, confirmed: true },
      ] as const) expect(await performClientAction(link, request, context)).toEqual({ status: "not_permitted" })
      expect((await prisma.agreement.findUniqueOrThrow({ where: { id: ctx.open.id } })).status).toBe("sent")

      const approver = await ctx.link([{ kind: "invoice", recordId: ctx.invoice.id, capabilities: ["view"] }, { kind: "deliverable", recordId: ctx.line.id, capabilities: ["view", "approve"] }])
      expect(await performClientAction(await reload(approver.id), { type: "invoice.pay", invoiceId: ctx.invoice.id }, { token: approver.token, verified: true, now })).toEqual({ status: "not_permitted" })
      expect(createCheckoutSession).not.toHaveBeenCalled()
    })

    it("refuses a request for a record the link was not granted, whatever its id", async () => {
      const ctx = await setup()
      const finance = await ctx.link([{ kind: "invoice", recordId: ctx.invoice.id, capabilities: ["view", "pay"] }])
      const link = await reload(finance.id)
      const context = { token: finance.token, verified: true, now }
      expect(await performClientAction(link, { type: "invoice.pay", invoiceId: ctx.secondInvoice.id }, context)).toEqual({ status: "not_permitted" })
      expect(await performClientAction(link, { type: "invoice.pay", invoiceId: ctx.otherInvoice.id }, context)).toEqual({ status: "not_permitted" })
      expect(createCheckoutSession).not.toHaveBeenCalled()
      expect(await buildClientActionDetail(link, { kind: "invoice", recordId: ctx.secondInvoice.id }, finance.token, now)).toBeNull()
      expect(await buildClientActionDetail(link, { kind: "invoice", recordId: ctx.otherInvoice.id }, finance.token, now)).toBeNull()
      // Downloads follow the same rule and answer like an unknown record.
      expect((await clientActionDownload(finance.token, "invoice", ctx.secondInvoice.id)).status).toBe(404)
      expect((await clientActionDownload(finance.token, "agreement", ctx.open.id)).status).toBe(404)
    })

    it("refuses to grant a record of another contact or another organization", async () => {
      const ctx = await setup()
      await expect(ctx.link([{ kind: "invoice", recordId: ctx.otherInvoice.id, capabilities: ["view"] }])).rejects.toMatchObject({ code: "BAD_REQUEST" })
      const foreign = await setup()
      await expect(ctx.link([{ kind: "invoice", recordId: foreign.invoice.id, capabilities: ["view", "pay"] }])).rejects.toBeTruthy()
      expect(await prisma.clientActionLink.count({ where: { organizationId: ctx.org.organizationId } })).toBe(0)
    })

    it("applies the contract's rules: a signature needs a verified email, a payer cannot be an approver", async () => {
      const ctx = await setup()
      await expect(ctx.link([{ kind: "agreement", recordId: ctx.open.id, capabilities: ["view", "approve"] }], { verification: "none" })).rejects.toBeTruthy()
      await expect(ctx.link([{ kind: "invoice", recordId: ctx.invoice.id, capabilities: ["view", "approve"] }])).rejects.toBeTruthy()
      await expect(ctx.link([{ kind: "agreement", recordId: ctx.open.id, capabilities: ["view", "approve"] }], { verification: "email_code", recipientEmail: null })).rejects.toBeTruthy()
    })

    it("denies links to the read-only accountant role", async () => {
      const ctx = await setup()
      const accountant = callerFor(ctx.org.organizationId, ctx.org.actors.accountant.userId)
      await expect(accountant.clientLinks.list({ contactId: ctx.contact.id })).rejects.toMatchObject({ code: "FORBIDDEN" })
      await expect(accountant.clientLinks.create({ contactId: ctx.contact.id, recipientName: "X", expiresInDays: 7, verification: "none", grants: [{ kind: "invoice", recordId: ctx.invoice.id, capabilities: ["view"] }] })).rejects.toMatchObject({ code: "FORBIDDEN" })
    })
  })

  describe("final documents", () => {
    it("serves the stored PDF of a granted invoice and agreement, and only those", async () => {
      const ctx = await setup()
      const link = await ctx.link([
        { kind: "invoice", recordId: ctx.invoice.id, capabilities: ["view"] },
        { kind: "agreement", recordId: ctx.signed.id, capabilities: ["view"] },
      ])
      for (const [kind, id] of [["invoice", ctx.invoice.id], ["agreement", ctx.signed.id]] as const) {
        const response = await clientActionDownload(link.token, kind, id)
        expect(response.status, kind).toBe(200)
        expect(response.headers.get("content-type")).toBe("application/pdf")
        expect(response.headers.get("cache-control")).toBe("private, no-store")
      }
      expect((await clientActionDownload(link.token, "agreement", ctx.open.id)).status).toBe(404)
      expect((await clientActionDownload(link.token, "invoice", ctx.secondInvoice.id)).status).toBe(404)
      // Deliveries and unknown kinds have no download.
      expect((await clientActionDownload(link.token, "deliverable", ctx.line.id)).status).toBe(404)
      expect((await clientActionDownload(`${link.id}.forged`, "invoice", ctx.invoice.id)).status).toBe(404)
    })
  })

  describe("revocation, expiry and changed records", () => {
    it("stops a revoked link from loading anything or acting, and keeps it revoked after renewal attempts", async () => {
      const ctx = await setup()
      const finance = await ctx.link([{ kind: "invoice", recordId: ctx.invoice.id, capabilities: ["view", "pay"] }])
      expect((await resolveClientActionAccess(finance.token, now)).status).toBe("active")
      await ctx.member.clientLinks.revoke({ id: finance.id })
      expect(await resolveClientActionAccess(finance.token, now)).toMatchObject({ status: "inactive", reason: "revoked", seller: { name: "Acme ApS" } })
      expect((await clientActionDownload(finance.token, "invoice", ctx.invoice.id)).status).toBe(404)
      await expect(ctx.member.clientLinks.renew({ id: finance.id, expiresInDays: 30 })).rejects.toBeTruthy()
      expect(await resolveClientActionAccess(finance.token, now)).toMatchObject({ status: "inactive", reason: "revoked" })
      // The inactive answer names the seller and nothing of the records.
      expect(JSON.stringify(await resolveClientActionAccess(finance.token, now))).not.toContain(ctx.invoice.number ?? "never")
    })

    it("expires a link at its instant and a renewed link works again at the same address", async () => {
      const ctx = await setup()
      const finance = await ctx.link([{ kind: "invoice", recordId: ctx.invoice.id, capabilities: ["view", "pay"] }], { expiresInDays: 7 })
      const row = await prisma.clientActionLink.findUniqueOrThrow({ where: { id: finance.id } })
      expect(row.expiresAt.getTime() - Date.now()).toBeGreaterThan(6 * DAY)
      expect((await resolveClientActionAccess(finance.token, new Date(row.expiresAt.getTime() - 1))).status).toBe("active")
      expect(await resolveClientActionAccess(finance.token, row.expiresAt)).toMatchObject({ status: "inactive", reason: "expired" })
      const renewed = await ctx.member.clientLinks.renew({ id: finance.id, expiresInDays: 30 })
      expect(renewed.url).toBe(finance.url)
      expect((await resolveClientActionAccess(finance.token, new Date(row.expiresAt.getTime() + DAY))).status).toBe("active")
    })

    it("rejects tampered, foreign and unknown tokens as invalid", async () => {
      const ctx = await setup()
      const finance = await ctx.link([{ kind: "invoice", recordId: ctx.invoice.id, capabilities: ["view"] }])
      expect(await resolveClientActionAccess(`${finance.id}.forged`, now)).toEqual({ status: "invalid" })
      expect(await resolveClientActionAccess(`${ctx.invoice.id}.${finance.token.split(".")[1]}`, now)).toEqual({ status: "invalid" })
      expect(await resolveClientActionAccess("nonsense", now)).toEqual({ status: "invalid" })
      expect(verifyClientActionToken(mintClientActionToken("missing-link"))).toBe("missing-link")
      expect(await resolveClientActionAccess(mintClientActionToken("missing-link"), now)).toEqual({ status: "invalid" })
    })

    it("withdraws an agreement grant when the seller revokes the agreement's links, until the link is renewed", async () => {
      const ctx = await setup()
      const approver = await ctx.link([{ kind: "agreement", recordId: ctx.open.id, capabilities: ["view", "approve"] }], { verification: "email_code" })
      completed(await executeCommand(revokeAgreementLinks, { id: ctx.open.id }, { actor: ctx.actor, now }))
      const page = await buildClientActionPage(await reload(approver.id), { verified: true, now })
      expect(page.items).toEqual([{ kind: "inactive", recordKind: "agreement", recordId: ctx.open.id, state: "withdrawn" }])
      expect(await performClientAction(await reload(approver.id), { type: "agreement.accept", agreementId: ctx.open.id, offerRevision: ctx.open.offerRevision, acceptedByName: "Alex", confirmed: true }, { token: approver.token, verified: true, now })).toEqual({ status: "unavailable" })
      expect((await prisma.agreement.findUniqueOrThrow({ where: { id: ctx.open.id } })).status).toBe("sent")
      await ctx.member.clientLinks.renew({ id: approver.id, expiresInDays: 30 })
      expect((await buildClientActionPage(await reload(approver.id), { verified: true, now })).items[0]).toMatchObject({ kind: "agreement", state: "open" })
    })
  })

  describe("approving work", () => {
    it("records a delivery sign-off once and refuses an obsolete revision", async () => {
      const ctx = await setup()
      const approver = await ctx.link([{ kind: "deliverable", recordId: ctx.line.id, capabilities: ["view", "approve"] }])
      const link = await reload(approver.id)
      const context = { token: approver.token, verified: false, now }
      const accept = { type: "deliverable.accept", deliverableId: ctx.line.id, deliveryRevision: 1, confirmed: true } as const

      // Two quick clicks: both succeed, only one acceptance exists.
      expect(await performClientAction(link, accept, context)).toEqual({ status: "ok", checkoutUrl: null })
      expect(await performClientAction(link, accept, context)).toEqual({ status: "ok", checkoutUrl: null })
      expect(await prisma.deliverable.findUniqueOrThrow({ where: { id: ctx.line.id } })).toMatchObject({ status: "accepted", acceptedRevision: 1, acceptedVia: "customer_link" })
      expect(await prisma.domainEvent.count({ where: { organizationId: ctx.org.organizationId, type: "deliverable.accepted", aggregateId: ctx.signed.id } })).toBe(1)
      // A later contradictory decision is refused.
      expect(await performClientAction(link, { type: "deliverable.request_changes", deliverableId: ctx.line.id, deliveryRevision: 1, note: "Actually no" }, context)).toEqual({ status: "already_decided" })
      expect((await buildClientActionPage(link, { verified: false, now })).items[0]).toMatchObject({ kind: "deliverable", state: "accepted", acceptedRevision: 1 })
    })

    it("refuses to approve a revision the visitor did not see", async () => {
      const ctx = await setup()
      const approver = await ctx.link([{ kind: "deliverable", recordId: ctx.line.id, capabilities: ["view", "approve"] }])
      const link = await reload(approver.id)
      // The seller asks for changes through the page, then re-delivers: revision 2 is current.
      await performClientAction(link, { type: "deliverable.request_changes", deliverableId: ctx.line.id, deliveryRevision: 1, note: "Fix heading" }, { token: approver.token, verified: false, now })
      completed(await executeCommand(markDeliverableDelivered, { agreementId: ctx.signed.id, id: ctx.line.id }, { actor: ctx.actor, now }))
      const stale = await performClientAction(link, { type: "deliverable.accept", deliverableId: ctx.line.id, deliveryRevision: 1, confirmed: true }, { token: approver.token, verified: false, now })
      expect(stale).toEqual({ status: "changed" })
      expect((await prisma.deliverable.findUniqueOrThrow({ where: { id: ctx.line.id } })).status).toBe("delivered")
      const page = await buildClientActionPage(link, { verified: false, now })
      expect(page.items[0]).toMatchObject({ state: "awaiting", deliveryRevision: 2 })
      expect(await performClientAction(link, { type: "deliverable.accept", deliverableId: ctx.line.id, deliveryRevision: 2, confirmed: true }, { token: approver.token, verified: false, now })).toEqual({ status: "ok", checkoutUrl: null })
    })

    it("holds an agreement decision, and approvals on a verifying link, until the recipient is verified", async () => {
      const ctx = await setup()
      const approver = await ctx.link(
        [{ kind: "agreement", recordId: ctx.open.id, capabilities: ["view", "approve"] }, { kind: "deliverable", recordId: ctx.line.id, capabilities: ["view", "approve"] }],
        { verification: "email_code" },
      )
      const link = await reload(approver.id)
      const accept = { type: "agreement.accept", agreementId: ctx.open.id, offerRevision: ctx.open.offerRevision, acceptedByName: "Alex Approver", confirmed: true } as const
      expect(await performClientAction(link, accept, { token: approver.token, verified: false, now })).toEqual({ status: "verification_required" })
      expect(await performClientAction(link, { type: "deliverable.accept", deliverableId: ctx.line.id, deliveryRevision: 1, confirmed: true }, { token: approver.token, verified: false, now })).toEqual({ status: "verification_required" })
      expect((await prisma.agreement.findUniqueOrThrow({ where: { id: ctx.open.id } })).status).toBe("sent")

      expect(await performClientAction(link, accept, { token: approver.token, verified: true, now, evidence: { ip: "203.0.113.5", userAgent: "test" } })).toEqual({ status: "ok", checkoutUrl: null })
      expect(await prisma.agreement.findUniqueOrThrow({ where: { id: ctx.open.id } })).toMatchObject({ status: "accepted", acceptedByName: "Alex Approver", acceptanceMethod: "customer_link", acceptanceIp: "203.0.113.5" })
      // Seller sees who acted through which link.
      expect(await prisma.domainEvent.findFirstOrThrow({ where: { organizationId: ctx.org.organizationId, type: "client_link.action_taken" } })).toMatchObject({ aggregateId: ctx.contact.id, payload: { linkId: approver.id, kind: "agreement", action: "accept", recipientName: "Pia Payer" } })
    })

    it("refuses an agreement decision made on an offer revision that moved on", async () => {
      const ctx = await setup()
      const approver = await ctx.link([{ kind: "agreement", recordId: ctx.open.id, capabilities: ["view", "approve"] }], { verification: "email_code" })
      const outcome = await performClientAction(await reload(approver.id), { type: "agreement.accept", agreementId: ctx.open.id, offerRevision: ctx.open.offerRevision + 1, acceptedByName: "Alex", confirmed: true }, { token: approver.token, verified: true, now })
      expect(outcome).toEqual({ status: "changed" })
      expect((await prisma.agreement.findUniqueOrThrow({ where: { id: ctx.open.id } })).status).toBe("sent")
    })
  })

  describe("paying", () => {
    it("starts the existing checkout for the balance, returning to the client page rather than a payment link", async () => {
      const ctx = await setup()
      await prisma.invoice.update({ where: { id: ctx.invoice.id }, data: { amountPaid: 40, paymentStatus: "partially_paid" } })
      const finance = await ctx.link([{ kind: "invoice", recordId: ctx.invoice.id, capabilities: ["view", "pay"] }])
      const link = await reload(finance.id)
      expect((await buildClientActionPage(link, { verified: false, now })).items[0]).toMatchObject({ state: "payable", balanceDue: 60, amountPaid: 40 })
      const outcome = await performClientAction(link, { type: "invoice.pay", invoiceId: ctx.invoice.id }, { token: finance.token, verified: false, now })
      expect(outcome).toEqual({ status: "ok", checkoutUrl: "https://checkout.stripe.test/cs_client_1" })
      const call = createCheckoutSession.mock.calls[0]![0] as { amountDue: number; successUrl: string; cancelUrl: string }
      expect(call.amountDue).toBe(60)
      expect(call.successUrl).toBe(`https://app.example.test/c/${encodeURIComponent(finance.token)}?item=invoice:${ctx.invoice.id}`)
      expect(call.cancelUrl).toBe(call.successUrl)
      expect(call.successUrl).not.toContain("/pay/")
      // Clicking again reuses the one tracked session: the first is expired, nothing is charged twice.
      createCheckoutSession.mockResolvedValueOnce({ id: "cs_client_2", url: "https://checkout.stripe.test/cs_client_2" })
      await prisma.invoice.update({ where: { id: ctx.invoice.id }, data: { stripeCheckoutSessionId: "cs_client_1" } })
      await performClientAction(link, { type: "invoice.pay", invoiceId: ctx.invoice.id }, { token: finance.token, verified: false, now })
      expect(expireCheckoutSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "cs_client_1" }))
      expect((await prisma.invoice.findUniqueOrThrow({ where: { id: ctx.invoice.id } })).stripeCheckoutSessionId).toBe("cs_client_2")
    })

    it("shows paid and credited invoices as settled and offers no payment", async () => {
      const ctx = await setup()
      await prisma.invoice.update({ where: { id: ctx.invoice.id }, data: { status: "paid", paymentStatus: "paid", amountPaid: 100 } })
      await prisma.invoice.update({ where: { id: ctx.secondInvoice.id }, data: { status: "credited", amountCredited: 250 } })
      const finance = await ctx.link([
        { kind: "invoice", recordId: ctx.invoice.id, capabilities: ["view", "pay"] },
        { kind: "invoice", recordId: ctx.secondInvoice.id, capabilities: ["view", "pay"] },
      ])
      const link = await reload(finance.id)
      const page = await buildClientActionPage(link, { verified: false, now })
      expect(record(page.items, ctx.invoice.id)).toMatchObject({ state: "paid", balanceDue: 0 })
      expect(record(page.items, ctx.secondInvoice.id)).toMatchObject({ state: "credited", balanceDue: 0 })
      expect(page.attention).toBe(0)
      expect(await performClientAction(link, { type: "invoice.pay", invoiceId: ctx.invoice.id }, { token: finance.token, verified: false, now })).toEqual({ status: "ok", checkoutUrl: null })
      expect(createCheckoutSession).not.toHaveBeenCalled()
    })

    it("does not offer online payment without Stripe, and a view-only invoice cannot be paid", async () => {
      const ctx = await setup()
      const viewOnly = await ctx.link([{ kind: "invoice", recordId: ctx.invoice.id, capabilities: ["view"] }])
      expect((await buildClientActionPage(await reload(viewOnly.id), { verified: false, now })).items[0]).toMatchObject({ state: "open", canPay: false })
      await prisma.orgSettings.update({ where: { organizationId: ctx.org.organizationId }, data: { stripePublishableKey: null } })
      const finance = await ctx.link([{ kind: "invoice", recordId: ctx.invoice.id, capabilities: ["view", "pay"] }])
      expect((await buildClientActionPage(await reload(finance.id), { verified: false, now })).items[0]).toMatchObject({ state: "open", canPay: true })
      expect(await performClientAction(await reload(finance.id), { type: "invoice.pay", invoiceId: ctx.invoice.id }, { token: finance.token, verified: false, now })).toEqual({ status: "unavailable" })
    })
  })

  describe("seller preview", () => {
    it("is built by the page builder from the same grants as the recipient's page", async () => {
      const ctx = await setup()
      const link = await ctx.link([
        { kind: "invoice", recordId: ctx.invoice.id, capabilities: ["view", "pay"] },
        { kind: "agreement", recordId: ctx.signed.id, capabilities: ["view"] },
      ])
      const preview = await ctx.member.clientLinks.preview({ id: link.id })
      const recipient = await buildClientActionPage(await reload(link.id), { token: link.token, verified: false, now })
      expect(preview.state).toBe("active")
      expect(JSON.parse(JSON.stringify(preview.page))).toEqual(JSON.parse(JSON.stringify(recipient)))
      expect(preview.page!.items.map((item) => item.recordId).sort()).toEqual([ctx.invoice.id, ctx.signed.id].sort())
      await ctx.member.clientLinks.revoke({ id: link.id })
      expect(await ctx.member.clientLinks.preview({ id: link.id })).toEqual({ state: "revoked", page: null })
      // Another organization's admin cannot preview it.
      const stranger = await setup()
      await expect(callerFor(stranger.org.organizationId, stranger.org.actors.admin.userId).clientLinks.preview({ id: link.id })).rejects.toMatchObject({ code: "NOT_FOUND" })
    })

    it("lists links with labelled grants and flags a grant gone stale", async () => {
      const ctx = await setup()
      await ctx.link([{ kind: "agreement", recordId: ctx.open.id, capabilities: ["view", "approve"] }], { verification: "email_code" })
      completed(await executeCommand(revokeAgreementLinks, { id: ctx.open.id }, { actor: ctx.actor, now }))
      const [listed] = await ctx.member.clientLinks.list({ contactId: ctx.contact.id })
      expect(listed).toMatchObject({ recipientName: "Pia Payer", state: "active", verification: "email_code" })
      expect(listed!.grants[0]).toMatchObject({ kind: "agreement", capabilities: ["view", "approve"], stale: true })
      expect(listed!.grants[0]!.label).toContain("Open offer")
    })
  })

  describe("email verification", () => {
    async function approverLink(ctx: Ctx) {
      const approver = await ctx.link([{ kind: "agreement", recordId: ctx.open.id, capabilities: ["view", "approve"] }], { verification: "email_code" })
      // Setup mailed the agreement itself; only what follows is the verification's.
      vi.mocked(deliver).mockClear()
      return { approver, link: await reload(approver.id) }
    }
    const sentCode = () => (vi.mocked(deliver).mock.calls.at(-1)![0] as { html: string }).html.match(/>(\d{6})</)![1]!

    it("emails a six-digit code only to the grant's recipient and accepts it once", async () => {
      const ctx = await setup()
      const { link } = await approverLink(ctx)
      expect(await requestVerificationCode(link, { sellerName: "Acme ApS", locale: "en-US" }, now)).toBe("sent")
      expect(vi.mocked(deliver).mock.calls[0]![0]).toMatchObject({ to: "pia@example.test", subject: expect.stringContaining("Acme ApS") })
      const code = sentCode()
      expect(await checkVerificationCode(link, code === "000000" ? "111111" : "000000", now)).toBe("wrong")
      expect(await checkVerificationCode(link, code, now)).toBe("verified")
      expect(await checkVerificationCode(link, code, now)).toBe("expired")
    })

    it("expires a code after ten minutes, locks after five wrong attempts and limits codes per hour", async () => {
      const ctx = await setup()
      const { link } = await approverLink(ctx)
      await requestVerificationCode(link, { sellerName: null, locale: "en-US" }, now)
      const code = sentCode()
      expect(await checkVerificationCode(link, code, new Date(now.getTime() + 11 * 60_000))).toBe("expired")
      await requestVerificationCode(link, { sellerName: null, locale: "en-US" }, now)
      const good = sentCode()
      const wrong = good === "123456" ? "654321" : "123456"
      for (let attempt = 0; attempt < 5; attempt += 1) expect(await checkVerificationCode(link, wrong, now)).toBe("wrong")
      expect(await checkVerificationCode(link, good, now)).toBe("locked")
      for (let index = 0; index < 3; index += 1) expect(await requestVerificationCode(link, { sellerName: null, locale: "en-US" }, now)).toBe("sent")
      expect(await requestVerificationCode(link, { sellerName: null, locale: "en-US" }, now)).toBe("rate_limited")
    })

    it("does not keep a code nobody received", async () => {
      const ctx = await setup()
      const { link } = await approverLink(ctx)
      vi.mocked(deliver).mockRejectedValueOnce(new Error("smtp down"))
      expect(await requestVerificationCode(link, { sellerName: null, locale: "en-US" }, now)).toBe("unavailable")
      expect(await prisma.clientActionVerification.count({ where: { linkId: link.id } })).toBe(0)
    })

    it("cannot be sent for a link that does not verify", async () => {
      const ctx = await setup()
      const finance = await ctx.link([{ kind: "invoice", recordId: ctx.invoice.id, capabilities: ["view", "pay"] }])
      vi.mocked(deliver).mockClear()
      expect(await requestVerificationCode(await reload(finance.id), { sellerName: null, locale: "en-US" }, now)).toBe("unavailable")
      expect(deliver).not.toHaveBeenCalled()
    })

    it("refuses to create a verifying link when email cannot be sent", async () => {
      const ctx = await setup()
      vi.stubEnv("RESEND_API_KEY", "")
      await expect(ctx.link([{ kind: "agreement", recordId: ctx.open.id, capabilities: ["view", "approve"] }], { verification: "email_code" })).rejects.toBeTruthy()
    })
  })
})
