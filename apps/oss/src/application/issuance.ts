import { randomUUID } from "node:crypto"
import { Cause, Effect, Exit, Option } from "effect"
import type { ArtifactStaging, Prisma } from "../../generated/prisma/client"
import { prisma } from "../lib/db"
import { getDocumentArtifactStore, getDocumentRenderer } from "../lib/runtime/services"
import { getRuntimeCapabilities } from "../lib/runtime/extensions"
import { actorKey, type Actor } from "../domain/actor"
import { executeCommand, type ExecuteOptions, type CommandOutcome } from "../domain/execute"
import type { CommandDefinition } from "../domain/command"
import { sendInvoice } from "../domain/commands/invoices"
import { issueCreditNote } from "../domain/commands/credit-notes"
import { sendAgreement, issueAgreement } from "../domain/commands/agreement-lifecycle"
import { allocateDocumentNumber, peekNextDocumentNumber, NUMBER_CHANGED } from "../domain/documents/numbering"
import { prospectiveRenderInput, hashBytes, hashRenderInput, type ArtifactDocumentKind, type RenderInput } from "../domain/documents/render-input"
import { artifactsJson, lockArtifactOrganization, supersededRequestKey, type StoredArtifacts } from "../domain/documents/artifacts"
import { ExternalFailure, InvalidState, serializeDomainError } from "../domain/errors"
import { appLogger } from "../lib/observability"
import { requireDepositsEnabled } from "../domain/agreements/deposit-capability"
import { readAgreementOfferSnapshot } from "@quits/contracts/agreements"
import { offerHasDeposits } from "../lib/agreements/offer-deposits"
import { Command, Db } from "../domain/services"

export const RESERVATION_LEASE_MS = 15 * 60_000
export function reservationRequestKey(actor: Actor, clientRequestId: string) {
  return `${actor.organizationId}:${actorKey(actor)}:${clientRequestId}`
}
/** Preserve typed domain failures rather than wrapping them as Effect defects. */
export async function runArtifactRead<T>(program: Effect.Effect<T, unknown, Db | Command>, tx: Prisma.TransactionClient,
  actor: Actor, now: Date) {
  const exit = await Effect.runPromiseExit(program.pipe(
    Effect.provideService(Db, tx), Effect.provideService(Command, {
      actor, organizationId: actor.organizationId, commandId: "reservation", now,
      approvedByUserId: null, emit: () => { throw new Error("Reservation cannot emit") },
      enqueue: () => { throw new Error("Reservation cannot enqueue") },
    })))
  if (Exit.isSuccess(exit)) return exit.value
  const failure = Cause.failureOption(exit.cause)
  throw Option.isSome(failure) ? failure.value : Cause.squash(exit.cause)
}
export async function reserveDocument(input: {
  kind: ArtifactDocumentKind; commandInput: unknown; actor: Actor; clientRequestId: string;
  now?: Date; method?: "email" | "manual"
}): Promise<ArtifactStaging> {
  const now = input.now ?? new Date()
  const organizationId = input.actor.organizationId
  const requestKey = reservationRequestKey(input.actor, input.clientRequestId)
  return prisma.$transaction(async tx => {
    await lockArtifactOrganization(tx, organizationId)
    const existing = await tx.artifactStaging.findFirst({ where: { organizationId,
      OR: [{ requestKey }, { requestKeys: { has: requestKey } }] } })
    const documentId = (input.commandInput as { id?: string }).id ?? `doc_${randomUUID().replaceAll("-", "")}`
    let number: string | null = null
    if (input.kind === "invoice") {
      const doc = await tx.invoice.findFirst({ where: { id: documentId, organizationId }, select: { number: true } })
      number = doc?.number ?? null
    } else if (input.kind === "agreement") {
      const doc = await tx.agreement.findFirst({ where: { id: documentId, organizationId }, select: { number: true } })
      number = doc?.number ?? null
    }
    // Validate agreements even when the request already owns a prepared reservation. The render
    // reader locks the current draft before inspecting deposit flags.
    if (input.kind === "agreement") await runArtifactRead(prospectiveRenderInput({ ...input,
      documentId, number: number ?? "preview", issuedAt: now }), tx, input.actor, now)
    // An invoice or agreement is numbered by the issuing transaction, not here. A numberless one is rendered with
    // the number it would receive now, without taking it; the transaction refuses a reservation
    // whose number has moved on, so an issuance that fails here or later consumes nothing.
    // Credit notes are still numbered by this reservation.
    const provisionalNumber = (input.kind === "invoice" || input.kind === "agreement") && !number
      ? await runArtifactRead(peekNextDocumentNumber(input.kind === "agreement" ? "agreement" : "invoice"), tx, input.actor, now) : null
    if (existing) {
      const stale = !existing.numberWasAllocated && provisionalNumber !== null && existing.documentKind === input.kind &&
        ["reserved", "stored", "missing"].includes(existing.status) && existing.reservedNumber !== provisionalNumber
      if (!stale) return existing
      // Free every live key on this stale row. Keep exact primary/alias ownership as tombstones
      // so an overlapping invocation can retry, rather than poisoning its request's receipt.
      await tx.artifactStaging.update({ where: { id: existing.id }, data: { status: "abandoned", prepToken: null,
        requestKey: supersededRequestKey(existing.requestKey, existing.id),
        requestKeys: existing.requestKeys.map(key => supersededRequestKey(key, existing.id)) } })
    }
    number ??= provisionalNumber
    // Try an unchanged retry with the old timestamp before allocating any new number.
    const prior = await tx.artifactStaging.findMany({ where: {
      organizationId, documentKind: input.kind, documentId, leaseUntil: { gt: now },
      status: { not: "abandoned" },
    }, orderBy: { createdAt: "desc" } })
    for (const row of prior) {
      if (!row.numberWasAllocated && provisionalNumber !== null && row.reservedNumber !== number) continue
      const renderInput = row.renderInput as unknown as RenderInput
      const current = await runArtifactRead(prospectiveRenderInput({ ...input, documentId,
        number: row.reservedNumber!, issuedAt: new Date(renderInput.issuedAt) }), tx, input.actor, now)
      if (hashRenderInput(current) === row.renderInputHash) {
        return tx.artifactStaging.update({ where: { id: row.id }, data: { requestKeys: { push: requestKey } } })
      }
    }
    // Only credit notes allocate here. Invoices and agreements have their own or a provisional
    // number, so an unused reservation for either kind never has a number to void.
    const numberWasAllocated = !number
    // Read before allocation so invalid document/credit selection does not consume a number.
    await runArtifactRead(prospectiveRenderInput({ ...input, documentId, number: number ?? "preview", issuedAt: now }), tx, input.actor, now)
    number ??= await runArtifactRead(allocateDocumentNumber(input.kind), tx, input.actor, now)
    const renderInput = await runArtifactRead(prospectiveRenderInput({ ...input, documentId, number, issuedAt: now }), tx, input.actor, now)
    const renderInputHash = hashRenderInput(renderInput)
    const same = await tx.artifactStaging.findUnique({ where: {
      organizationId_documentKind_documentId_renderInputHash: { organizationId, documentKind: input.kind, documentId, renderInputHash },
    } })
    if (same) {
      // Never revive an abandoned/expired reservation or alter its issuance timestamp.
      throw new InvalidState({ code: "reservation_expired", message: "A reservation for this document expired" })
    }
    return tx.artifactStaging.create({ data: {
      organizationId, documentKind: input.kind, documentId, requestKey,
      renderInputHash, renderInput: artifactsJson(renderInput), reservedNumber: number,
      numberWasAllocated, rendererVersion: getDocumentRenderer()?.version ?? "unavailable",
      leaseUntil: new Date(now.getTime() + RESERVATION_LEASE_MS),
    } })
  }, { maxWait: 10_000, timeout: 30_000 })
}

/** No transaction spans rendering or object storage. Only the token owner can finish preparation. */
export async function prepareDocument(stagingId: string): Promise<ArtifactStaging> {
  for (;;) {
    const staging = await prisma.artifactStaging.findUniqueOrThrow({ where: { id: stagingId } })
    if (staging.status !== "reserved") return staging
    if (staging.leaseUntil <= new Date()) throw new InvalidState({ code: "reservation_expired", message: "Document reservation expired" })
    // A policy can change after reservation or during rendering. Recheck before claiming and
    // before each renderer and store write against the frozen input and current locked draft. No lock spans
    // renderer or store calls; execution still rechecks under its own locks.
    const checkPreparation = async () => {
      if (staging.documentKind !== "agreement") return
      const renderInput = staging.renderInput as unknown as RenderInput
      const actor: Actor = { kind: "system", organizationId: staging.organizationId, reason: "scheduler", label: "Artifact preparation" }
      await prisma.$transaction(async tx => {
        await lockArtifactOrganization(tx, staging.organizationId)
        await runArtifactRead(prospectiveRenderInput({ kind: "agreement", commandInput: { id: staging.documentId },
          documentId: staging.documentId, number: staging.reservedNumber!, issuedAt: new Date(renderInput.issuedAt),
          method: "manual" }), tx, actor, new Date())
        await runArtifactRead(requireDepositsEnabled([{ isDeposit: offerHasDeposits(readAgreementOfferSnapshot(renderInput.snapshot)) }]), tx, actor, new Date())
      }, { maxWait: 10_000, timeout: 30_000 })
    }
    await checkPreparation()
    const prepToken = randomUUID()
    const claimed = await prisma.artifactStaging.updateMany({ where: { id: stagingId, status: "reserved", prepToken: null }, data: { prepToken } })
    if (!claimed.count) { await new Promise(resolve => setTimeout(resolve, 25)); continue }
    try {
      const renderer = getDocumentRenderer()
      const store = getDocumentArtifactStore()
      if (!renderer || !store) {
        if (getRuntimeCapabilities().documents.artifactsRequired) throw new InvalidState({ code: "renderer_unavailable", message: "Document renderer and artifact store required" })
        await prisma.artifactStaging.updateMany({ where: { id: stagingId, status: "reserved", prepToken },
          data: { status: "missing", missingReason: "renderer_unavailable", prepToken: null } })
      } else {
        if (renderer.version !== staging.rendererVersion) throw new InvalidState({
          code: "renderer_changed", message: "Renderer version changed after reservation",
        })
        const renderInput = staging.renderInput as unknown as RenderInput
        const storeBytes = async (format: "pdf" | "ubl", bytes: Uint8Array) => {
          await checkPreparation()
          const hash = hashBytes(bytes)
          const ref = await store.put(bytes, { organizationId: staging.organizationId,
            documentKind: renderInput.kind, documentId: staging.documentId, format,
            hash, size: bytes.byteLength, rendererVersion: staging.rendererVersion })
          return { ref, hash, size: bytes.byteLength }
        }
        await checkPreparation()
        const artifacts: StoredArtifacts = { pdf: await storeBytes("pdf", await renderer.renderPdf(renderInput)) }
        if (renderer.renderUbl) {
          await checkPreparation()
          const ubl = await renderer.renderUbl(renderInput)
          if (ubl) artifacts.ubl = await storeBytes("ubl", ubl)
        }
        await prisma.artifactStaging.updateMany({ where: { id: stagingId, status: "reserved", prepToken },
          data: { status: "stored", artifacts: artifactsJson(artifacts), prepToken: null } })
      }
      return await prisma.artifactStaging.findUniqueOrThrow({ where: { id: stagingId } })
    } catch (error) {
      await prisma.artifactStaging.updateMany({ where: { id: stagingId, status: "reserved", prepToken }, data: { prepToken: null } })
      throw error
    }
  }
}

/**
 * An issuance renders the document before its transaction, with the number it would receive. If
 * another document of that kind is issued first, the transaction refuses the stale number without
 * consuming anything and the document is prepared again. Each round is lost only to an issuance
 * that succeeded, so concurrent issuances all finish with distinct consecutive numbers.
 *
 * A short, jittered pause between rounds keeps a crowd of issuances from re-rendering in lockstep.
 */
export const MAX_NUMBER_ATTEMPTS = 25
const NUMBER_BACKOFF_MIN_MS = 20
const NUMBER_BACKOFF_MAX_MS = 100
const issuanceLogger = appLogger.child("issuance")

/** 20-30 ms after the first lost round, widening to 20-100 ms. */
export function numberRetryDelayMs(attempt: number, random = Math.random) {
  const ceiling = Math.min(NUMBER_BACKOFF_MAX_MS, NUMBER_BACKOFF_MIN_MS + 10 * attempt)
  return NUMBER_BACKOFF_MIN_MS + random() * (ceiling - NUMBER_BACKOFF_MIN_MS)
}

/** Code of the retryable failure returned when every round was lost to another issuance. */
export const NUMBER_CONTENTION = "number_contention"
type IssuanceOptions = Omit<ExecuteOptions, "actor" | "prepareIssuance"> & { method?: "email" | "manual" }
type IssuanceArgs = { commandInput: unknown; actor: Actor; clientRequestId?: string; options?: IssuanceOptions }
export function issueDocument(input: IssuanceArgs & { kind: "invoice" }): ReturnType<typeof executeCommand<Parameters<typeof sendInvoice.handle>[0], Effect.Effect.Success<ReturnType<typeof sendInvoice.handle>>>>
export function issueDocument(input: IssuanceArgs & { kind: "creditNote" }): ReturnType<typeof executeCommand<Parameters<typeof issueCreditNote.handle>[0], Effect.Effect.Success<ReturnType<typeof issueCreditNote.handle>>>>
export function issueDocument(input: IssuanceArgs & { kind: "agreement" }): Promise<CommandOutcome<any>>
export function issueDocument(input: IssuanceArgs & { kind: ArtifactDocumentKind }): Promise<CommandOutcome<any>>
export async function issueDocument(input: IssuanceArgs & { kind: ArtifactDocumentKind }): Promise<CommandOutcome<any>> {
  const definition = input.kind === "invoice" ? sendInvoice : input.kind === "creditNote" ? issueCreditNote
    : input.options?.method === "manual" ? issueAgreement : sendAgreement
  const clientRequestId = input.clientRequestId ?? input.options?.clientRequestId ?? randomUUID()
  const logContext = { kind: input.kind, organizationId: input.actor.organizationId, clientRequestId }
  for (let attempt = 1; ; attempt++) {
    const outcome = await executeCommand(definition as CommandDefinition<any, any>, input.commandInput, {
      ...input.options, actor: input.actor, clientRequestId,
      prepareIssuance: async (parsedInput, now) => {
        if (!getDocumentRenderer() || !getDocumentArtifactStore()) throw new InvalidState({ code: "renderer_unavailable", message: "Document renderer and artifact store required" })
        const staging = await reserveDocument({ ...input, commandInput: parsedInput, clientRequestId,
          now, method: input.options?.method })
        await prepareDocument(staging.id)
        return staging.id
      },
    })
    if (outcome.status !== "failed" || outcome.error.code !== NUMBER_CHANGED) {
      if (attempt > 1) issuanceLogger.info("number.retried", { ...logContext, attempts: attempt, completed: outcome.status === "completed" })
      return outcome
    }
    if (attempt >= MAX_NUMBER_ATTEMPTS) {
      issuanceLogger.warn("number.attempts_exhausted", { ...logContext, attempts: attempt })
      // Retryable like a provider outage: an external failure leaves no receipt under this request
      // id, and the same call can simply be made again. Nothing was consumed.
      return {
        status: "failed", commandId: outcome.commandId,
        error: serializeDomainError(new ExternalFailure({ service: "document_numbering", code: NUMBER_CONTENTION,
          message: "Many documents are being issued at once, so this one could not be numbered. Nothing was changed. Try again." })),
      }
    }
    await new Promise(resolve => setTimeout(resolve, numberRetryDelayMs(attempt)))
  }
}

/** Typed adapter shared by UI, MCP and approval execution. Re-emails use the ordinary pipeline. */
export function executeIssuanceCommand<I, R>(definition: CommandDefinition<I, R>, commandInput: unknown, options: ExecuteOptions): Promise<CommandOutcome<R>> {
  const kind = definition.type === "invoice.send" ? "invoice" : definition.type === "credit_note.issue" ? "creditNote"
    : ["agreement.send", "agreement.issue"].includes(definition.type) ? "agreement" : null
  if (!kind) return executeCommand(definition, commandInput, options)
  return issueDocument({ kind, commandInput, actor: options.actor, clientRequestId: options.clientRequestId,
    options: { ...options, method: definition.type === "agreement.issue" ? "manual" : "email" } })
}
