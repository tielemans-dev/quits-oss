import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { CommandDefinition } from "../../domain/command"
import type { ExecuteOptions, CommandOutcome } from "../../domain/execute"

const gates = vi.hoisted(() => ({ afterPreparation: null as null | ((id: string) => Promise<void>) }))
// Adapted from the public-contract review reproduction. Pause only after real preparation;
// the adapter, reads, transaction, candidate binding and handler still execute normally.
vi.mock("../../domain/execute", async () => {
  const actual = await vi.importActual<typeof import("../../domain/execute")>("../../domain/execute")
  return { ...actual, executeCommand: <I, R>(definition: CommandDefinition<I, R>, input: unknown, options: ExecuteOptions) => {
    const prepare = options.prepareIssuance
    if (options.clientRequestId !== "overlap" || !prepare) return actual.executeCommand(definition, input, options)
    return actual.executeCommand(definition, input, { ...options, prepareIssuance: async (parsed, now) => {
      const id = await prepare(parsed, now)
      await gates.afterPreparation?.(id)
      return id
    } })
  } }
})
vi.mock("../../lib/email", async () => ({
  ...await vi.importActual<typeof import("../../lib/email")>("../../lib/email"),
  deliver: vi.fn(async () => ({ id: "synthetic-overlap-delivery" })),
}))

import { prisma } from "../../lib/db"
import { createTestOrganization, hasTestDatabase } from "../../test-utils/organization"
import { createAgreementDraft } from "../../domain/commands/agreements"
import { issueAgreement, sendAgreement } from "../../domain/commands/agreement-lifecycle"
import { createInvoiceDraft, sendInvoice } from "../../domain/commands/invoices"
import { executeCommand } from "../../domain/execute"
import { actorKey } from "../../domain/actor"
import { resetRuntimeServices, setRuntimeServices } from "../../lib/runtime/services"
import { setRuntimeExtensions } from "../../lib/runtime/extensions"
import { executeIssuanceCommand, MAX_NUMBER_ATTEMPTS, prepareDocument, reservationRequestKey, reserveDocument } from "../issuance"
import type { RenderInput } from "../../domain/documents/render-input"

const cleanups: Array<() => Promise<void>> = []
const render = vi.fn(async (input: RenderInput) => new TextEncoder().encode(JSON.stringify(input)))
function completed<T>(outcome: CommandOutcome<T>): T {
  if (outcome.status !== "completed") throw new Error(JSON.stringify(outcome))
  return outcome.result
}
function gate() {
  let release!: () => void
  const wait = new Promise<void>(resolve => { release = resolve })
  return { wait, release }
}
beforeEach(() => {
  vi.stubEnv("RESEND_API_KEY", "synthetic-overlap")
  vi.stubEnv("FROM_EMAIL", "billing@example.test")
  render.mockReset().mockImplementation(async input => new TextEncoder().encode(JSON.stringify(input)))
  setRuntimeServices({ documentRenderer: { version: "overlap-v1", renderPdf: render }, documentArtifactStore: {
    async put() { return "synthetic-overlap-artifact" }, async get() { return null }, async head() { return null }, async delete() {},
  } })
})
afterEach(async () => {
  gates.afterPreparation = null
  setRuntimeExtensions([]); resetRuntimeServices()
  vi.unstubAllEnvs()
  for (const cleanup of cleanups.splice(0)) await cleanup()
})
async function fixture() {
  const org = await createTestOrganization({ roles: ["admin", "member"] })
  cleanups.push(org.cleanup)
  const actor = org.actors.admin
  const contact = await prisma.contact.create({ data: { organizationId: org.organizationId, name: "Synthetic customer", email: "customer@example.test" } })
  const draft = async () => completed(await executeCommand(createAgreementDraft, { contactId: contact.id, title: "Synthetic offer", validUntil: "2099-01-01",
    deliverables: [{ title: "Work", quantity: "1", unitPrice: "100", isDeposit: true }],
  }, { actor }))
  const first = await draft()
  const args = { kind: "agreement" as const, commandInput: { id: first.id }, actor, clientRequestId: "primary", method: "manual" as const }
  return { org, actor, draft, first, args }
}
;(hasTestDatabase ? describe : describe.skip)("issuance supersession", () => {
  it.each([false, true])("overlapping actual adapter calls recover after a rival issuance, alias=%s", async alias => {
    const ctx = await fixture()
    if (alias) await reserveDocument(ctx.args)
    const ready = [gate(), gate(), gate()]
    const resume = [gate(), gate(), gate()]
    const stagedIds: string[] = []
    gates.afterPreparation = async id => {
      const index = stagedIds.length
      stagedIds.push(id)
      ready[index]?.release()
      await resume[index]?.wait
    }
    const a = executeIssuanceCommand(issueAgreement, ctx.args.commandInput, { actor: ctx.actor, clientRequestId: "overlap" })
    let b: ReturnType<typeof executeIssuanceCommand> | undefined
    try {
      await ready[0]!.wait
      b = executeIssuanceCommand(issueAgreement, ctx.args.commandInput, { actor: ctx.actor, clientRequestId: "overlap" })
      await ready[1]!.wait
      expect(stagedIds[0]).toBe(stagedIds[1])
      const rival = await ctx.draft()
      expect(completed(await executeIssuanceCommand(issueAgreement, { id: rival.id }, { actor: ctx.actor, clientRequestId: "rival" })).number).toBe("AGR-0001")
      resume[0]!.release()
      await ready[2]!.wait
      expect(stagedIds[2]).not.toBe(stagedIds[0])
      resume[1]!.release()
      const second = await b
      resume[2]!.release()
      const first = await a
      expect(first.status).toBe("completed")
      expect(second).toEqual(first)
      expect(await executeIssuanceCommand(issueAgreement, ctx.args.commandInput, { actor: ctx.actor, clientRequestId: "overlap" })).toEqual(first)
      expect(await prisma.agreement.findUniqueOrThrow({ where: { id: ctx.first.id } })).toMatchObject({ status: "sent", number: "AGR-0002", offerRevision: 1 })
      expect((await prisma.orgSettings.findUniqueOrThrow({ where: { organizationId: ctx.org.organizationId } })).agreementNextNum).toBe(3)
      expect(await prisma.issuanceCandidate.count({ where: { documentId: ctx.first.id, status: "published" } })).toBe(1)
      expect(await prisma.domainEvent.count({ where: { aggregateId: ctx.first.id, type: "document.artifact_stored" } })).toBe(1)
      expect(await prisma.commandReceipt.findMany({ where: { organizationId: ctx.org.organizationId, clientRequestId: "overlap" } })).toMatchObject([{ status: "completed" }])
    } finally {
      for (const item of resume) item.release()
      await Promise.allSettled([a, ...(b ? [b] : [])])
    }
  })

  it("preserves every primary and alias owner when an alias supersedes the row", async () => {
    const ctx = await fixture()
    const old = await prepareDocument((await reserveDocument(ctx.args)).id)
    for (const clientRequestId of ["alias-a", "alias-b"]) expect((await reserveDocument({ ...ctx.args, clientRequestId })).id).toBe(old.id)
    const rival = await ctx.draft()
    completed(await executeIssuanceCommand(issueAgreement, { id: rival.id }, { actor: ctx.actor, clientRequestId: "rival" }))
    const fresh = await prepareDocument((await reserveDocument({ ...ctx.args, clientRequestId: "alias-a" })).id)
    expect(fresh.id).not.toBe(old.id)
    for (const clientRequestId of ["primary", "alias-a", "alias-b"]) {
      expect(await executeCommand(issueAgreement, ctx.args.commandInput, { actor: ctx.actor, clientRequestId, issuanceStagingId: old.id })).toMatchObject({ status: "failed", error: { code: "number_changed" } })
      expect(await prisma.commandReceipt.count({ where: { organizationId: ctx.org.organizationId, clientRequestId } })).toBe(0)
      expect((await reserveDocument({ ...ctx.args, clientRequestId })).id).toBe(fresh.id)
    }
    // A crash after supersession/fresh preparation does not strand any previous owner.
    expect(completed(await executeIssuanceCommand(issueAgreement, ctx.args.commandInput, { actor: ctx.actor, clientRequestId: "primary" })).number).toBe("AGR-0002")
    expect((await prisma.orgSettings.findUniqueOrThrow({ where: { organizationId: ctx.org.organizationId } })).agreementNextNum).toBe(3)
  })

  it("also recovers overlapping invoice adapter calls through the shared pipeline", async () => {
    const ctx = await fixture()
    const draft = async () => completed(await executeCommand(createInvoiceDraft, { contactId: ctx.first.contactId,
      dueDate: "2099-01-01", taxRate: 0, items: [{ description: "Work", quantity: 1, unitPrice: 100 }],
    }, { actor: ctx.actor }))
    const target = await draft()
    const ready = [gate(), gate(), gate()]
    const resume = [gate(), gate(), gate()]
    const ids: string[] = []
    gates.afterPreparation = async id => {
      const index = ids.length
      ids.push(id); ready[index]?.release(); await resume[index]?.wait
    }
    const a = executeIssuanceCommand(sendInvoice, { id: target.id }, { actor: ctx.actor, clientRequestId: "overlap" })
    let b: ReturnType<typeof executeIssuanceCommand> | undefined
    try {
      await ready[0]!.wait
      b = executeIssuanceCommand(sendInvoice, { id: target.id }, { actor: ctx.actor, clientRequestId: "overlap" })
      await ready[1]!.wait
      expect(ids[0]).toBe(ids[1])
      const rival = await draft()
      expect(completed(await executeIssuanceCommand(sendInvoice, { id: rival.id }, { actor: ctx.actor, clientRequestId: "rival-invoice" })).number).toBe("INV-0001")
      resume[0]!.release(); await ready[2]!.wait
      resume[1]!.release(); const second = await b
      resume[2]!.release(); const first = await a
      expect(first.status).toBe("completed")
      expect(second).toEqual(first)
      expect(await prisma.invoice.findUniqueOrThrow({ where: { id: target.id } })).toMatchObject({ status: "sent", number: "INV-0002" })
      expect(await prisma.issuanceCandidate.count({ where: { documentId: target.id, status: "published" } })).toBe(1)
      expect((await prisma.orgSettings.findUniqueOrThrow({ where: { organizationId: ctx.org.organizationId } })).invoiceNextNum).toBe(3)
    } finally {
      for (const item of resume) item.release()
      await Promise.allSettled([a, ...(b ? [b] : [])])
    }
  })

  it.each(["request", "actor", "organization", "command", "document", "method", "changed", "expired", "abandoned"])("keeps %s failures terminal instead of accepting supersession", async variant => {
    const ctx = await fixture()
    const old = await prepareDocument((await reserveDocument(ctx.args)).id)
    const rival = await ctx.draft()
    completed(await executeIssuanceCommand(issueAgreement, { id: rival.id }, { actor: ctx.actor, clientRequestId: "rival" }))
    await reserveDocument(ctx.args)
    let actor = ctx.actor
    let clientRequestId = "primary"
    let id = ctx.first.id
    let expectedCode = "reservation_identity_mismatch"
    if (variant === "request") clientRequestId = "foreign"
    if (variant === "actor") actor = ctx.org.actors.member
    if (variant === "organization") actor = (await fixture()).actor
    if (variant === "document") id = rival.id
    if (variant === "method") expectedCode = "document_changed"
    if (variant === "changed") {
      await prisma.agreement.update({ where: { id }, data: { title: "Changed after preparation" } })
      expectedCode = "document_changed"
    }
    if (variant === "expired") {
      await prisma.artifactStaging.update({ where: { id: old.id }, data: { leaseUntil: new Date(0) } })
      expectedCode = "reservation_expired"
    }
    if (variant === "abandoned") {
      clientRequestId = "ordinary-abandoned"
      await prisma.artifactStaging.update({ where: { id: old.id }, data: { requestKey: reservationRequestKey(actor, clientRequestId), requestKeys: [] } })
      expectedCode = "reservation_expired"
    }
    const options = { actor, clientRequestId, issuanceStagingId: old.id }
    const outcome = variant === "command" ? await executeCommand(sendInvoice, { id }, options)
      : variant === "method" ? await executeCommand(sendAgreement, { id }, options)
      : await executeCommand(issueAgreement, { id }, options)
    expect(outcome).toMatchObject({ status: "failed", error: { code: expectedCode } })
    expect(await prisma.commandReceipt.findFirstOrThrow({ where: { organizationId: actor.organizationId, actorKey: actorKey(actor), clientRequestId } })).toMatchObject({ status: "failed", error: { code: expectedCode } })
    expect(await executeCommand(issueAgreement, { id }, options)).toEqual(outcome)
    expect(await prisma.issuanceCandidate.count({ where: { documentId: ctx.first.id } })).toBe(0)
    expect(await prisma.agreement.findUniqueOrThrow({ where: { id: ctx.first.id } })).toMatchObject({ status: "draft", number: null })
  })

  it("ordinary five-way duplicate issuance publishes once", async () => {
    const ctx = await fixture()
    const results = await Promise.all(Array.from({ length: 5 }, () => executeIssuanceCommand(issueAgreement, ctx.args.commandInput, { actor: ctx.actor, clientRequestId: "duplicate" })))
    expect(results[0]!.status).toBe("completed")
    for (const result of results) expect(result).toEqual(results[0])
    expect(render).toHaveBeenCalledTimes(1)
    expect(await prisma.issuanceCandidate.count({ where: { documentId: ctx.first.id } })).toBe(1)
    expect((await prisma.orgSettings.findUniqueOrThrow({ where: { organizationId: ctx.org.organizationId } })).agreementNextNum).toBe(2)
  })

  it("retry exhaustion leaves no receipt and the same request can recover", async () => {
    const ctx = await fixture()
    render.mockImplementation(async input => {
      await prisma.orgSettings.update({ where: { organizationId: ctx.org.organizationId }, data: { agreementNextNum: { increment: 1 } } })
      return new TextEncoder().encode(JSON.stringify(input))
    })
    expect(await executeIssuanceCommand(issueAgreement, ctx.args.commandInput, { actor: ctx.actor, clientRequestId: "primary" })).toMatchObject({ status: "failed", error: { code: "number_contention" } })
    expect(render).toHaveBeenCalledTimes(MAX_NUMBER_ATTEMPTS)
    expect(await prisma.commandReceipt.count({ where: { organizationId: ctx.org.organizationId, clientRequestId: "primary" } })).toBe(0)
    expect(await prisma.agreement.findUniqueOrThrow({ where: { id: ctx.first.id } })).toMatchObject({ status: "draft", number: null })
    expect(await prisma.issuanceCandidate.count({ where: { documentId: ctx.first.id } })).toBe(0)
    expect((await prisma.orgSettings.findUniqueOrThrow({ where: { organizationId: ctx.org.organizationId } })).agreementNextNum).toBe(MAX_NUMBER_ATTEMPTS + 1)
    render.mockImplementation(async input => new TextEncoder().encode(JSON.stringify(input)))
    expect(completed(await executeIssuanceCommand(issueAgreement, ctx.args.commandInput, { actor: ctx.actor, clientRequestId: "primary" })).number).toBe("AGR-0026")
    expect((await prisma.orgSettings.findUniqueOrThrow({ where: { organizationId: ctx.org.organizationId } })).agreementNextNum).toBe(27)
  })
})
