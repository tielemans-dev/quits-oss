import { afterEach, describe, expect, it, vi } from "vitest"
import { createTestOrganization, hasTestDatabase } from "../../../test-utils/organization"
import { prisma } from "../../../lib/db"
import { executeIssuanceCommand } from "../../../application/issuance"
import { createAgreementDraft, updateAgreementDraft, updateDeliverable } from "../../commands/agreements"
import { issueAgreement, recordAgreementAcceptance, recallAgreement } from "../../commands/agreement-lifecycle"
import { setRuntimeExtensions } from "../../../lib/runtime/extensions"
import { mintAgreementLink } from "../../../lib/agreements/tokens"
import { decidePublicAgreementByToken, loadPublicAgreementByToken } from "../../../lib/agreements/public-access"
import { appRouter } from "../../../trpc/router"
import { createAgentKey, authenticateAgentSecret } from "../../agent-keys"
import { getAgentTool } from "../../agent-tools/registry"
import { hashOfferSnapshot } from "../snapshot"
import { readAgreementOfferSnapshot, agreementOfferSnapshotV2Schema } from "@quits/contracts/agreements"
import type { CommandOutcome } from "../../execute"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  setRuntimeExtensions([])
  vi.unstubAllEnvs()
  for (const cleanup of cleanups.splice(0)) await cleanup()
})
function completed<T>(outcome: CommandOutcome<T>): T {
  expect(outcome.status, JSON.stringify(outcome)).toBe("completed")
  if (outcome.status !== "completed") throw new Error(JSON.stringify(outcome))
  return outcome.result
}
const disabled = () => setRuntimeExtensions([{ id: "deposit-test", resolveCapabilities: () => ({ agreements: { depositsEnabled: false } }) }])
const acceptance = { acceptedByName: "Synthetic customer", evidenceNote: "Synthetic written approval" }
const decision = { decision: "accept", acceptedByName: "Synthetic customer", confirmed: true }
const stored = (id: string) => prisma.agreement.findUniqueOrThrow({ where: { id }, include: { deliverables: { orderBy: { sortOrder: "asc" } } } })
async function fixture(deposit = true, issue = true) {
  vi.stubEnv("BETTER_AUTH_SECRET", "deposit-corrections-synthetic-secret-over-32-characters")
  const org = await createTestOrganization({ settings: { companyEmail: "seller@example.test" } })
  cleanups.push(org.cleanup)
  const actor = org.actors.admin
  const contact = await prisma.contact.create({ data: { organizationId: org.organizationId, name: "Synthetic customer", email: "customer@example.test" } })
  const draft = completed(await executeIssuanceCommand(createAgreementDraft, {
    contactId: contact.id, title: "Historical offer", validUntil: "2099-01-01", taxRate: "25",
    deliverables: [{ title: "Service", quantity: "1", unitPrice: "100" }, ...(deposit ? [{ title: "Advance", quantity: "1", unitPrice: "20", isDeposit: true }] : [])],
  }, { actor }))
  const agreement = issue ? completed(await executeIssuanceCommand(issueAgreement, { id: draft.id }, { actor })) : draft
  const caller = appRouter.createCaller({ session: { user: { id: actor.userId, email: "admin@example.test", name: "Admin" }, session: { activeOrganizationId: org.organizationId } } } as never)
  const token = issue ? mintAgreementLink(agreement, "decide", new Date()).token : ""
  return { org, actor, agreement, caller, token }
}

;(hasTestDatabase ? describe : describe.skip)("disabled deposit correction boundaries", () => {
  it.each(["public", "internal", "command"])("rejects first %s acceptance without changing frozen terms, evidence, events or notification jobs", async path => {
    const ctx = await fixture()
    const before = await stored(ctx.agreement.id)
    const events = await prisma.domainEvent.count({ where: { organizationId: ctx.org.organizationId } })
    const jobs = await prisma.job.count({ where: { organizationId: ctx.org.organizationId } })
    disabled()
    expect(await loadPublicAgreementByToken(ctx.token)).not.toBeNull()
    if (path === "public") await expect(decidePublicAgreementByToken(ctx.token, decision)).rejects.toMatchObject({ code: "deposits_disabled" })
    else if (path === "internal") await expect(ctx.caller.agreements.recordAcceptance({ id: before.id, ...acceptance })).rejects.toThrow("disabled")
    else expect(await executeIssuanceCommand(recordAgreementAcceptance, { id: before.id, ...acceptance }, { actor: ctx.actor })).toMatchObject({ status: "failed", error: { code: "deposits_disabled" } })
    expect(await stored(before.id)).toEqual(before)
    expect(await prisma.domainEvent.count({ where: { organizationId: ctx.org.organizationId } })).toBe(events)
    expect(await prisma.job.count({ where: { organizationId: ctx.org.organizationId } })).toBe(jobs)
  })

  it.each(["v1", "v2 schedule"])("uses frozen %s terms even if mutable deposit rows are cleared or cancelled", async format => {
    const ctx = await fixture()
    if (format === "v1") {
      const v2 = agreementOfferSnapshotV2Schema.parse(ctx.agreement.offerSnapshot)
      const { offerFormatVersion: _version, calculationVersion: _calculation, serviceTotal: _service, paymentSchedule: _schedule, originalInputs: _inputs, vatGroups: _groups, scheduleVatGroups: _scheduleGroups, ...v1 } = v2
      const snapshot = { ...v1, deliverables: v1.deliverables.map(line => ({ ...line, quantity: Number(line.quantity).toFixed(2) })) }
      await prisma.agreement.update({ where: { id: ctx.agreement.id }, data: { offerFormatVersion: 1, offerSnapshot: snapshot, offerSnapshotHash: hashOfferSnapshot(snapshot) } })
    } else {
      // The schedule remains authoritative even when no frozen line has a deposit flag.
      const snapshot = readAgreementOfferSnapshot(ctx.agreement.offerSnapshot)
      const changed = { ...snapshot, deliverables: snapshot.deliverables.map(line => ({ ...line, isDeposit: false })) }
      await prisma.agreement.update({ where: { id: ctx.agreement.id }, data: { offerSnapshot: changed, offerSnapshotHash: hashOfferSnapshot(changed) } })
    }
    await prisma.deliverable.updateMany({ where: { agreementId: ctx.agreement.id, isDeposit: true }, data: { isDeposit: false, status: "cancelled" } })
    const before = await stored(ctx.agreement.id)
    disabled()
    await expect(decidePublicAgreementByToken(ctx.token, decision)).rejects.toMatchObject({ code: "deposits_disabled" })
    await expect(ctx.caller.agreements.recordAcceptance({ id: before.id, ...acceptance })).rejects.toThrow("disabled")
    expect(await stored(before.id)).toEqual(before)
  })

  it("preserves enabled acceptance and disabled public replay/read access without replacing evidence", async () => {
    const ctx = await fixture()
    await decidePublicAgreementByToken(ctx.token, decision)
    const before = await stored(ctx.agreement.id)
    const jobs = await prisma.job.count({ where: { organizationId: ctx.org.organizationId } })
    disabled()
    const replay = await decidePublicAgreementByToken(ctx.token, { ...decision, acceptedByName: "Different name" })
    expect(replay.document.acceptance?.name).toBe(acceptance.acceptedByName)
    expect(await loadPublicAgreementByToken(replay.readLink!.token)).not.toBeNull()
    expect(await stored(before.id)).toEqual(before)
    expect(await prisma.job.count({ where: { organizationId: ctx.org.organizationId } })).toBe(jobs)
  })

  it("preserves internal accepted receipt replay while refusing a new acceptance command", async () => {
    const ctx = await fixture()
    const input = { id: ctx.agreement.id, ...acceptance }
    const options = { actor: ctx.actor, clientRequestId: "accepted-evidence" }
    completed(await executeIssuanceCommand(recordAgreementAcceptance, input, options))
    const before = await stored(ctx.agreement.id)
    disabled()
    completed(await executeIssuanceCommand(recordAgreementAcceptance, input, options))
    expect(await executeIssuanceCommand(recordAgreementAcceptance, input, { actor: ctx.actor })).toMatchObject({ status: "failed", error: { code: "not_sent" } })
    expect(await stored(before.id)).toEqual(before)
  })

  it.each(["public", "internal"])("allows disabled service-only %s acceptance", async path => {
    const ctx = await fixture(false)
    disabled()
    const result = path === "public" ? (await decidePublicAgreementByToken(ctx.token, decision)).document : await ctx.caller.agreements.recordAcceptance({ id: ctx.agreement.id, ...acceptance })
    expect(result.status).toBe("accepted")
    expect((await stored(ctx.agreement.id)).offerSnapshotHash).toBe(ctx.agreement.offerSnapshotHash)
  })

  it("allows declining disabled deposit offers and serializes recall versus acceptance", async () => {
    const ctx = await fixture()
    disabled()
    const outcomes = await Promise.allSettled([
      decidePublicAgreementByToken(ctx.token, decision),
      executeIssuanceCommand(recallAgreement, { id: ctx.agreement.id }, { actor: ctx.actor }),
    ])
    expect(outcomes[0].status).toBe("rejected")
    expect(await stored(ctx.agreement.id)).toMatchObject({ status: "draft", acceptedAt: null })
    setRuntimeExtensions([])
    const second = await fixture()
    disabled()
    expect((await decidePublicAgreementByToken(second.token, { decision: "decline", reason: "Synthetic refusal" })).document.status).toBe("declined")
  })

  it.each(["API", "commands", "MCP"])("rejects omitted-flag partial edits and omitted-line repricing through %s with no row or event changes", async path => {
    const ctx = await fixture(true, false)
    const before = await stored(ctx.agreement.id)
    const input = { agreementId: before.id, id: before.deliverables[1]!.id, unitPrice: "90" }
    const key = await createAgentKey(ctx.actor, { name: "Synthetic writer", mode: "full_access", scopes: ["agreement:update", "deliverable:update"] })
    const agent = await authenticateAgentSecret(key.secret)
    const events = await prisma.domainEvent.count({ where: { organizationId: ctx.org.organizationId } })
    disabled()
    const edits = [{ id: before.id, taxRate: "10" }, { id: before.id, currency: "EUR" }]
    if (path === "API") {
      await expect(ctx.caller.agreements.updateDeliverable(input)).rejects.toThrow("disabled")
      await expect(ctx.caller.agreements.updateDraft({ id: before.id, taxRate: 10 })).rejects.toThrow("disabled")
      for (const edit of edits) await expect(ctx.caller.agreements.updateDraftDecimal(edit)).rejects.toThrow("disabled")
    } else if (path === "commands") {
      expect(await executeIssuanceCommand(updateDeliverable, input, { actor: ctx.actor })).toMatchObject({ status: "failed", error: { code: "deposits_disabled" } })
      for (const edit of edits) expect(await executeIssuanceCommand(updateAgreementDraft, edit, { actor: ctx.actor })).toMatchObject({ status: "failed", error: { code: "deposits_disabled" } })
    } else {
      expect(await getAgentTool(agent, "deliverable_update").run({ actor: agent }, { ...input, clientRequestId: "partial-price" })).toMatchObject({ status: "failed", error: { code: "deposits_disabled" } })
      for (const [index, edit] of edits.entries()) expect(await getAgentTool(agent, "agreement_update_draft").run({ actor: agent }, { ...edit, clientRequestId: `repricing-${index}` })).toMatchObject({ status: "failed", error: { code: "deposits_disabled" } })
    }
    expect(await stored(before.id)).toEqual(before)
    expect(await prisma.domainEvent.count({ where: { organizationId: ctx.org.organizationId } })).toBe(events)
  })

  it("allows enabled partial edits/repricing, disabled service edits on mixed drafts, metadata and deposit removal", async () => {
    const ctx = await fixture(true, false)
    const depositId = ctx.agreement.deliverables[1]!.id
    await ctx.caller.agreements.updateDeliverable({ agreementId: ctx.agreement.id, id: depositId, unitPrice: "40" })
    await ctx.caller.agreements.updateDraftDecimal({ id: ctx.agreement.id, taxRate: "10" })
    const deposit = (await stored(ctx.agreement.id)).deliverables[1]!
    expect(Number(deposit.unitPriceNet)).toBe(40)
    expect(Number(deposit.taxRate)).toBe(10)
    disabled()
    await ctx.caller.agreements.updateDeliverable({ agreementId: ctx.agreement.id, id: ctx.agreement.deliverables[0]!.id, unitPrice: "150" })
    await ctx.caller.agreements.updateDraftDecimal({ id: ctx.agreement.id, notes: "Safe metadata" })
    expect((await stored(ctx.agreement.id)).deliverables[1]).toEqual(deposit)
    await ctx.caller.agreements.updateDeliverable({ agreementId: ctx.agreement.id, id: depositId, isDeposit: false })
    await ctx.caller.agreements.updateDraftDecimal({ id: ctx.agreement.id, taxRate: "25" })
    expect((await stored(ctx.agreement.id)).deliverables.every(line => !line.isDeposit)).toBe(true)
    completed(await executeIssuanceCommand(issueAgreement, { id: ctx.agreement.id }, { actor: ctx.actor }))
  })

  it("allows replacing mixed draft lines with only services while repricing", async () => {
    const ctx = await fixture(true, false)
    disabled()
    await ctx.caller.agreements.updateDraftDecimal({ id: ctx.agreement.id, taxRate: "10", deliverables: [{ title: "Service", quantity: "1", unitPrice: "100" }] })
    const result = await stored(ctx.agreement.id)
    expect(result.deliverables).toHaveLength(1)
    expect(result.deliverables[0]).toMatchObject({ isDeposit: false })
  })
})
