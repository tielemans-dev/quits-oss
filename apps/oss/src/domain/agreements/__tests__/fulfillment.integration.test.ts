import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { prisma } from "../../../lib/db"
import { createTestOrganization, hasTestDatabase } from "../../../test-utils/organization"
import { executeCommand, type CommandOutcome } from "../../execute"
import type { AnyCommandDefinition } from "../../command"
import type { Actor } from "../../actor"
import { createAgreementDraft, updateDeliverable } from "../../commands/agreements"
import { issueAgreement, recordAgreementAcceptance } from "../../commands/agreement-lifecycle"
import {
  markDeliverableDelivered,
  acceptDeliverable,
  cancelDeliverable,
} from "../../commands/deliverables"
import { getAgreement, serializeAgreementDetail } from "../queries"
import { createAgentKey, authenticateAgentSecret } from "../../agent-keys"
import { decideApproval } from "../../approvals"
import { agreementTools } from "../../agent-tools/tools/agreements"
import { agentScopePresets } from "@quits/contracts/agent"
import { publicAgreementDto } from "../../../lib/agreements/public"
import { loadPublicAgreementByToken } from "../../../lib/agreements/public-access"
import { mintAgreementLink } from "../../../lib/agreements/tokens"

const cleanups: Array<() => Promise<void>> = []
const now = new Date()
const statuses = [
  "planned",
  "in_progress",
  "delivered",
  "accepted",
  "changes_requested",
  "cancelled",
] as const
const agreementStates = [
  "draft",
  "sent",
  "accepted",
  "completed",
  "cancelled",
  "declined",
  "expired",
] as const
const acceptance = {
  acceptedAt: now,
  acceptedRevision: 3,
  acceptedVia: "internal",
  acceptanceEvidenceNote: "Customer confirmed the delivery",
}
function completed<T>(outcome: CommandOutcome<T>): T {
  expect(outcome.status, JSON.stringify(outcome)).toBe("completed")
  if (outcome.status !== "completed") throw new Error(JSON.stringify(outcome))
  return outcome.result
}
function refused(outcome: CommandOutcome<unknown>, code: string) {
  expect(outcome).toMatchObject({ status: "failed", error: { code } })
}
async function setup(accepted = true) {
  const org = await createTestOrganization({
    roles: ["admin", "member", "accountant"],
  })
  cleanups.push(org.cleanup)
  const actor = org.actors.admin
  const run = (
    command: AnyCommandDefinition,
    input: object,
    as: Actor = actor,
    clientRequestId?: string,
  ) => executeCommand(command, input, { actor: as, now, clientRequestId })
  const contact = await prisma.contact.create({
    data: { organizationId: org.organizationId, name: "Customer" },
  })
  const agreement = completed(
    await run(createAgreementDraft, {
      title: "Work",
      contactId: contact.id,
      validUntil: "2099-12-01",
      deliverables: [
        {
          title: "Website",
          quantity: 1,
          unitPrice: 700,
          agreedDate: "2099-11-01",
        },
        { title: "Deposit", quantity: 1, unitPrice: 300, isDeposit: true },
      ],
    }),
  ) as Awaited<ReturnType<typeof getAgreement>>
  if (accepted) {
    completed(await run(issueAgreement, { id: agreement.id }))
    completed(
      await run(recordAgreementAcceptance, {
        id: agreement.id,
        acceptedByName: "Customer",
        evidenceNote: "Written confirmation",
      }),
    )
  }
  const id = agreement.deliverables[0]!.id
  const input = { agreementId: agreement.id, id }
  const line = () => prisma.deliverable.findUniqueOrThrow({ where: { id } })
  const get = () => getAgreement(org.organizationId, agreement.id)
  return { org, actor, run, agreement, input, line, get }
}
beforeEach(() => {
  vi.stubEnv("BETTER_AUTH_SECRET", "fulfillment-test-secret-over-32-characters")
  vi.stubEnv("RESEND_API_KEY", "")
})
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
  vi.unstubAllEnvs()
})

describe.runIf(hasTestDatabase)("deliverable fulfillment transition table", () => {
  for (const status of statuses) {
    it(`update to in_progress from ${status}`, async () => {
      const ctx = await setup()
      await prisma.deliverable.update({
        where: { id: ctx.input.id },
        data: { status, deliveryRevision: 3, ...acceptance },
      })
      const result = await ctx.run(updateDeliverable, {
        ...ctx.input,
        status: "in_progress",
      })
      if (["planned", "delivered", "accepted"].includes(status)) {
        completed(result)
        expect(await ctx.line()).toMatchObject({
          status: "in_progress",
          deliveryRevision: 3,
          acceptedAt: null,
          acceptedRevision: null,
          acceptedVia: null,
          acceptanceEvidenceNote: null,
        })
      } else refused(result, "invalid_transition")
    })
    it(`mark_delivered from ${status}`, async () => {
      const ctx = await setup()
      await prisma.deliverable.update({
        where: { id: ctx.input.id },
        data: {
          status,
          deliveryRevision: 3,
          changeRequestNote: "Revise the work",
          ...acceptance,
        },
      })
      const jobsBefore = await prisma.job.count({
        where: { organizationId: ctx.org.organizationId },
      })
      const result = await ctx.run(markDeliverableDelivered, ctx.input)
      if (["planned", "in_progress", "changes_requested"].includes(status)) {
        completed(result)
        expect(await ctx.line()).toMatchObject({
          status: "delivered",
          deliveryRevision: 4,
          deliveredAt: now,
          acceptedAt: null,
          acceptedRevision: null,
          acceptedVia: null,
          acceptanceEvidenceNote: null,
          changeRequestNote: null,
        })
        expect(
          await prisma.domainEvent.count({
            where: {
              organizationId: ctx.org.organizationId,
              type: "deliverable.delivered",
            },
          }),
        ).toBe(1)
        expect(
          await prisma.job.count({
            where: { organizationId: ctx.org.organizationId },
          }),
        ).toBe(jobsBefore)
      } else refused(result, "invalid_transition")
    })
    it(`accept from ${status}`, async () => {
      const ctx = await setup()
      await prisma.deliverable.update({
        where: { id: ctx.input.id },
        data: { status, deliveryRevision: 3 },
      })
      const result = await ctx.run(acceptDeliverable, {
        ...ctx.input,
        evidenceNote: "  Confirmed by email  ",
      })
      if (status === "delivered") {
        completed(result)
        expect(await ctx.line()).toMatchObject({
          status: "accepted",
          deliveryRevision: 3,
          acceptedAt: now,
          acceptedRevision: 3,
          acceptedVia: "internal",
          acceptanceEvidenceNote: "Confirmed by email",
        })
      } else refused(result, "invalid_transition")
    })
    it(`cancel from ${status}`, async () => {
      const ctx = await setup()
      await prisma.deliverable.update({
        where: { id: ctx.input.id },
        data: { status },
      })
      const result = await ctx.run(cancelDeliverable, ctx.input)
      if (status !== "cancelled") {
        completed(result)
        expect(await ctx.line()).toMatchObject({
          status: "cancelled",
          billingStatus: "unbilled",
        })
      } else refused(result, "invalid_transition")
    })
    it(`expectedDate is editable without changing ${status} or its evidence`, async () => {
      const ctx = await setup()
      await prisma.deliverable.update({
        where: { id: ctx.input.id },
        data: { status, deliveryRevision: 3, ...acceptance },
      })
      completed(
        await ctx.run(updateDeliverable, {
          ...ctx.input,
          expectedDate: "2099-11-02",
        }),
      )
      expect(await ctx.line()).toMatchObject({
        status,
        deliveryRevision: 3,
        ...acceptance,
        expectedDate: new Date("2099-11-02"),
      })
      completed(
        await ctx.run(updateDeliverable, {
          ...ctx.input,
          expectedDate: null,
        }),
      )
      expect((await ctx.line()).expectedDate).toBeNull()
    })
  }
  for (const state of agreementStates) {
    it(`fulfillment and date/commercial edits on ${state} agreement`, async () => {
      const ctx = await setup()
      await prisma.agreement.update({
        where: { id: ctx.agreement.id },
        data: { status: state },
      })
      const before = await ctx.get()
      const result = await ctx.run(updateDeliverable, {
        ...ctx.input,
        title: "Changed title",
      })
      if (state === "draft") completed(result)
      else refused(result, "not_draft")
      completed(
        await ctx.run(updateDeliverable, {
          ...ctx.input,
          expectedDate: "2099-11-02",
        }),
      )
      expect(await ctx.get()).toMatchObject({
        offerSnapshotHash: before.offerSnapshotHash,
        offerSnapshot: before.offerSnapshot,
        totalGross: before.totalGross,
      })
      for (const [command, status, extra] of [
        [updateDeliverable, "planned", { status: "in_progress" }],
        [updateDeliverable, "accepted", { status: "in_progress" }],
        [markDeliverableDelivered, "planned", {}],
        [acceptDeliverable, "delivered", { evidenceNote: "Confirmed" }],
        [cancelDeliverable, "planned", {}],
      ] as const) {
        await prisma.deliverable.update({
          where: { id: ctx.input.id },
          data: { status },
        })
        const outcome = await ctx.run(command, { ...ctx.input, ...extra })
        if (state === "accepted") completed(outcome)
        else refused(outcome, "not_accepted")
      }
    })
  }
  for (const billingStatus of ["reserved", "invoiced"] as const) {
    for (const status of ["delivered", "accepted"] as const) {
      it(`cannot reopen ${status} while ${billingStatus}`, async () => {
        const ctx = await setup()
        await prisma.deliverable.update({
          where: { id: ctx.input.id },
          data: { status, billingStatus, ...acceptance },
        })
        const before = await ctx.line()
        refused(
          await ctx.run(updateDeliverable, {
            ...ctx.input,
            status: "in_progress",
            expectedDate: "2099-11-02",
          }),
          "not_unbilled",
        )
        expect(await ctx.line()).toEqual(before)
      })
    }
    for (const status of statuses.filter((status) => status !== "cancelled")) {
      it(`cannot cancel ${status} while ${billingStatus}`, async () => {
        const ctx = await setup()
        await prisma.deliverable.update({
          where: { id: ctx.input.id },
          data: { status, billingStatus },
        })
        refused(await ctx.run(cancelDeliverable, ctx.input), "not_unbilled")
        expect((await ctx.line()).status).toBe(status)
      })
    }
    it(`delivery and acceptance remain allowed while ${billingStatus}`, async () => {
      const ctx = await setup()
      await prisma.deliverable.update({
        where: { id: ctx.input.id },
        data: { billingStatus },
      })
      completed(await ctx.run(markDeliverableDelivered, ctx.input))
      completed(
        await ctx.run(acceptDeliverable, {
          ...ctx.input,
          evidenceNote: "Confirmed",
        }),
      )
    })
  }
  it("deposits only remain planned or become cancelled", async () => {
    const ctx = await setup()
    const id = ctx.agreement.deliverables.find((line) => line.isDeposit)!.id
    const input = { ...ctx.input, id }
    refused(await ctx.run(updateDeliverable, { ...input, status: "in_progress" }), "deposit_line")
    refused(await ctx.run(markDeliverableDelivered, input), "deposit_line")
    refused(
      await ctx.run(acceptDeliverable, {
        ...input,
        evidenceNote: "Confirmed",
      }),
      "deposit_line",
    )
    completed(
      await ctx.run(updateDeliverable, {
        ...input,
        expectedDate: "2099-10-01",
      }),
    )
    expect((await prisma.deliverable.findUniqueOrThrow({ where: { id } })).status).toBe("planned")
    completed(await ctx.run(cancelDeliverable, input))
    expect((await prisma.deliverable.findUniqueOrThrow({ where: { id } })).status).toBe("cancelled")
  })
  it("acceptance requires a nonempty evidence note and refuses agents and system actors", async () => {
    const ctx = await setup()
    completed(await ctx.run(markDeliverableDelivered, ctx.input))
    for (const evidenceNote of [undefined, "", "   "])
      expect(await ctx.run(acceptDeliverable, { ...ctx.input, evidenceNote })).toMatchObject({
        status: "failed",
        error: { tag: "ValidationFailed" },
      })
    const agent = await authenticateAgentSecret(
      (
        await createAgentKey(ctx.actor, {
          name: "Worker",
          mode: "full_access",
          scopes: ["deliverable:accept", "deliverable:update"],
        })
      ).secret,
    )
    for (const as of [
      agent,
      {
        kind: "system",
        organizationId: ctx.org.organizationId,
        reason: "customer_link",
        label: "Customer",
      } as const,
    ])
      for (const [command, extra] of [
        [acceptDeliverable, { evidenceNote: "Confirmed" }],
        [cancelDeliverable, {}],
      ] as const)
        expect(await ctx.run(command, { ...ctx.input, ...extra }, as)).toMatchObject({
          status: "failed",
          error: { tag: "Forbidden" },
        })
    expect((await ctx.line()).status).toBe("delivered")
    expect(
      agreementTools.some((tool) =>
        ["deliverable.accept", "deliverable.cancel"].includes(tool.commandType ?? ""),
      ),
    ).toBe(false)
  })
  it("refuses every deliverable mutation while agreement delivery is pending", async () => {
    const ctx = await setup()
    await prisma.agreement.update({
      where: { id: ctx.agreement.id },
      data: { lastEmailAttemptOutcome: "sending" },
    })
    for (const [command, extra] of [
      [updateDeliverable, { expectedDate: "2099-11-02" }],
      [updateDeliverable, { status: "in_progress" }],
      [markDeliverableDelivered, {}],
      [acceptDeliverable, { evidenceNote: "Confirmed" }],
      [cancelDeliverable, {}],
    ] as const)
      refused(await ctx.run(command, { ...ctx.input, ...extra }), "send_in_progress")
  })
  it("isolates the parent organization and child membership and refuses accountants", async () => {
    const ctx = await setup()
    const other = await setup()
    for (const [command, extra] of [
      [updateDeliverable, { expectedDate: "2099-11-02" }],
      [markDeliverableDelivered, {}],
      [acceptDeliverable, { evidenceNote: "Confirmed" }],
      [cancelDeliverable, {}],
    ] as const) {
      expect(await ctx.run(command, { ...ctx.input, ...extra }, other.actor)).toMatchObject({
        status: "failed",
        error: { tag: "NotFound" },
      })
      expect(
        await ctx.run(command, {
          ...ctx.input,
          id: other.input.id,
          ...extra,
        }),
      ).toMatchObject({ status: "failed", error: { tag: "NotFound" } })
      expect(
        await ctx.run(command, { ...ctx.input, ...extra }, ctx.org.actors.accountant),
      ).toMatchObject({ status: "failed", error: { tag: "Forbidden" } })
    }
  })
  it("snapshot edits work on drafts and invalid combined edits are atomic", async () => {
    const ctx = await setup(false)
    completed(
      await ctx.run(updateDeliverable, {
        ...ctx.input,
        title: "New title",
        unitPrice: 750,
        agreedDate: "2099-11-03",
        expectedDate: "2099-11-04",
      }),
    )
    expect(await ctx.line()).toMatchObject({
      title: "New title",
      agreedDate: new Date("2099-11-03"),
      expectedDate: new Date("2099-11-04"),
    })
    const before = await ctx.line()
    refused(
      await ctx.run(updateDeliverable, {
        ...ctx.input,
        title: "Cannot start yet",
        status: "in_progress",
      }),
      "not_accepted",
    )
    expect(await ctx.line()).toEqual(before)
  })
  it("clears acceptance on reopen and redelivery and retains evidence in events", async () => {
    const ctx = await setup()
    completed(await ctx.run(markDeliverableDelivered, ctx.input))
    completed(
      await ctx.run(acceptDeliverable, {
        ...ctx.input,
        evidenceNote: "First confirmation",
      }),
    )
    completed(
      await ctx.run(updateDeliverable, {
        ...ctx.input,
        status: "in_progress",
      }),
    )
    completed(await ctx.run(markDeliverableDelivered, ctx.input))
    expect(await ctx.line()).toMatchObject({
      deliveryRevision: 2,
      acceptedAt: null,
      acceptedRevision: null,
      acceptedVia: null,
      acceptanceEvidenceNote: null,
    })
    // Phase 3 will enter changes_requested; seed it to verify the Phase 1c redelivery row.
    await prisma.deliverable.update({
      where: { id: ctx.input.id },
      data: { status: "changes_requested", ...acceptance },
    })
    completed(await ctx.run(markDeliverableDelivered, ctx.input))
    const events = await prisma.domainEvent.findMany({
      where: {
        organizationId: ctx.org.organizationId,
        aggregateId: ctx.agreement.id,
      },
      orderBy: { sequence: "asc" },
    })
    expect(events.find((event) => event.type === "deliverable.accepted")?.payload).toMatchObject({
      acceptedRevision: 1,
      acceptanceEvidenceNote: "First confirmation",
    })
    expect(events.find((event) => event.type === "deliverable.updated")?.payload).toMatchObject({
      previousAcceptance: {
        acceptedRevision: 1,
        acceptanceEvidenceNote: "First confirmation",
      },
    })
    expect(
      events.filter((event) => event.type === "deliverable.delivered").at(-1)?.payload,
    ).toMatchObject({
      deliveryRevision: 3,
      previousAcceptance: {
        acceptedRevision: 3,
        acceptanceEvidenceNote: acceptance.acceptanceEvidenceNote,
      },
    })
    expect(await ctx.line()).toMatchObject({
      deliveryRevision: 3,
      acceptedAt: null,
      acceptedRevision: null,
      acceptedVia: null,
      acceptanceEvidenceNote: null,
    })
  })
  for (const changed of ["reopened", "redelivered"] as const) {
    it(`refuses a stale delivery approval after work is ${changed}`, async () => {
      const ctx = await setup()
      completed(
        await ctx.run(updateDeliverable, {
          ...ctx.input,
          status: "in_progress",
        }),
      )
      const agent = await authenticateAgentSecret(
        (
          await createAgentKey(ctx.actor, {
            name: "Worker",
            mode: "approval_required",
            scopes: ["deliverable:deliver"],
          })
        ).secret,
      )
      const queued = await ctx.run(
        markDeliverableDelivered,
        ctx.input,
        agent,
        `delivery-${changed}`,
      )
      expect(queued.status).toBe("awaiting_approval")
      if (queued.status !== "awaiting_approval") throw new Error(JSON.stringify(queued))
      const request = await prisma.approvalRequest.findUniqueOrThrow({
        where: { id: queued.approvalRequestId },
      })
      expect(request.reviewContext).toMatchObject({
        version: `${ctx.input.id}:in_progress:0`,
        details: {
          agreementNumber: (await ctx.get()).number,
          deliverableTitle: "Website",
          status: "in_progress",
          deliveryRevision: 0,
        },
      })
      completed(await ctx.run(markDeliverableDelivered, ctx.input))
      completed(
        await ctx.run(updateDeliverable, {
          ...ctx.input,
          status: "in_progress",
        }),
      )
      if (changed === "redelivered") completed(await ctx.run(markDeliverableDelivered, ctx.input))
      const before = await ctx.line()
      refused(
        await decideApproval({
          approvalRequestId: queued.approvalRequestId,
          decider: ctx.actor,
          decision: "approve",
        }),
        "changed_since_review",
      )
      expect(await ctx.line()).toEqual(before)
    })
  }
  it("refuses invalid delivery approvals before queuing", async () => {
    const ctx = await setup()
    const agent = await authenticateAgentSecret(
      (
        await createAgentKey(ctx.actor, {
          name: "Worker",
          mode: "approval_required",
          scopes: ["deliverable:deliver"],
        })
      ).secret,
    )
    const depositId = ctx.agreement.deliverables.find((line) => line.isDeposit)!.id
    refused(
      await ctx.run(markDeliverableDelivered, { ...ctx.input, id: depositId }, agent, "deposit"),
      "deposit_line",
    )
    for (const status of ["delivered", "accepted", "cancelled"]) {
      await prisma.deliverable.update({ where: { id: ctx.input.id }, data: { status } })
      refused(
        await ctx.run(markDeliverableDelivered, ctx.input, agent, status),
        "invalid_transition",
      )
    }
    await prisma.deliverable.update({ where: { id: ctx.input.id }, data: { status: "planned" } })
    for (const status of agreementStates.filter((status) => status !== "accepted")) {
      await prisma.agreement.update({ where: { id: ctx.agreement.id }, data: { status } })
      refused(
        await ctx.run(markDeliverableDelivered, ctx.input, agent, `agreement-${status}`),
        "not_accepted",
      )
    }
    expect(
      await prisma.approvalRequest.count({ where: { organizationId: ctx.org.organizationId } }),
    ).toBe(0)
  })
  it("agent delivery approval, idempotency, scope preset, reads and progress", async () => {
    const ctx = await setup()
    const agent = await authenticateAgentSecret(
      (
        await createAgentKey(ctx.actor, {
          name: "Worker",
          mode: "approval_required",
          scopes: [
            "deliverable:deliver",
            "deliverable:read",
            "agreement:read",
            "deliverable:update",
          ],
        })
      ).secret,
    )
    const updateTool = agreementTools.find((tool) => tool.name === "deliverable_update")!
    expect(
      await updateTool.run(
        { actor: agent },
        { ...ctx.input, status: "in_progress", clientRequestId: "start" },
      ),
    ).toMatchObject({ status: "completed" })
    const tool = agreementTools.find((tool) => tool.name === "deliverable_mark_delivered")!
    const record = (await tool.run(
      { actor: agent },
      { ...ctx.input, clientRequestId: "delivery" },
    )) as { approvalRequestId: string }
    expect((await ctx.line()).status).toBe("in_progress")
    completed(
      await decideApproval({
        approvalRequestId: record.approvalRequestId,
        decider: ctx.actor,
        decision: "approve",
      }),
    )
    completed(await ctx.run(markDeliverableDelivered, ctx.input, agent, "delivery"))
    expect((await ctx.line()).deliveryRevision).toBe(1)
    completed(
      await ctx.run(acceptDeliverable, {
        ...ctx.input,
        evidenceNote: "Customer confirmed",
      }),
    )
    const agreementTool = agreementTools.find((tool) => tool.name === "agreement_get")!
    expect(await agreementTool.run({ actor: agent }, { id: ctx.agreement.id })).toMatchObject({
      progress: { accepted: 1, planned: 0, deposits: 1 },
      deliverables: expect.arrayContaining([
        expect.objectContaining({
          deliveryRevision: 1,
          acceptedRevision: 1,
          acceptedVia: "internal",
        }),
      ]),
    })
    const listTool = agreementTools.find((tool) => tool.name === "deliverable_list")!
    expect(await listTool.run({ actor: agent }, { agreementId: ctx.agreement.id })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "accepted",
          deliveryRevision: 1,
          acceptedRevision: 1,
          acceptanceEvidenceNote: "Customer confirmed",
        }),
      ]),
    )
    expect(serializeAgreementDetail(await ctx.get()).progress).toEqual({
      planned: 0,
      in_progress: 0,
      delivered: 0,
      accepted: 1,
      changes_requested: 0,
      cancelled: 0,
      deposits: 1,
    })
    expect(agentScopePresets.drafting_assistant.scopes).toContain("deliverable:deliver")
  })
  it("public reads expose current expected dates beside immutable agreed dates without private evidence", async () => {
    const ctx = await setup()
    completed(
      await ctx.run(updateDeliverable, {
        ...ctx.input,
        expectedDate: "2099-11-02",
      }),
    )
    completed(await ctx.run(markDeliverableDelivered, ctx.input))
    completed(
      await ctx.run(acceptDeliverable, {
        ...ctx.input,
        evidenceNote: "Private evidence",
      }),
    )
    const token = mintAgreementLink(await ctx.get(), "read", now).token
    const loaded = await loadPublicAgreementByToken(token, undefined, now)
    expect(loaded).not.toBeNull()
    const dto = publicAgreementDto(loaded!.agreement)
    expect(dto.expectedDates).toEqual(["2099-11-02T00:00:00.000Z", null])
    expect(dto.snapshot.deliverables[0]!.agreedDate).toBe("2099-11-01T00:00:00.000Z")
    expect(JSON.stringify(dto)).not.toContain("Private evidence")
    expect(JSON.stringify(dto)).not.toContain("acceptanceEvidenceNote")
  })
})
