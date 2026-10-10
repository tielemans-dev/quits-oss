import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { prisma } from "../../lib/db"
import { createTestOrganization, hasTestDatabase } from "../../test-utils/organization"
import { createAgreementDraft } from "../../domain/commands/agreements"
import { issueAgreement, sendAgreement } from "../../domain/commands/agreement-lifecycle"
import { executeCommand, type CommandOutcome } from "../../domain/execute"
import { setRuntimeExtensions } from "../../lib/runtime/extensions"
import { resetRuntimeServices, setRuntimeServices } from "../../lib/runtime/services"
import { appRouter } from "../../trpc/router"
import { executeIssuanceCommand, prepareDocument, reserveDocument } from "../issuance"

const cleanups: Array<() => Promise<void>> = []
const render = vi.fn(async () => new TextEncoder().encode("synthetic agreement"))
const put = vi.fn(async () => "synthetic-artifact")
const disabled = () => setRuntimeExtensions([{ id: "issuance-test", resolveCapabilities: () => ({ agreements: { depositsEnabled: false } }) }])
function completed<T>(outcome: CommandOutcome<T>): T {
  if (outcome.status !== "completed") throw new Error(JSON.stringify(outcome))
  return outcome.result
}
beforeEach(() => {
  render.mockReset().mockResolvedValue(new TextEncoder().encode("synthetic agreement")); put.mockClear()
  setRuntimeServices({ documentRenderer: { version: "issuance-test-v1", renderPdf: render }, documentArtifactStore: {
    put, async get() { return null }, async head() { return null }, async delete() {},
  } })
})
afterEach(async () => {
  setRuntimeExtensions([]); resetRuntimeServices()
  for (const cleanup of cleanups.splice(0)) await cleanup()
})
async function fixture(deposit = true) {
  const org = await createTestOrganization()
  cleanups.push(org.cleanup)
  const actor = org.actors.admin
  const contact = await prisma.contact.create({ data: { organizationId: org.organizationId, name: "Synthetic customer", email: "customer@example.test" } })
  const draft = completed(await executeCommand(createAgreementDraft, { contactId: contact.id, title: "Synthetic offer", validUntil: "2099-01-01",
    deliverables: [{ title: "Work", quantity: "1", unitPrice: "100", isDeposit: deposit }],
  }, { actor }))
  const caller = appRouter.createCaller({ session: { user: { id: actor.userId, email: "admin@example.test", name: "Admin" }, session: { activeOrganizationId: org.organizationId } } } as never)
  return { org, actor, draft, caller, args: { kind: "agreement" as const, commandInput: { id: draft.id }, actor, clientRequestId: "reserved", method: "manual" as const } }
}
async function business(organizationId: string) {
  const where = { organizationId }
  return {
    settings: await prisma.orgSettings.findUniqueOrThrow({ where }),
    agreements: await prisma.agreement.findMany({ where, include: { deliverables: true } }),
    staging: await prisma.artifactStaging.findMany({ where }),
    candidates: await prisma.issuanceCandidate.findMany({ where }),
    events: await prisma.domainEvent.findMany({ where }),
    jobs: await prisma.job.findMany({ where }),
  }
}
;(hasTestDatabase ? describe : describe.skip)("deposit issuance preflight", () => {
  it.each(["command issue", "command send", "API issue", "API send"])("refuses %s before numbering or artifact work", async path => {
    const ctx = await fixture()
    const before = await business(ctx.org.organizationId)
    disabled()
    if (path.startsWith("API")) await expect(path.endsWith("issue") ? ctx.caller.agreements.issue({ id: ctx.draft.id }) : ctx.caller.agreements.send({ id: ctx.draft.id })).rejects.toThrow("disabled")
    else expect(await executeIssuanceCommand(path.endsWith("issue") ? issueAgreement : sendAgreement, { id: ctx.draft.id }, { actor: ctx.actor, clientRequestId: path })).toMatchObject({ status: "failed", error: { code: "deposits_disabled" } })
    expect(await business(ctx.org.organizationId)).toEqual(before)
    expect(render).not.toHaveBeenCalled()
    expect(put).not.toHaveBeenCalled()
  })
  it("revalidates existing reservations before reusing or claiming them", async () => {
    const ctx = await fixture()
    const staged = await reserveDocument(ctx.args)
    expect(staged.numberWasAllocated).toBe(false)
    const before = await business(ctx.org.organizationId)
    disabled()
    await expect(reserveDocument(ctx.args)).rejects.toMatchObject({ code: "deposits_disabled" })
    await expect(reserveDocument({ ...ctx.args, clientRequestId: "another-request" })).rejects.toMatchObject({ code: "deposits_disabled" })
    await expect(prepareDocument(staged.id)).rejects.toMatchObject({ code: "deposits_disabled" })
    expect(await business(ctx.org.organizationId)).toEqual(before)
    expect(render).not.toHaveBeenCalled()
    expect(put).not.toHaveBeenCalled()
  })

  it("refuses a prepared deposit under the commit locks even when mutable flags were cleared", async () => {
    const ctx = await fixture()
    const staged = await prepareDocument((await reserveDocument(ctx.args)).id)
    await prisma.deliverable.updateMany({ where: { agreementId: ctx.draft.id }, data: { isDeposit: false } })
    const before = await business(ctx.org.organizationId)
    disabled()
    expect(await executeCommand(issueAgreement, ctx.args.commandInput, { actor: ctx.actor,
      clientRequestId: ctx.args.clientRequestId, issuanceStagingId: staged.id })).toMatchObject({ status: "failed", error: { code: "document_changed" } })
    expect(await business(ctx.org.organizationId)).toEqual(before)
  })

  it("refuses prepared deposits after the capability changes without binding candidates", async () => {
    const ctx = await fixture()
    const staged = await prepareDocument((await reserveDocument(ctx.args)).id)
    const before = await business(ctx.org.organizationId)
    disabled()
    expect(await executeCommand(issueAgreement, ctx.args.commandInput, { actor: ctx.actor,
      clientRequestId: ctx.args.clientRequestId, issuanceStagingId: staged.id })).toMatchObject({ status: "failed", error: { code: "deposits_disabled" } })
    expect(await business(ctx.org.organizationId)).toEqual(before)
  })

  it("rechecks a capability change during rendering without consuming a number", async () => {
    const ctx = await fixture()
    const before = await business(ctx.org.organizationId)
    render.mockImplementationOnce(async () => {
      disabled()
      return new TextEncoder().encode("already started preparation")
    })
    expect(await executeIssuanceCommand(issueAgreement, { id: ctx.draft.id }, { actor: ctx.actor })).toMatchObject({ status: "failed", error: { code: "deposits_disabled" } })
    const after = await business(ctx.org.organizationId)
    // Rendering started while enabled. Refusal leaves an unbound reservation for the sweep.
    expect(after.staging).toHaveLength(1)
    expect(after.staging[0]).toMatchObject({ status: "reserved", prepToken: null, numberWasAllocated: false })
    expect({ ...after, staging: [] }).toEqual(before)
    expect(render).toHaveBeenCalledTimes(1)
    expect(put).not.toHaveBeenCalled()
  })

  it.each([true, false])("issues default-enabled deposits and disabled services, deposit=%s", async deposit => {
    const ctx = await fixture(deposit)
    if (!deposit) disabled()
    const result = completed(await executeIssuanceCommand(issueAgreement, { id: ctx.draft.id }, { actor: ctx.actor, clientRequestId: "success" }))
    expect(result).toMatchObject({ status: "sent", number: "AGR-0001", offerRevision: 1 })
    expect((await business(ctx.org.organizationId)).settings.agreementNextNum).toBe(2)
    const before = await business(ctx.org.organizationId)
    disabled()
    expect(completed(await executeIssuanceCommand(issueAgreement, { id: ctx.draft.id }, { actor: ctx.actor, clientRequestId: "success" })).id).toBe(result.id)
    expect(await business(ctx.org.organizationId)).toEqual(before)
  })

  it("keeps numbers already allocated by legacy agreement reservations", async () => {
    const ctx = await fixture()
    const reserved = await reserveDocument(ctx.args)
    await prisma.artifactStaging.update({ where: { id: reserved.id }, data: { numberWasAllocated: true } })
    await prisma.orgSettings.update({ where: { organizationId: ctx.org.organizationId }, data: { agreementNextNum: 2 } })
    expect((await reserveDocument(ctx.args)).id).toBe(reserved.id)
    const result = completed(await executeIssuanceCommand(issueAgreement, ctx.args.commandInput, { actor: ctx.actor, clientRequestId: ctx.args.clientRequestId }))
    expect(result.number).toBe("AGR-0001")
    expect((await business(ctx.org.organizationId)).settings.agreementNextNum).toBe(2)
  })

  it("gives concurrent enabled agreement issuances consecutive committed numbers", async () => {
    const ctx = await fixture()
    const second = completed(await executeCommand(createAgreementDraft, { contactId: ctx.draft.contactId, title: "Second offer", validUntil: "2099-01-01",
      deliverables: [{ title: "Second work", quantity: "1", unitPrice: "100", isDeposit: true }],
    }, { actor: ctx.actor }))
    let release!: () => void
    const both = new Promise<void>(resolve => { release = resolve })
    let initialRenders = 0
    render.mockImplementation(async () => {
      if (++initialRenders === 2) release()
      await both
      return new TextEncoder().encode("synthetic agreement")
    })
    const results = await Promise.all([ctx.draft.id, second.id].map(id => executeIssuanceCommand(issueAgreement, { id }, { actor: ctx.actor, clientRequestId: id })))
    expect(results.map(result => completed(result).number).sort()).toEqual(["AGR-0001", "AGR-0002"])
    expect((await business(ctx.org.organizationId)).settings.agreementNextNum).toBe(3)
  })

  it.each(["capability", "draft"])("rechecks %s after waiting for the agreement lock", async change => {
    const ctx = await fixture(change === "capability")
    let entered!: () => void, release!: () => void
    const locked = new Promise<void>(resolve => { entered = resolve })
    const unblock = new Promise<void>(resolve => { release = resolve })
    const blocker = prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM agreement WHERE id = ${ctx.draft.id} FOR UPDATE`
      if (change === "draft") await tx.deliverable.updateMany({ where: { agreementId: ctx.draft.id }, data: { isDeposit: true } })
      entered(); await unblock
    }, { timeout: 15_000 })
    await locked
    if (change === "draft") disabled()
    const issuance = executeIssuanceCommand(issueAgreement, ctx.args.commandInput, { actor: ctx.actor })
    try {
      // Wait for the actual SQL lock wait, rather than guessing how long preflight takes.
      await vi.waitFor(async () => {
        const waits = await prisma.$queryRaw<Array<{ count: bigint }>>`SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%FROM "agreement"%'`
        expect(Number(waits[0]!.count)).toBeGreaterThan(0)
      }, { timeout: 5000, interval: 20 })
      if (change === "capability") disabled()
    } finally { release(); await blocker }
    const before = await business(ctx.org.organizationId)
    expect(await issuance).toMatchObject({ status: "failed", error: { code: "deposits_disabled" } })
    expect(await business(ctx.org.organizationId)).toEqual(before)
    expect(render).not.toHaveBeenCalled()
    expect(put).not.toHaveBeenCalled()
  })

  it("checks the frozen preparation even after mutable deposit flags were cleared", async () => {
    const ctx = await fixture()
    const staged = await reserveDocument(ctx.args)
    await prisma.deliverable.updateMany({ where: { agreementId: ctx.draft.id }, data: { isDeposit: false } })
    const before = await business(ctx.org.organizationId)
    disabled()
    await expect(prepareDocument(staged.id)).rejects.toMatchObject({ code: "deposits_disabled" })
    expect(await business(ctx.org.organizationId)).toEqual(before)
    expect(render).not.toHaveBeenCalled()
    expect(put).not.toHaveBeenCalled()
  })

  it("keeps already-written preparation unbound if policy changes inside the store call", async () => {
    const ctx = await fixture()
    const before = await business(ctx.org.organizationId)
    put.mockImplementationOnce(async () => { disabled(); return "already-written-artifact" })
    expect(await executeIssuanceCommand(issueAgreement, ctx.args.commandInput, { actor: ctx.actor })).toMatchObject({ status: "failed", error: { code: "deposits_disabled" } })
    const after = await business(ctx.org.organizationId)
    expect(after.staging).toHaveLength(1)
    expect(after.staging[0]).toMatchObject({ status: "stored", numberWasAllocated: false, candidateRefs: [] })
    expect({ ...after, staging: [] }).toEqual(before)
    expect(render).toHaveBeenCalledTimes(1)
    expect(put).toHaveBeenCalledTimes(1)
  })

  it("does not start the secondary renderer after the PDF store disables deposits", async () => {
    const ctx = await fixture()
    const before = await business(ctx.org.organizationId)
    const renderUbl = vi.fn(async () => new TextEncoder().encode("synthetic secondary artifact"))
    setRuntimeServices({ documentRenderer: { version: "issuance-test-v1", renderPdf: render, renderUbl } })
    put.mockImplementationOnce(async () => { disabled(); return "already-written-artifact" })
    expect(await executeIssuanceCommand(issueAgreement, ctx.args.commandInput, { actor: ctx.actor })).toMatchObject({ status: "failed", error: { code: "deposits_disabled" } })
    const after = await business(ctx.org.organizationId)
    expect(after.staging).toHaveLength(1)
    expect(after.staging[0]).toMatchObject({ status: "reserved", prepToken: null, numberWasAllocated: false, candidateRefs: [] })
    expect({ ...after, staging: [] }).toEqual(before)
    expect(render).toHaveBeenCalledTimes(1)
    expect(put).toHaveBeenCalledTimes(1)
    expect(renderUbl).not.toHaveBeenCalled()
  })

  it.each([true, false])("retains secondary rendering for enabled deposits and disabled services, deposit=%s", async deposit => {
    const ctx = await fixture(deposit)
    if (!deposit) disabled()
    const renderUbl = vi.fn(async () => new TextEncoder().encode("synthetic secondary artifact"))
    setRuntimeServices({ documentRenderer: { version: "issuance-test-v1", renderPdf: render, renderUbl } })
    expect(completed(await executeIssuanceCommand(issueAgreement, ctx.args.commandInput, { actor: ctx.actor })).number).toBe("AGR-0001")
    expect(renderUbl).toHaveBeenCalledTimes(1)
    expect(put).toHaveBeenCalledTimes(2)
    expect(await prisma.issuanceCandidate.findFirstOrThrow({ where: { documentId: ctx.draft.id } })).toMatchObject({ status: "published", artifacts: { pdf: { ref: "synthetic-artifact" }, ubl: { ref: "synthetic-artifact" } } })
  })

})
