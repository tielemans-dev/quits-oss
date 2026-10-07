import { Prisma } from "../../../generated/prisma/client"
import { resolveCountryProfile } from "../../lib/compliance"
import { requireCurrencyExponent } from "@quits/shared/currency"
import { InvalidState } from "../errors"
import { lockArtifactOrganization } from "./artifacts"

export async function hasIssuedDocuments(tx: Prisma.TransactionClient, organizationId: string) {
  const [invoice, credit, quote, agreement, history, pending] = await Promise.all([
    tx.invoice.findFirst({ where: { organizationId, status: { not: "draft" } }, select: { id: true } }),
    tx.creditNote.findFirst({ where: { organizationId }, select: { id: true } }),
    tx.quote.findFirst({ where: { organizationId, status: { not: "draft" } }, select: { id: true } }),
    tx.agreement.findFirst({ where: { organizationId, offerSnapshot: { not: Prisma.DbNull } }, select: { id: true } }),
    tx.domainEvent.findFirst({ where: { organizationId, type: { in: ["invoice.issued", "invoice.sent", "credit_note.issued", "quote.sent", "agreement.offer_issued"] } }, select: { id: true } }),
    tx.issuanceCandidate.findFirst({ where: { organizationId, status: "bound" }, select: { id: true } }),
  ])
  return !!(invoice || credit || quote || agreement || history || pending)
}

/** Same organization lock as issuance. Country changes only default books before issuance. */
export async function resolveBaseCurrency(tx: Prisma.TransactionClient, organizationId: string, input: { countryCode?: string; baseCurrency?: string }) {
  await lockArtifactOrganization(tx, organizationId)
  const current = await tx.orgSettings.findUniqueOrThrow({ where: { organizationId } })
  const issued = await hasIssuedDocuments(tx, organizationId)
  const next = input.baseCurrency ?? (input.countryCode && input.countryCode !== current.countryCode && !issued
    ? resolveCountryProfile(input.countryCode).defaultCurrency : current.baseCurrency)
  requireCurrencyExponent(next)
  if (issued && next !== current.baseCurrency) throw new InvalidState({ code: "base_currency_locked", message: "Base currency cannot change after an issued document" })
  return next
}
