import { requireCurrencyExponent } from "@quits/shared/currency"
import { getRuntimeCapabilities } from "../../lib/runtime/extensions"
import type { InvoiceMoneySnapshot } from "./money-snapshot"
import { Prisma, type ArtifactStaging } from "../../../generated/prisma/client"
import { InvalidState } from "../errors"
import type { PendingEvent } from "../services"
import { hashRenderInput, type RenderInput } from "./render-input"

export type StoredArtifact = { ref: string; hash: string; size: number }
export type StoredArtifacts = { pdf: StoredArtifact; ubl?: StoredArtifact }
export const artifactsJson = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue

/** All artifact protocol transactions take this lock before document or job locks. */
export async function lockArtifactOrganization(tx: Prisma.TransactionClient, organizationId: string) {
  await tx.orgSettings.upsert({ where: { organizationId }, create: { organizationId }, update: {} })
  await tx.$queryRaw`SELECT id FROM "org_settings" WHERE "organizationId" = ${organizationId} FOR UPDATE`
}

export async function bindIssuanceCandidate(tx: Prisma.TransactionClient, input: {
  staging: ArtifactStaging; renderInput: RenderInput; now: Date; leaseNow?: Date; organizationId: string; requestKey: string
}) {
  const { staging, renderInput, now } = input
  if (staging.organizationId !== input.organizationId ||
      !(staging.requestKey === input.requestKey || staging.requestKeys.includes(input.requestKey))) {
    throw new InvalidState({ code: "reservation_identity_mismatch", message: "Reservation belongs to another request" })
  }
  if (staging.status === "abandoned" || staging.leaseUntil <= (input.leaseNow ?? now)) {
    throw new InvalidState({ code: "reservation_expired", message: "Document reservation expired" })
  }
  if (!["stored", "missing", "candidate_bound", "published"].includes(staging.status)) {
    throw new InvalidState({ code: "preparation_incomplete", message: "Document preparation is incomplete" })
  }
  if (hashRenderInput(renderInput) !== staging.renderInputHash) {
    throw new InvalidState({ code: "document_changed", message: "Document changed during preparation" })
  }
  if (getRuntimeCapabilities().documents.artifactsRequired && !staging.artifacts) throw new InvalidState({ code: "renderer_unavailable", message: "Document renderer and artifact store required" })
  const candidate = await tx.issuanceCandidate.create({ data: {
    organizationId: input.organizationId, documentKind: staging.documentKind, documentId: staging.documentId,
    stagingId: staging.id, renderInput: artifactsJson(renderInput), renderInputHash: staging.renderInputHash,
    recipient: renderInput.recipient, artifacts: staging.artifacts ?? Prisma.DbNull, attemptAt: now,
  } })
  await tx.artifactStaging.update({ where: { id: staging.id }, data: {
    status: staging.status === "published" ? "published" : "candidate_bound", candidateRefs: { push: candidate.id },
  } })
  return candidate
}

export async function pendingCandidate(tx: Prisma.TransactionClient, target: Record<string, string>) {
  if (!target.candidateId) return true // Deliveries queued before A3a and ordinary re-emails.
  return !!await tx.issuanceCandidate.findFirst({ where: {
    id: target.candidateId, documentId: target.documentId, status: "bound",
    attemptAt: new Date(target.attemptAt),
  } })
}

/** Publication uses only the candidate. A delivery can settle even after its preparation lease. */
export async function publishCandidate(tx: Prisma.TransactionClient, input: {
  candidateId: string; documentId: string; attemptAt: Date; organizationId: string; commandId?: string
}): Promise<PendingEvent[]> {
  const candidate = await tx.issuanceCandidate.findFirst({ where: {
    id: input.candidateId, organizationId: input.organizationId, documentId: input.documentId,
    attemptAt: input.attemptAt, status: "bound",
  }, include: { staging: true } })
  if (!candidate) throw new InvalidState({ code: "candidate_mismatch", message: "Delivery candidate does not match" })
  const artifacts = candidate.artifacts as StoredArtifacts | null
  const data = {
    artifactPdfRef: artifacts?.pdf.ref ?? null, artifactPdfHash: artifacts?.pdf.hash ?? null,
    artifactUblRef: artifacts?.ubl?.ref ?? null, artifactUblHash: artifacts?.ubl?.hash ?? null,
  }
  const money = ((candidate.renderInput as unknown as RenderInput).snapshot as { money?: InvoiceMoneySnapshot }).money
  const settings = !money && candidate.documentKind !== "agreement" ? await tx.orgSettings.findUniqueOrThrow({ where: { organizationId: input.organizationId } }) : null
  const financialData = money ? { valuation: artifactsJson(money.valuation), issuanceSnapshot: artifactsJson(money), sellerSnapshot: artifactsJson(money.seller), buyerSnapshot: artifactsJson(money.buyer) } : settings ? { valuation: artifactsJson({ base: { minor: null, currency: settings.baseCurrency, exponent: requireCurrencyExponent(settings.baseCurrency) }, rate: null, rateScale: null, rateDate: null, rateSource: "unknown" }) } : {}
  if (candidate.documentKind === "invoice") await tx.invoice.update({ where: { id: candidate.documentId }, data: { ...data, ...financialData, ...(money ? { supplyDate: money.supplyDate ? new Date(money.supplyDate) : null } : {}) } })
  else if (candidate.documentKind === "creditNote") await tx.creditNote.update({ where: { id: candidate.documentId }, data: { ...data, ...financialData } })
  else await tx.agreement.update({ where: { id: candidate.documentId }, data })
  await tx.issuanceCandidate.update({ where: { id: candidate.id }, data: { status: "published" } })
  await tx.artifactStaging.update({ where: { id: candidate.stagingId }, data: { status: "published" } })
  const billingEvents: PendingEvent[] = []
  if (candidate.documentKind === "invoice") {
    const snapshot = (candidate.renderInput as unknown as RenderInput).snapshot as { agreementId?: string | null; items?: Array<{ deliverableId: string | null }> }
    if (snapshot.agreementId) {
      for (const line of snapshot.items ?? []) {
        if (!line.deliverableId) continue
        const changed = await tx.deliverable.updateMany({ where: { id: line.deliverableId, agreementId: snapshot.agreementId, billingStatus: "reserved" }, data: { billingStatus: "invoiced" } })
        if (changed.count !== 1) throw new InvalidState({ code: "reservation_mismatch", message: "Candidate deliverable reservation does not match" })
        const invoiceId = candidate.documentId
        billingEvents.push({ aggregateType: "agreement", aggregateId: snapshot.agreementId, type: "deliverable.invoiced", payload: { deliverableId: line.deliverableId, invoiceId } })
      }
    }
  }
  const documentKind = candidate.documentKind
  const documentId = candidate.documentId
  const candidateId = candidate.id
  const rendererVersion = candidate.staging.rendererVersion
  const reason = candidate.staging.missingReason ?? "renderer_unavailable"
  const artifactEvents: PendingEvent[] = artifacts ? [{
    aggregateType: "document", aggregateId: documentId, type: "document.artifact_stored",
    payload: { documentKind, documentId, candidateId, artifacts, rendererVersion },
  }] : [{
    aggregateType: "document", aggregateId: documentId, type: "document.artifact_missing",
    payload: { documentKind, documentId, candidateId, reason },
  }]
  if (money) {
    const payload = { ...money, artifacts, provenance: { ...money.provenance, candidateId, commandId: input.commandId ?? null } }
    billingEvents.push({ aggregateType: documentKind === "invoice" ? "invoice" : "credit_note", aggregateId: documentId, type: documentKind === "invoice" ? "invoice.issued" : "credit_note.issued", payload })
  }
  return [...billingEvents, ...artifactEvents]
}
export async function retireCandidate(tx: Prisma.TransactionClient, target: Record<string, string>, organizationId: string) {
  if (!target.candidateId) return
  await tx.issuanceCandidate.updateMany({ where: {
    id: target.candidateId, organizationId, documentId: target.documentId,
    attemptAt: new Date(target.attemptAt), status: "bound",
  }, data: { status: "retired" } })
}
