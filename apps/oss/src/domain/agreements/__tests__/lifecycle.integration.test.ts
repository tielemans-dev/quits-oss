import { executeIssuanceCommand } from "../../../application/issuance"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Prisma } from "../../../../generated/prisma/client"
vi.mock("../../../lib/email", async () => ({
  ...(await vi.importActual<typeof import("../../../lib/email")>("../../../lib/email")),
  deliver: vi.fn().mockResolvedValue({ id: "email" }),
}))
import { prisma } from "../../../lib/db"
import { deliver, EmailSendError } from "../../../lib/email"
import { createTestOrganization, hasTestDatabase } from "../../../test-utils/organization"
import { type CommandOutcome } from "../../execute"
import type { AnyCommandDefinition } from "../../command"
import {
  createAgreementDraft,
  updateAgreementDraft,
  deleteAgreementDraft,
  updateDeliverable,
} from "../../commands/agreements"
import {
  sendAgreement,
  issueAgreement,
  resendAgreement,
  recallAgreement,
  recordAgreementAcceptance,
  closeAgreement,
  revokeAgreementLinks,
  sendAgreementReadLink,
  recordAgreementCustomerDecision,
} from "../../commands/agreement-lifecycle"
import { getAgreement } from "../queries"
import { authenticateAgentSecret, createAgentKey } from "../../agent-keys"
import { decideApproval } from "../../approvals"
import { agreementExpiresAt } from "../expiry"
import {
  runAgreementExpiryTask,
  expireOrganizationAgreements,
  sweepPublicLinkAttempts,
} from "../../features/agreement-expiry"
import { settleAbandonedDeliveries } from "../../delivery/outbox"
import { retryEmailDeliveries, findEmailDeliveryJobs } from "../../../test-utils/email-outbox"
import {
  decidePublicAgreementByToken,
  loadPublicAgreementByToken,
} from "../../../lib/agreements/public-access"
import {
  mintAgreementLink,
  signAgreementPublicToken,
  verifyAgreementPublicToken,
  getAgreementPublicSecret,
} from "../../../lib/agreements/tokens"
import { publicAgreementDto } from "../../../lib/agreements/public"
import { recordPublicLinkAttempt } from "../../../lib/public-links/rate-limit"
import { getCommandDefinition } from "../../registry"
import { agreementTools } from "../../agent-tools/tools/agreements"

const cleanups: Array<() => Promise<void>> = []
const now = new Date("2027-03-27T12:00:00Z")
function completed<T>(outcome: CommandOutcome<T>): T {
  expect(outcome.status, JSON.stringify(outcome)).toBe("completed")
  if (outcome.status !== "completed") throw new Error(JSON.stringify(outcome))
  return outcome.result
}
const rejected = (outcome: CommandOutcome<unknown>, code: string) =>
  expect(outcome).toMatchObject({ status: "failed", error: { code } })
async function setup() {
  const org = await createTestOrganization({
    roles: ["admin", "member", "accountant"],
    settings: { timezone: "Europe/Copenhagen" },
  })
  cleanups.push(org.cleanup)
  const contact = await prisma.contact.create({
    data: {
      organizationId: org.organizationId,
      name: "Customer A",
      email: "customer@example.test",
    },
  })
  const actor = org.actors.admin
  const run = (command: AnyCommandDefinition, input: object = {}, at = now) => {
    vi.setSystemTime(at)
    return executeIssuanceCommand(command, input, { actor, now: at })
  }
  const agreement = completed(
    await run(createAgreementDraft, {
      contactId: contact.id,
      title: "Offer A",
      termsMarkdown: "# Scope A\n\n{{buyer.name}}",
      validUntil: "2027-03-28",
      notes: "private-secret",
      taxRate: 0,
      deliverables: [
        {
          title: "Website",
          description: "Build",
          quantity: 1,
          unitPrice: 100,
          agreedDate: "2027-04-01",
        },
      ],
    }),
  ) as Awaited<ReturnType<typeof getAgreement>>
  const get = () => getAgreement(org.organizationId, agreement.id)
  const issue = async (recipient?: string) =>
    completed(
      await run(issueAgreement, { id: agreement.id, ...(recipient ? { recipient } : {}) }),
    ) as Awaited<ReturnType<typeof getAgreement>>
  const link = async () => mintAgreementLink(await get(), "decide", now).token
  const agent = async () =>
    authenticateAgentSecret(
      (
        await createAgentKey(actor, {
          name: "Issuer",
          mode: "approval_required",
          scopes: ["agreement:send"],
        })
      ).secret,
    )
  return { org, actor, contact, agreement, run, get, issue, link, agent }
}
const accept = { decision: "accept", acceptedByName: "  Customer Name  ", confirmed: true }
const decline = { decision: "decline", reason: "No thanks" }
const identity = (row: Awaited<ReturnType<typeof getAgreement>>) => [
  row.number,
  row.offerRevision,
  row.publicAccessKeyVersion,
  row.issueDate,
  row.expiresAt,
  row.offerSnapshotHash,
]
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(now)
  vi.stubEnv("RESEND_API_KEY", "resend_test_key")
  vi.stubEnv("FROM_EMAIL", "billing@example.test")
  vi.stubEnv("BETTER_AUTH_SECRET", "agreement-test-only-secret-more-than-32-characters")
  vi.mocked(deliver).mockReset().mockResolvedValue({ id: "email" })
})
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.()
  vi.unstubAllEnvs()
  vi.useRealTimers()
})
describe("agreement validity", () => {
  it.each([
    ["2027-03-27", "Europe/Copenhagen", "2027-03-27T23:00:00.000Z"],
    ["2027-03-28", "Europe/Copenhagen", "2027-03-28T22:00:00.000Z"],
    ["2027-10-31", "Europe/Copenhagen", "2027-10-31T23:00:00.000Z"],
    ["2027-03-14", "America/New_York", "2027-03-15T04:00:00.000Z"],
    ["2027-01-01", "UTC", "2027-01-02T00:00:00.000Z"],
  ])("derives end of %s in %s", (date, zone, exp) =>
    expect(agreementExpiresAt(new Date(date), zone).toISOString()).toBe(exp),
  )
})
;(hasTestDatabase ? describe : describe.skip)("agreement issuance and acceptance", () => {
  it("allocates at issuance, freezes refreshed parties, and uses the agreement timezone", async () => {
    const ctx = await setup()
    expect(ctx.agreement.number).toBeNull()
    await prisma.contact.update({
      where: { id: ctx.contact.id },
      data: { name: "Refreshed", email: "new@example.test" },
    })
    await prisma.orgSettings.update({
      where: { organizationId: ctx.org.organizationId },
      data: { companyName: "New seller", timezone: "UTC" },
    })
    const issued = await ctx.issue("manual@example.test")
    expect(issued).toMatchObject({
      number: "AGR-0001",
      status: "sent",
      offerRevision: 1,
      issuedVia: "manual",
      issuedToEmail: "manual@example.test",
      buyerSnapshot: { name: "Refreshed" },
      sellerSnapshot: { companyName: "New seller" },
    })
    expect(issued.expiresAt?.toISOString()).toBe("2027-03-28T22:00:00.000Z")
    expect(issued.offerSnapshot).toMatchObject({
      termsHtml: expect.stringContaining("Refreshed"),
      timezone: "Europe/Copenhagen",
    })
    rejected(await ctx.run(issueAgreement, { id: issued.id }), "not_draft")
  })
  it("refuses issuance at validity, no live lines, missing recipient and unavailable email", async () => {
    const ctx = await setup()
    const id = ctx.agreement.id
    const exp = agreementExpiresAt(ctx.agreement.validUntil, ctx.agreement.timezone)
    for (const cmd of [issueAgreement, sendAgreement])
      rejected(await ctx.run(cmd, { id }, exp), "expired")
    await prisma.deliverable.updateMany({
      where: { agreementId: id },
      data: { status: "cancelled" },
    })
    rejected(await ctx.run(issueAgreement, { id }), "no_deliverables")
    await prisma.deliverable.updateMany({ where: { agreementId: id }, data: { status: "planned" } })
    await prisma.contact.update({ where: { id: ctx.contact.id }, data: { email: null } })
    rejected(await ctx.run(sendAgreement, { id }), "missing_recipient")
    await prisma.contact.update({
      where: { id: ctx.contact.id },
      data: { email: "customer@example.test" },
    })
    vi.stubEnv("RESEND_API_KEY", "")
    rejected(await ctx.run(sendAgreement, { id }), "email_unavailable")
    expect((await ctx.get()).number).toBeNull()
  })
  it("preserves unchanged rejected retries, changes edited or contact-edited retries, and fences old completion", async () => {
    const ctx = await setup()
    const id = ctx.agreement.id
    vi.mocked(deliver).mockRejectedValueOnce(new EmailSendError("validation_error", "refused"))
    completed(await ctx.run(sendAgreement, { id }))
    const first = await ctx.get()
    expect(first).toMatchObject({
      status: "draft",
      lastEmailAttemptOutcome: "failed",
      offerRevision: 1,
    })
    vi.mocked(deliver).mockRejectedValueOnce(new EmailSendError("validation_error", "refused"))
    completed(await ctx.run(sendAgreement, { id }, new Date(now.getTime() + 1000)))
    expect(identity(await ctx.get())).toEqual(identity(first))
    completed(await ctx.run(updateAgreementDraft, { id, title: "Offer B" }))
    vi.mocked(deliver).mockRejectedValueOnce(new EmailSendError("validation_error", "refused"))
    completed(await ctx.run(sendAgreement, { id }, new Date(now.getTime() + 2000)))
    expect((await ctx.get()).offerRevision).toBe(2)
    await prisma.contact.update({
      where: { id: ctx.contact.id },
      data: { name: "Party B", email: "party-b@example.test" },
    })
    completed(await ctx.run(sendAgreement, { id }, new Date(now.getTime() + 3000)))
    expect(await ctx.get()).toMatchObject({
      status: "sent",
      offerRevision: 3,
      issuedToEmail: "party-b@example.test",
      lastEmailAttemptOutcome: "sent",
      publicAccessKeyVersion: first.publicAccessKeyVersion + 2,
    })
    const old = (await findEmailDeliveryJobs(ctx.org.organizationId))[0]!
    await prisma.job.update({
      where: { id: old.id },
      data: {
        status: "failed",
        claimToken: null,
        result: Prisma.DbNull,
        payload: { ...(old.payload as object), providerMessageId: "late" },
      },
    })
    const current = identity(await ctx.get())
    await settleAbandonedDeliveries({ organizationIds: [ctx.org.organizationId] })
    expect(identity(await ctx.get())).toEqual(current)
  })
  it("stores preview A through B back to A, while edited approval is refused", async () => {
    const ctx = await setup()
    const id = ctx.agreement.id
    const queued = await executeIssuanceCommand(
      issueAgreement,
      { id, recipient: "customer@example.test" },
      { actor: await ctx.agent(), clientRequestId: "offer-a", now },
    )
    if (queued.status !== "awaiting_approval") throw new Error(JSON.stringify(queued))
    const review = await prisma.approvalRequest.findUniqueOrThrow({
      where: { id: queued.approvalRequestId },
    })
    const preview = review.reviewContext as {
      version: string
      preview: { snapshot: { title: string }; hash: string; recipient: string }
    }
    expect(preview).toMatchObject({
      preview: { snapshot: { title: "Offer A" }, recipient: "customer@example.test" },
    })
    expect(preview.version).toBe(`${preview.preview.hash}:customer@example.test`)
    completed(await ctx.run(updateAgreementDraft, { id, title: "Offer B" }))
    expect(
      (await prisma.approvalRequest.findUniqueOrThrow({ where: { id: review.id } })).reviewContext,
    ).toEqual(review.reviewContext)
    completed(await ctx.run(updateAgreementDraft, { id, title: "Offer A" }))
    completed(
      await decideApproval({
        approvalRequestId: review.id,
        decider: ctx.actor,
        decision: "approve",
        now,
      }),
    )
    expect((await ctx.get()).offerSnapshot).toMatchObject({ title: "Offer A" })
    const other = await setup()
    const changed = await executeIssuanceCommand(
      issueAgreement,
      { id: other.agreement.id },
      { actor: await other.agent(), clientRequestId: "changed", now },
    )
    if (changed.status !== "awaiting_approval") throw new Error("not queued")
    completed(await other.run(updateAgreementDraft, { id: other.agreement.id, title: "Offer B" }))
    rejected(
      await decideApproval({
        approvalRequestId: changed.approvalRequestId,
        decider: other.actor,
        decision: "approve",
        now,
      }),
      "changed_since_review",
    )
    expect((await other.get()).number).toBeNull()
  })
  it("refuses approval across validity and contact recipient changes", async () => {
    const ctx = await setup()
    const actor = await ctx.agent()
    const id = ctx.agreement.id
    for (const request of ["expired", "recipient"]) {
      const queued = await executeIssuanceCommand(
        sendAgreement,
        { id },
        { actor, clientRequestId: request, now },
      )
      if (queued.status !== "awaiting_approval") throw new Error("not queued")
      if (request === "recipient")
        await prisma.contact.update({
          where: { id: ctx.contact.id },
          data: { email: "other@example.test" },
        })
      rejected(
        await decideApproval({
          approvalRequestId: queued.approvalRequestId,
          decider: ctx.actor,
          decision: "approve",
          now:
            request === "expired"
              ? agreementExpiresAt(ctx.agreement.validUntil, ctx.agreement.timezone)
              : now,
        }),
        request === "expired" ? "expired" : "changed_since_review",
      )
    }
  })
  it.each(["sent", "expired", "declined"])(
    "recalls %s, archives, edits and reissues while rejecting stale links",
    async (status) => {
      const ctx = await setup()
      const issued = await ctx.issue()
      const old = await ctx.link()
      const id = issued.id
      await prisma.agreement.update({
        where: { id },
        data: {
          status,
          ...(status === "declined" ? { declinedAt: now, declineReason: "no" } : {}),
        },
      })
      completed(await ctx.run(recallAgreement, { id }))
      expect(await ctx.get()).toMatchObject({
        status: "draft",
        offerSnapshot: null,
        offerSnapshotHash: null,
        declinedAt: null,
        declineReason: null,
      })
      expect(
        (
          await prisma.domainEvent.findFirstOrThrow({
            where: { aggregateId: id, type: "agreement.offer_recalled" },
          })
        ).payload,
      ).toMatchObject({
        snapshot: issued.offerSnapshot,
        hash: issued.offerSnapshotHash,
        revision: 1,
        keyVersion: issued.publicAccessKeyVersion,
      })
      expect(await loadPublicAgreementByToken(old, getAgreementPublicSecret(), now)).toBeNull()
      completed(
        await ctx.run(updateAgreementDraft, {
          id,
          validUntil: "2027-04-01",
          deliverables: [{ title: "New", description: "", quantity: 1, unitPrice: 200 }],
        }),
      )
      expect(await ctx.issue()).toMatchObject({ offerRevision: 2, number: issued.number })
      await expect(decidePublicAgreementByToken(old, accept, {}, now)).rejects.toMatchObject({
        code: "invalid",
      })
    },
  )
  it("refuses invalid resend and read-link approvals before queuing, and binds reviewed recipients", async () => {
    const ctx = await setup()
    const id = ctx.agreement.id
    const agent = await ctx.agent()
    const queue = (command: AnyCommandDefinition, input: object, request: string, at = now) =>
      executeIssuanceCommand(command, input, { actor: agent, clientRequestId: request, now: at })
    rejected(await queue(resendAgreement, { id }, "draft-resend"), "not_sent")
    rejected(await queue(sendAgreementReadLink, { id }, "draft-read"), "not_accepted")
    const issued = await ctx.issue("customer@example.test")
    rejected(await queue(resendAgreement, { id }, "expired-resend", issued.expiresAt!), "expired")
    rejected(await queue(sendAgreementReadLink, { id }, "sent-read"), "not_accepted")
    const reviewed = await queue(resendAgreement, { id }, "recipient-review")
    if (reviewed.status !== "awaiting_approval") throw new Error("not queued")
    completed(await ctx.run(resendAgreement, { id, recipient: "changed@example.test" }))
    rejected(
      await decideApproval({
        approvalRequestId: reviewed.approvalRequestId,
        decider: ctx.actor,
        decision: "approve",
        now,
      }),
      "changed_since_review",
    )
    await decidePublicAgreementByToken(await ctx.link(), accept, {}, now)
    const read = await queue(sendAgreementReadLink, { id }, "read-review")
    if (read.status !== "awaiting_approval") throw new Error("not queued")
    completed(
      await decideApproval({
        approvalRequestId: read.approvalRequestId,
        decider: ctx.actor,
        decision: "approve",
        now,
      }),
    )
  })
  it("resends to an audited new recipient without changing offer or validity", async () => {
    const ctx = await setup()
    const issued = await ctx.issue("customer@example.test")
    const old = await ctx.link()
    const id = issued.id
    completed(await ctx.run(resendAgreement, { id, recipient: "new@example.test" }))
    expect(await ctx.get()).toMatchObject({
      status: "sent",
      issuedToEmail: "new@example.test",
      offerRevision: 1,
      offerSnapshotHash: issued.offerSnapshotHash,
      expiresAt: issued.expiresAt,
      lastEmailAttemptOutcome: "sent",
      publicAccessKeyVersion: issued.publicAccessKeyVersion + 1,
    })
    expect(await loadPublicAgreementByToken(old, getAgreementPublicSecret(), now)).toBeNull()
    expect(
      await prisma.domainEvent.findFirst({
        where: { aggregateId: id, type: "agreement.recipient_changed" },
      }),
    ).toMatchObject({
      payload: { previousRecipient: "customer@example.test", recipient: "new@example.test" },
    })
    rejected(await ctx.run(resendAgreement, { id }, issued.expiresAt!), "expired")
  })
  it("blocks every pending mutation and customer decisions during a pending resend", async () => {
    const ctx = await setup()
    const id = ctx.agreement.id
    let release!: () => void
    vi.mocked(deliver).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ id: "later" })
        }),
    )
    const sending = ctx.run(sendAgreement, { id })
    await vi.waitFor(async () => expect((await ctx.get()).lastEmailAttemptOutcome).toBe("sending"), { timeout: 15_000 })
    expect((await ctx.get()).status).toBe("draft")
    const checks: Array<[AnyCommandDefinition, object]> = [
      [updateAgreementDraft, { id, title: "B" }],
      [deleteAgreementDraft, { id }],
      [updateDeliverable, { agreementId: id, id: ctx.agreement.deliverables[0]!.id, title: "B" }],
      ...[
        issueAgreement,
        sendAgreement,
        resendAgreement,
        recallAgreement,
        revokeAgreementLinks,
        sendAgreementReadLink,
      ].map((cmd): [AnyCommandDefinition, object] => [cmd, { id }]),
      [recordAgreementAcceptance, { id, acceptedByName: "Name", evidenceNote: "Proof" }],
      [closeAgreement, { id, disposition: "cancelled", reason: "done" }],
    ]
    for (const [command, input] of checks)
      rejected(await ctx.run(command, input), "send_in_progress")
    release()
    completed(await sending)
    vi.mocked(deliver).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ id: "resend" })
        }),
    )
    const resending = ctx.run(resendAgreement, { id })
    await vi.waitFor(async () => expect((await ctx.get()).lastEmailAttemptOutcome).toBe("sending"), { timeout: 15_000 })
    await expect(
      decidePublicAgreementByToken(await ctx.link(), accept, {}, now),
    ).rejects.toMatchObject({ code: "retry_later" })
    release()
    completed(await resending)
  })
  it.each(["accept", "decline"])(
    "replays %s at expiry, ignores changed evidence and refuses opposite verb",
    async (verb) => {
      const ctx = await setup()
      const issued = await ctx.issue("customer@example.test")
      const token = await ctx.link()
      const first = await decidePublicAgreementByToken(
        token,
        verb === "accept" ? accept : decline,
        { ip: "192.0.2.1", userAgent: "first" },
        now,
      )
      const events = await prisma.domainEvent.count({ where: { aggregateId: issued.id } })
      const jobs = await findEmailDeliveryJobs(ctx.org.organizationId)
      expect(
        (
          await decidePublicAgreementByToken(
            token,
            verb === "accept"
              ? { ...accept, acceptedByName: "Changed Name" }
              : { ...decline, reason: "Changed" },
            { ip: "192.0.2.2", userAgent: "changed" },
            issued.expiresAt!,
          )
        ).document,
      ).toEqual(first.document)
      expect(await prisma.domainEvent.count({ where: { aggregateId: issued.id } })).toBe(events)
      expect(await findEmailDeliveryJobs(ctx.org.organizationId)).toHaveLength(jobs.length)
      await expect(
        decidePublicAgreementByToken(
          token,
          verb === "accept" ? decline : accept,
          {},
          issued.expiresAt!,
        ),
      ).rejects.toMatchObject({ code: "already_decided" })
      if (verb === "accept")
        expect(await ctx.get()).toMatchObject({
          acceptedByName: "Customer Name",
          acceptanceIp: "192.0.2.1",
          acceptanceUserAgent: "first",
          acceptedOfferRevision: 1,
        })
    },
  )
  it("validates nonempty bounded name and confirmation server-side, counting refusals", async () => {
    const ctx = await setup()
    await ctx.issue()
    const token = await ctx.link()
    for (const input of [
      { ...accept, acceptedByName: " " },
      { ...accept, acceptedByName: "x".repeat(201) },
      { ...accept, confirmed: false },
      { decision: "accept", acceptedByName: "Name" },
    ])
      await expect(decidePublicAgreementByToken(token, input, {}, now)).rejects.toThrow()
    expect(await prisma.publicLinkAttempt.count({ where: { documentId: ctx.agreement.id } })).toBe(
      4,
    )
    expect((await ctx.get()).status).toBe("sent")
  })
  it("read survives offer expiry and accepted cancellation, rejects decide POST, and revokes explicitly", async () => {
    const ctx = await setup()
    const issued = await ctx.issue("customer@example.test")
    const token = (await decidePublicAgreementByToken(await ctx.link(), accept, {}, now)).readLink!
      .token
    expect(
      await loadPublicAgreementByToken(token, getAgreementPublicSecret(), issued.expiresAt!),
    ).not.toBeNull()
    await expect(decidePublicAgreementByToken(token, accept, {}, now)).rejects.toMatchObject({
      code: "invalid",
    })
    const key = (await ctx.get()).publicAccessKeyVersion
    completed(
      await ctx.run(closeAgreement, { id: issued.id, disposition: "cancelled", reason: "Stopped" }),
    )
    expect((await ctx.get()).publicAccessKeyVersion).toBe(key)
    expect(
      await loadPublicAgreementByToken(token, getAgreementPublicSecret(), issued.expiresAt!),
    ).not.toBeNull()
    completed(await ctx.run(revokeAgreementLinks, { id: issued.id }))
    expect(await loadPublicAgreementByToken(token, getAgreementPublicSecret(), now)).toBeNull()
  })
  it("internal acceptance requires a person and evidence, rotates decide links and notifies both parties", async () => {
    const ctx = await setup()
    const issued = await ctx.issue("customer@example.test")
    const old = await ctx.link()
    const id = issued.id
    completed(
      await ctx.run(recordAgreementAcceptance, {
        id,
        acceptedByName: "Name",
        evidenceNote: "Customer signed offline",
      }),
    )
    expect(await ctx.get()).toMatchObject({
      status: "accepted",
      acceptanceMethod: "internal",
      acceptanceEvidenceNote: "Customer signed offline",
      publicAccessKeyVersion: issued.publicAccessKeyVersion + 1,
    })
    expect(await loadPublicAgreementByToken(old, getAgreementPublicSecret(), now)).toBeNull()
    expect(await findEmailDeliveryJobs(ctx.org.organizationId)).toHaveLength(2)
    rejected(await ctx.run(recallAgreement, { id }), "not_recallable")
    rejected(
      await ctx.run(recordAgreementAcceptance, {
        id,
        acceptedByName: "Name",
        evidenceNote: "Again",
      }),
      "not_sent",
    )
    const agent = {
      ...(await ctx.agent()),
      mode: "full_access" as const,
      scopes: [
        "agreement:accept",
        "agreement:close",
        "agreement:update",
      ] as import("../../permissions").Permission[],
    }
    for (const [command, input] of [
      [recordAgreementAcceptance, { id, acceptedByName: "Name", evidenceNote: "Proof" }],
      [recallAgreement, { id }],
      [closeAgreement, { id, disposition: "cancelled", reason: "No" }],
      [revokeAgreementLinks, { id }],
    ] as Array<[AnyCommandDefinition, object]>)
      expect(await executeIssuanceCommand(command, input, { actor: agent, now })).toMatchObject({
        status: "failed",
        error: { tag: "Forbidden" },
      })
    expect(getCommandDefinition("agreement.customer_decision")).toBeUndefined()
    expect(
      agreementTools.some((tool) => /recall|record_acceptance|close|revoke/.test(tool.name)),
    ).toBe(false)
    expect(
      agreementTools
        .filter((tool) =>
          [
            "agreement_send",
            "agreement_issue",
            "agreement_resend",
            "agreement_send_read_link",
          ].includes(tool.name),
        )
        .map((tool) => tool.permission),
    ).toEqual(Array(4).fill("agreement:send"))
    expect(
      await executeIssuanceCommand(
        recordAgreementCustomerDecision,
        { token: old, decision: accept },
        { actor: ctx.actor, now },
      ),
    ).toMatchObject({ status: "failed", error: { tag: "Forbidden" } })
  })
  it("cancels only non-invoiced lines, rejects reserved lines and rotates sent links", async () => {
    const ctx = await setup()
    const issued = await ctx.issue()
    const old = await ctx.link()
    const id = issued.id
    await prisma.deliverable.update({
      where: { id: issued.deliverables[0]!.id },
      data: { billingStatus: "reserved" },
    })
    rejected(
      await ctx.run(closeAgreement, { id, disposition: "cancelled", reason: "Stopped" }),
      "reserved_deliverables",
    )
    await prisma.deliverable.update({
      where: { id: issued.deliverables[0]!.id },
      data: { billingStatus: "invoiced" },
    })
    completed(await ctx.run(closeAgreement, { id, disposition: "cancelled", reason: "Stopped" }))
    expect((await ctx.get()).deliverables[0]!.status).toBe("planned")
    expect(await loadPublicAgreementByToken(old, getAgreementPublicSecret(), now)).toBeNull()
    rejected(
      await ctx.run(closeAgreement, { id, disposition: "cancelled", reason: "Again" }),
      "not_closable",
    )
    expect(
      await ctx.run(closeAgreement, { id, disposition: "completed", reason: "Done" }),
    ).toMatchObject({ status: "failed", error: { code: "not_closable" } })
  })
  it("recovers notifications without markers, and renewals have independent dedupe keys", async () => {
    const ctx = await setup()
    await ctx.issue("customer@example.test")
    vi.mocked(deliver).mockRejectedValue(new Error("network timeout"))
    await decidePublicAgreementByToken(await ctx.link(), accept, {}, now)
    const before = await ctx.get()
    expect(before.status).toBe("accepted")
    expect(before.lastEmailAttemptAt).toBeNull()
    vi.mocked(deliver).mockResolvedValue({ id: "recovered" })
    await retryEmailDeliveries(ctx.org.organizationId)
    completed(await ctx.run(sendAgreementReadLink, { id: before.id }))
    completed(
      await ctx.run(sendAgreementReadLink, { id: before.id }, new Date(now.getTime() + 1000)),
    )
    const jobs = await findEmailDeliveryJobs(ctx.org.organizationId)
    expect(new Set(jobs.map((job) => job.dedupeKey)).size).toBe(4)
    expect(jobs.every((job) => (job.result as { outcome: string }).outcome === "delivered")).toBe(
      true,
    )
    expect((await ctx.get()).lastEmailAttemptAt).toEqual(before.lastEmailAttemptAt)
    expect((await ctx.get()).publicAccessKeyVersion).toBe(before.publicAccessKeyVersion)
    const abandoned = jobs[0]!
    await prisma.job.update({
      where: { id: abandoned.id },
      data: {
        status: "failed",
        claimToken: null,
        result: Prisma.DbNull,
        payload: { ...(abandoned.payload as object), providerMessageId: "accepted-before-crash" },
      },
    })
    vi.mocked(deliver).mockClear()
    expect(
      await settleAbandonedDeliveries({ organizationIds: [ctx.org.organizationId] }),
    ).toMatchObject({ settled: 1, failed: 0 })
    expect(deliver).not.toHaveBeenCalled()
    expect((await ctx.get()).status).toBe("accepted")
  })
  it("manual issuance without a recipient sends no customer email", async () => {
    const ctx = await setup()
    await ctx.issue()
    await decidePublicAgreementByToken(await ctx.link(), accept, {}, now)
    const jobs = await findEmailDeliveryJobs(ctx.org.organizationId)
    expect(jobs).toHaveLength(1)
    expect((jobs[0]!.payload as { message: { to: string } }).message.to).not.toBe(ctx.contact.email)
    rejected(await ctx.run(sendAgreementReadLink, { id: ctx.agreement.id }), "missing_recipient")
  })
  it("expires once and refuses new decisions at expiry", async () => {
    const ctx = await setup()
    const issued = await ctx.issue()
    await expect(
      decidePublicAgreementByToken(await ctx.link(), accept, {}, issued.expiresAt!),
    ).rejects.toMatchObject({ code: "expired" })
    expect(
      await runAgreementExpiryTask(issued.expiresAt!, {
        organizationIds: [ctx.org.organizationId],
      }),
    ).toMatchObject({ marked: 1, failed: 0 })
    expect((await ctx.get()).status).toBe("expired")
    expect(
      await runAgreementExpiryTask(issued.expiresAt!, {
        organizationIds: [ctx.org.organizationId],
      }),
    ).toMatchObject({ marked: 0, failed: 0 })
  })
  it.each(["recall", "expire"])(
    "serializes concurrent accept versus %s without overwriting a decision",
    async (racer) => {
      for (let i = 0; i < 4; i++) {
        const ctx = await setup()
        const issued = await ctx.issue()
        const token = await ctx.link()
        await Promise.allSettled([
          decidePublicAgreementByToken(
            token,
            accept,
            {},
            new Date(issued.expiresAt!.getTime() - 1),
          ),
          racer === "recall"
            ? ctx.run(recallAgreement, { id: issued.id })
            : executeIssuanceCommand(
                expireOrganizationAgreements,
                {},
                {
                  actor: {
                    kind: "system",
                    reason: "scheduler",
                    organizationId: ctx.org.organizationId,
                    label: "Scheduler",
                  },
                  now: issued.expiresAt!,
                },
              ),
        ])
        const current = await ctx.get()
        expect(["accepted", racer === "recall" ? "draft" : "expired"]).toContain(current.status)
        expect(
          await prisma.domainEvent.count({
            where: {
              aggregateId: issued.id,
              type: {
                in: [
                  "agreement.accepted",
                  racer === "recall" ? "agreement.offer_recalled" : "agreement.expired",
                ],
              },
            },
          }),
        ).toBe(1)
        expect(current.acceptedAt !== null).toBe(current.status === "accepted")
      }
    },
  )
  it("limits identity across tokens and counts concurrent submissions separately per target", async () => {
    const ctx = await setup()
    await ctx.issue()
    const row = await ctx.get()
    const first = verifyAgreementPublicToken(await ctx.link(), getAgreementPublicSecret())!
    for (let i = 0; i < 10; i++) {
      const token = signAgreementPublicToken(
        { ...first, exp: new Date(row.expiresAt!.getTime() - i).toISOString() },
        getAgreementPublicSecret(),
      )
      await expect(
        decidePublicAgreementByToken(token, { ...accept, confirmed: false }, {}, now),
      ).rejects.toThrow()
    }
    await expect(
      decidePublicAgreementByToken(await ctx.link(), accept, {}, now),
    ).rejects.toMatchObject({ code: "retry_later" })
    const base = {
      documentKind: "agreement" as const,
      documentId: ctx.agreement.id,
      scope: "sign_off",
      keyVersion: 1,
      revision: 1,
    }
    for (let i = 0; i < 11; i++)
      await recordPublicLinkAttempt({ ...base, targetId: `deliverable-${i}` }, now)
    const concurrent = await Promise.allSettled(
      Array.from({ length: 12 }, () =>
        recordPublicLinkAttempt({ ...base, targetId: "one-target" }, now),
      ),
    )
    expect(concurrent.filter((r) => r.status === "fulfilled")).toHaveLength(10)
    expect(concurrent.filter((r) => r.status === "rejected")).toHaveLength(2)
  })

  it.each(["draft", "sent", "accepted", "declined", "expired", "completed", "cancelled"])(
    "refuses disallowed transition commands from %s",
    async (status) => {
      const ctx = await setup()
      const id = ctx.agreement.id
      if (status !== "draft") {
        await ctx.issue()
        await prisma.agreement.update({ where: { id }, data: { status } })
      }
      const cases: Array<[AnyCommandDefinition, object, string]> = []
      if (status !== "draft")
        cases.push(
          [sendAgreement, { id }, "not_draft"],
          [issueAgreement, { id }, "not_draft"],
          [updateAgreementDraft, { id, title: "Changed" }, "not_draft"],
          [deleteAgreementDraft, { id }, "not_draft"],
          [
            updateDeliverable,
            { id: ctx.agreement.deliverables[0]!.id, agreementId: id, title: "Changed" },
            "not_draft",
          ],
        )
      if (status !== "sent")
        cases.push(
          [resendAgreement, { id }, "not_sent"],
          [
            recordAgreementAcceptance,
            { id, acceptedByName: "Name", evidenceNote: "Evidence" },
            "not_sent",
          ],
        )
      if (!["sent", "expired", "declined"].includes(status))
        cases.push([recallAgreement, { id }, "not_recallable"])
      if (!["sent", "accepted"].includes(status))
        cases.push([
          closeAgreement,
          { id, disposition: "cancelled", reason: "Reason" },
          "not_closable",
        ])
      for (const [command, input, code] of cases) rejected(await ctx.run(command, input), code)
    },
  )
  it("unconfirmed send settles as sent with the original issuance; rejected resend remains sent", async () => {
    const ctx = await setup()
    const id = ctx.agreement.id
    vi.mocked(deliver).mockRejectedValueOnce(new Error("connection lost"))
    completed(await ctx.run(sendAgreement, { id }))
    const pending = await ctx.get()
    expect(pending.lastEmailAttemptOutcome).toBe("sending")
    const job = (await findEmailDeliveryJobs(ctx.org.organizationId))[0]!
    await prisma.job.update({
      where: { id: job.id },
      data: { status: "failed", attempts: 5, claimToken: null },
    })
    expect(
      await settleAbandonedDeliveries({ organizationIds: [ctx.org.organizationId] }),
    ).toMatchObject({ settled: 1, failed: 0 })
    const issued = await ctx.get()
    expect(issued).toMatchObject({ status: "sent", lastEmailAttemptOutcome: "unconfirmed" })
    expect(identity(issued)).toEqual(identity(pending))
    vi.mocked(deliver).mockRejectedValueOnce(
      new EmailSendError("validation_error", "bad recipient"),
    )
    completed(await ctx.run(resendAgreement, { id }, new Date(now.getTime() + 1000)))
    expect(await ctx.get()).toMatchObject({
      status: "sent",
      lastEmailAttemptOutcome: "failed",
      offerRevision: 1,
    })
    completed(await ctx.run(recallAgreement, { id }))
  })
  it("sweeps only attempts older than one day and limits quote decisions too", async () => {
    const ctx = await setup()
    const base = {
      documentKind: "quote" as const,
      documentId: ctx.agreement.id,
      scope: "quote_public",
      keyVersion: 1,
      revision: 0,
      targetId: null,
    }
    await recordPublicLinkAttempt(base, new Date(now.getTime() - 25 * 3600_000))
    await recordPublicLinkAttempt(base, now)
    await sweepPublicLinkAttempts(now)
    expect(
      await prisma.publicLinkAttempt.count({
        where: { documentId: base.documentId, documentKind: "quote" },
      }),
    ).toBe(1)
    const { signQuotePublicToken } = await import("../../../lib/quotes/public")
    const { decidePublicQuoteByToken } = await import("../../../lib/quotes/public-access")
    const invalidToken = signQuotePublicToken(
      { quoteId: `${base.documentId}-invalid`, keyVersion: 1, scope: "quote_public" },
      "quote-rate-test",
    )
    await expect(
      decidePublicQuoteByToken(invalidToken, "quote-rate-test", { decision: "invalid" }),
    ).rejects.toBeDefined()
    expect(
      await prisma.publicLinkAttempt.count({
        where: { documentId: `${base.documentId}-invalid`, documentKind: "quote" },
      }),
    ).toBe(1)
    const token = signQuotePublicToken(
      { quoteId: base.documentId, keyVersion: 1, scope: "quote_public" },
      "quote-rate-test",
    )
    for (let i = 0; i < 9; i++)
      await expect(
        decidePublicQuoteByToken(token, "quote-rate-test", { decision: "accepted" }),
      ).rejects.toThrow("Quote not found")
    await expect(
      decidePublicQuoteByToken(token, "quote-rate-test", { decision: "accepted" }),
    ).rejects.toMatchObject({ code: "retry_later" })
  })

  it("public DTO excludes private request evidence, internal notes and operational history", async () => {
    const ctx = await setup()
    await ctx.issue()
    await decidePublicAgreementByToken(
      await ctx.link(),
      accept,
      { ip: "192.0.2.99", userAgent: "secret-agent" },
      now,
    )
    const text = JSON.stringify(publicAgreementDto(await ctx.get()))
    for (const field of [
      "notes",
      "acceptanceIp",
      "acceptanceUserAgent",
      "acceptanceEvidenceNote",
      "expectedDateHistory",
      "lastEmailAttempt",
      "organizationId",
      "contactId",
      "private-secret",
      "192.0.2.99",
      "secret-agent",
    ])
      expect(text).not.toContain(field)
  })
})
