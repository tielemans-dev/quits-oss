import { Prisma } from "../../../generated/prisma/client"
import { resolveCountryProfile } from "../../lib/compliance"
import { requireCurrencyExponent } from "@quits/shared/currency"
import { InvalidState } from "../errors"
import { lockArtifactOrganization } from "./artifacts"

/**
 * Whether the organization has issued any document, which locks its base currency.
 * One statement, so the check costs a single round trip and a single connection.
 * Each EXISTS mirrors one condition: a non-draft invoice or quote, any credit note, an
 * agreement with an offer snapshot, an issuance event in history, or a bound issuance candidate.
 */
export async function hasIssuedDocuments(tx: Prisma.TransactionClient, organizationId: string) {
  const [row] = await tx.$queryRaw<[{ issued: boolean }]>`
    SELECT (
      EXISTS (SELECT 1 FROM "invoice" WHERE "organizationId" = ${organizationId} AND "status" <> 'draft')
      OR EXISTS (SELECT 1 FROM "credit_note" WHERE "organizationId" = ${organizationId})
      OR EXISTS (SELECT 1 FROM "quote" WHERE "organizationId" = ${organizationId} AND "status" <> 'draft')
      OR EXISTS (SELECT 1 FROM "agreement" WHERE "organizationId" = ${organizationId} AND "offerSnapshot" IS NOT NULL)
      OR EXISTS (
        SELECT 1 FROM "domain_event"
        WHERE "organizationId" = ${organizationId}
          AND "type" IN ('invoice.issued', 'invoice.sent', 'credit_note.issued', 'quote.sent', 'agreement.offer_issued')
      )
      OR EXISTS (SELECT 1 FROM "issuance_candidate" WHERE "organizationId" = ${organizationId} AND "status" = 'bound')
    ) AS "issued"
  `
  return row?.issued === true
}

/** Same organization lock as issuance. Country changes only default books before issuance. */
export async function resolveBaseCurrency(tx: Prisma.TransactionClient, organizationId: string, input: { countryCode?: string; baseCurrency?: string }) {
  await lockArtifactOrganization(tx, organizationId)
  const current = await tx.orgSettings.findUniqueOrThrow({ where: { organizationId } })
  const issued = await hasIssuedDocuments(tx, organizationId)
  const next = input.baseCurrency ?? (input.countryCode && input.countryCode !== current.countryCode && !issued
    ? resolveCountryProfile(input.countryCode).country?.defaults.currency ?? current.baseCurrency : current.baseCurrency)
  requireCurrencyExponent(next)
  if (issued && next !== current.baseCurrency) throw new InvalidState({ code: "base_currency_locked", message: "Base currency cannot change after an issued document" })
  return next
}
