import { readFile } from "node:fs/promises"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
vi.mock("../../lib/email", async () => ({
  ...await vi.importActual<typeof import("../../lib/email")>("../../lib/email"),
  deliver: vi.fn(async () => ({ id: "synthetic-archive-delivery" })),
}))
import { prisma } from "../../lib/db"
import { createTestOrganization, hasTestDatabase } from "../../test-utils/organization"
import { createAgreementDraft } from "../../domain/commands/agreements"
import { issueAgreement } from "../../domain/commands/agreement-lifecycle"
import { createInvoiceDraft, sendInvoice } from "../../domain/commands/invoices"
import { executeCommand, type CommandOutcome } from "../../domain/execute"
import { executeIssuanceCommand, prepareDocument, reservationRequestKey, reserveDocument } from "../issuance"
import { resetRuntimeServices, setRuntimeServices } from "../../lib/runtime/services"
import { sweepOrganizationArtifacts } from "../../domain/features/artifact-sweep"
import type { RenderInput } from "../../domain/documents/render-input"

const cleanups: Array<() => Promise<void>> = []
const render = vi.fn(async (input: RenderInput) => new TextEncoder().encode(JSON.stringify(input)))
function completed<T>(outcome: CommandOutcome<T>): T {
  if (outcome.status !== "completed") throw new Error(JSON.stringify(outcome))
  return outcome.result
}
beforeEach(() => {
  render.mockReset().mockImplementation(async input => new TextEncoder().encode(JSON.stringify(input)))
  setRuntimeServices({ documentRenderer: { version: "archive-v1", renderPdf: render }, documentArtifactStore: {
    async put(_bytes, meta) { return `${meta.documentId}/${meta.hash}` }, async get() { return null }, async head() { return null }, async delete() {},
  } })
})
afterEach(async () => {
  resetRuntimeServices()
  for (const cleanup of cleanups.splice(0)) await cleanup()
})
async function fixture() {
  const org = await createTestOrganization()
  cleanups.push(org.cleanup)
  const actor = org.actors.admin
  const contact = await prisma.contact.create({ data: { organizationId: org.organizationId, name: "Synthetic customer", email: "customer@example.test" } })
  const draft = async () => completed(await executeCommand(createAgreementDraft, { contactId: contact.id, title: "Synthetic offer", validUntil: "2099-01-01",
    deliverables: [{ title: "Work", quantity: "1", unitPrice: "100", isDeposit: true }],
  }, { actor }))
  const target = await draft()
  const args = { kind: "agreement" as const, commandInput: { id: target.id }, actor, clientRequestId: "primary", method: "manual" as const }
  const rival = async (clientRequestId = "rival") => completed(await executeIssuanceCommand(issueAgreement, { id: (await draft()).id }, { actor, clientRequestId }))
  return { org, actor, contact, target, args, draft, rival }
}
// The first three schedules and prefix controls adapt independent public-contract review probes.
;(hasTestDatabase ? describe : describe.skip)("disjoint issuance request archives", () => {
  it.each([false, true])("a literal old archive key issues and replays, existing alias=%s", async alias => {
    const ctx = await fixture()
    const old = await prepareDocument((await reserveDocument(ctx.args)).id)
    const clientRequestId = `primary#superseded:${old.id}`
    if (alias) expect((await reserveDocument({ ...ctx.args, clientRequestId })).id).toBe(old.id)
    await ctx.rival()
    const fresh = await prepareDocument((await reserveDocument(ctx.args)).id)
    expect(fresh.id).not.toBe(old.id)
    const archive = await prisma.artifactStaging.findUniqueOrThrow({ where: { id: old.id } })
    expect(archive).toMatchObject({ requestKey: null, requestKeys: [], status: "abandoned" })
    expect(archive.archivedRequestKeys).toEqual([reservationRequestKey(ctx.actor, "primary"),
      ...(alias ? [reservationRequestKey(ctx.actor, clientRequestId)] : [])])
    const results = await Promise.all(Array.from({ length: 3 }, () => executeIssuanceCommand(issueAgreement, ctx.args.commandInput, { actor: ctx.actor, clientRequestId })))
    const result = results[0]!
    for (const duplicate of results) expect(duplicate).toEqual(result)
    expect(completed(result).number).toBe("AGR-0002")
    expect(await executeIssuanceCommand(issueAgreement, ctx.args.commandInput, { actor: ctx.actor, clientRequestId })).toEqual(result)
    expect(await prisma.commandReceipt.findMany({ where: { organizationId: ctx.org.organizationId, clientRequestId } })).toMatchObject([{ status: "completed" }])
    expect(await prisma.issuanceCandidate.count({ where: { documentId: ctx.target.id, status: "published" } })).toBe(1)
    expect(await prisma.domainEvent.count({ where: { aggregateId: ctx.target.id, type: "document.artifact_stored" } })).toBe(1)
    expect((await prisma.orgSettings.findUniqueOrThrow({ where: { organizationId: ctx.org.organizationId } })).agreementNextNum).toBe(3)
  })

  it("another document's live primary never collides with supersession", async () => {
    const ctx = await fixture()
    const old = await prepareDocument((await reserveDocument(ctx.args)).id)
    const other = await ctx.draft()
    const clientRequestId = `primary#superseded:${old.id}`
    const unrelated = await reserveDocument({ ...ctx.args, commandInput: { id: other.id }, clientRequestId })
    await ctx.rival()
    expect(completed(await executeIssuanceCommand(issueAgreement, ctx.args.commandInput, { actor: ctx.actor, clientRequestId: "primary" })).number).toBe("AGR-0002")
    expect(await prisma.artifactStaging.findUniqueOrThrow({ where: { id: unrelated.id } })).toMatchObject({
      requestKey: reservationRequestKey(ctx.actor, clientRequestId), archivedRequestKeys: [], status: "reserved",
    })
    expect(completed(await executeIssuanceCommand(issueAgreement, { id: other.id }, { actor: ctx.actor, clientRequestId })).number).toBe("AGR-0003")
  })

  it("near-prefix and embedded-suffix foreign identities remain terminal", async () => {
    const ctx = await fixture()
    const clientRequestId = "primary#superseded:literal"
    const old = await prepareDocument((await reserveDocument({ ...ctx.args, clientRequestId })).id)
    await ctx.rival()
    await reserveDocument({ ...ctx.args, clientRequestId })
    for (const foreign of ["primary", "prim", `${clientRequestId}#superseded:${old.id}`, `${clientRequestId}-extra`]) {
      expect(await executeCommand(issueAgreement, ctx.args.commandInput, { actor: ctx.actor, clientRequestId: foreign, issuanceStagingId: old.id })).toMatchObject({ status: "failed", error: { code: "reservation_identity_mismatch" } })
      expect(await prisma.commandReceipt.findFirstOrThrow({ where: { organizationId: ctx.org.organizationId, clientRequestId: foreign } })).toMatchObject({ status: "failed" })
    }
    expect(await executeCommand(issueAgreement, ctx.args.commandInput, { actor: ctx.actor, clientRequestId, issuanceStagingId: old.id })).toMatchObject({ status: "failed", error: { code: "number_changed" } })
    expect(await prisma.commandReceipt.count({ where: { organizationId: ctx.org.organizationId, clientRequestId } })).toBe(0)
    expect((await executeIssuanceCommand(issueAgreement, ctx.args.commandInput, { actor: ctx.actor, clientRequestId })).status).toBe("completed")
  })

  it("ordinary abandonment with a literal own-row suffix is never supersession", async () => {
    const ctx = await fixture()
    const old = await prepareDocument((await reserveDocument(ctx.args)).id)
    const clientRequestId = `ordinary#superseded:${old.id}`
    await prisma.artifactStaging.update({ where: { id: old.id }, data: {
      status: "abandoned", requestKey: reservationRequestKey(ctx.actor, clientRequestId), requestKeys: [],
    } })
    expect(await executeCommand(issueAgreement, ctx.args.commandInput, { actor: ctx.actor, clientRequestId, issuanceStagingId: old.id })).toMatchObject({ status: "failed", error: { code: "reservation_expired" } })
    expect(await executeCommand(issueAgreement, ctx.args.commandInput, { actor: ctx.actor, clientRequestId: "ordinary", issuanceStagingId: old.id })).toMatchObject({ status: "failed", error: { code: "reservation_identity_mismatch" } })
    expect(await prisma.issuanceCandidate.count({ where: { documentId: ctx.target.id } })).toBe(0)
  })

  it("repeated alias-led supersession retains every exact owner and sweep preserves lease checks", async () => {
    const ctx = await fixture()
    const keys = ["primary", "alias#superseded:literal", "alias-b"]
    const old = await prepareDocument((await reserveDocument(ctx.args)).id)
    for (const clientRequestId of keys.slice(1)) await reserveDocument({ ...ctx.args, clientRequestId })
    await ctx.rival()
    const second = await prepareDocument((await reserveDocument({ ...ctx.args, clientRequestId: keys[1]! })).id)
    for (const clientRequestId of keys) await reserveDocument({ ...ctx.args, clientRequestId })
    await ctx.rival("rival-2")
    const fresh = await prepareDocument((await reserveDocument({ ...ctx.args, clientRequestId: keys[2]! })).id)
    for (const row of [old, second]) {
      expect(await prisma.artifactStaging.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ requestKey: null, requestKeys: [] })
      for (const clientRequestId of keys) {
        expect(await executeCommand(issueAgreement, ctx.args.commandInput, { actor: ctx.actor, clientRequestId, issuanceStagingId: row.id })).toMatchObject({ status: "failed", error: { code: "number_changed" } })
        expect(await prisma.commandReceipt.count({ where: { organizationId: ctx.org.organizationId, clientRequestId } })).toBe(0)
        expect((await reserveDocument({ ...ctx.args, clientRequestId })).id).toBe(fresh.id)
      }
    }
    expect(await sweepOrganizationArtifacts(ctx.org.organizationId)).toMatchObject({ deleted: 2 })
    const swept = await prisma.artifactStaging.findUniqueOrThrow({ where: { id: old.id } })
    expect(swept.artifacts).toBeNull()
    expect(swept.archivedRequestKeys).toHaveLength(3)
    await prisma.artifactStaging.update({ where: { id: old.id }, data: { leaseUntil: new Date(0) } })
    expect(await executeCommand(issueAgreement, ctx.args.commandInput, { actor: ctx.actor, clientRequestId: "expired-owner", issuanceStagingId: old.id })).toMatchObject({ status: "failed", error: { code: "reservation_identity_mismatch" } })
    // Use a separate alias to avoid poisoning the primary receipt for the fresh commit.
    expect(await executeCommand(issueAgreement, ctx.args.commandInput, { actor: ctx.actor, clientRequestId: keys[1]!, issuanceStagingId: old.id })).toMatchObject({ status: "failed", error: { code: "reservation_expired" } })
    expect(completed(await executeIssuanceCommand(issueAgreement, ctx.args.commandInput, { actor: ctx.actor, clientRequestId: "primary" })).number).toBe("AGR-0003")
  })


  it("migrated legacy primary and aliases recover without rewriting a failed receipt", async () => {
    const ctx = await fixture()
    const clientRequestId = "primary#superseded:literal"
    const old = await prepareDocument((await reserveDocument({ ...ctx.args, clientRequestId })).id)
    await reserveDocument({ ...ctx.args, clientRequestId: "alias" })
    await ctx.rival()
    await reserveDocument({ ...ctx.args, clientRequestId })
    const archived = await prisma.artifactStaging.findUniqueOrThrow({ where: { id: old.id } })
    const legacy = await prisma.artifactStaging.update({ where: { id: old.id }, data: {
      requestKey: `${archived.archivedRequestKeys[0]}#superseded:${old.id}`,
      requestKeys: archived.archivedRequestKeys.slice(1).map(key => `${key}#superseded:${old.id}`), archivedRequestKeys: [],
    } })
    const failed = await executeCommand(issueAgreement, ctx.args.commandInput, { actor: ctx.actor, clientRequestId: "foreign", issuanceStagingId: old.id })
    expect(failed.status).toBe("failed")
    const receipt = await prisma.commandReceipt.findFirstOrThrow({ where: { organizationId: ctx.org.organizationId, clientRequestId: "foreign" } })
    const sql = await readFile(new URL("../../../prisma/migrations/20261014050000_artifact_request_archive/migration.sql", import.meta.url), "utf8")
    const update = sql.slice(sql.indexOf('UPDATE "artifact_staging"'), sql.indexOf(';', sql.indexOf('UPDATE "artifact_staging"')))
    await prisma.$executeRawUnsafe(update.replace("WHERE status", 'WHERE "organizationId" = $1 AND status'), ctx.org.organizationId)
    expect(await prisma.artifactStaging.findUniqueOrThrow({ where: { id: old.id } })).toEqual({ ...archived, updatedAt: legacy.updatedAt })
    expect(await prisma.commandReceipt.findUniqueOrThrow({ where: { id: receipt.id } })).toEqual(receipt)
    for (const key of [clientRequestId, "alias"]) {
      expect(await executeCommand(issueAgreement, ctx.args.commandInput, { actor: ctx.actor, clientRequestId: key, issuanceStagingId: old.id })).toMatchObject({ status: "failed", error: { code: "number_changed" } })
      expect(await prisma.commandReceipt.count({ where: { organizationId: ctx.org.organizationId, clientRequestId: key } })).toBe(0)
    }
    expect(completed(await executeIssuanceCommand(issueAgreement, ctx.args.commandInput, { actor: ctx.actor, clientRequestId })).number).toBe("AGR-0002")
    expect(await executeCommand(issueAgreement, ctx.args.commandInput, { actor: ctx.actor, clientRequestId: "foreign" })).toEqual(failed)
  })

  it("invoice archives are disjoint from live keys in the shared pipeline", async () => {
    const ctx = await fixture()
    vi.stubEnv("RESEND_API_KEY", "synthetic-archive")
    vi.stubEnv("FROM_EMAIL", "billing@example.test")
    const draft = async () => completed(await executeCommand(createInvoiceDraft, { contactId: ctx.contact.id,
      dueDate: "2099-01-01", taxRate: 0, items: [{ description: "Work", quantity: 1, unitPrice: 100 }],
    }, { actor: ctx.actor }))
    try {
      const target = await draft()
      const args = { kind: "invoice" as const, commandInput: { id: target.id }, actor: ctx.actor, clientRequestId: "invoice-primary", method: "email" as const }
      const old = await prepareDocument((await reserveDocument(args)).id)
      const clientRequestId = `invoice-primary#superseded:${old.id}`
      await reserveDocument({ ...args, clientRequestId })
      const rival = await draft()
      completed(await executeIssuanceCommand(sendInvoice, { id: rival.id }, { actor: ctx.actor, clientRequestId: "invoice-rival" }))
      await prepareDocument((await reserveDocument(args)).id)
      const result = await executeIssuanceCommand(sendInvoice, args.commandInput, { actor: ctx.actor, clientRequestId })
      expect(completed(result).number).toBe("INV-0002")
      expect(await executeIssuanceCommand(sendInvoice, args.commandInput, { actor: ctx.actor, clientRequestId })).toEqual(result)
      expect(await prisma.issuanceCandidate.count({ where: { documentId: target.id, status: "published" } })).toBe(1)
    } finally { vi.unstubAllEnvs() }
  })
})
