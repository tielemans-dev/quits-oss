import { Effect } from "effect"
import {
  resolveCountryProfile,
  validateDocument,
  type ComplianceError,
  type CountryProfile,
  type TaxId,
} from "../../lib/compliance"
import { Command, Db } from "../services"

/** Organization settings, seller tax ids, and the country profile documents are built with. */
export const loadDocumentContext = Effect.gen(function* () {
  const db = yield* Db
  const { organizationId } = yield* Command

  const settings = yield* Effect.promise(() =>
    db.orgSettings.upsert({ where: { organizationId }, create: { organizationId }, update: {} })
  )
  const sellerTaxIds: TaxId[] = yield* Effect.promise(() =>
    db.organizationTaxId.findMany({
      where: { organizationId },
      select: { scheme: true, value: true, countryCode: true },
    })
  )

  return { settings, sellerTaxIds, profile: resolveCountryProfile(settings.countryCode) }
})

export type ComplianceAssessment = {
  status: "valid" | "warning" | "invalid"
  issues: ComplianceError[]
  blocking: ComplianceError[]
}

export function assessCompliance(
  profile: CountryProfile,
  sellerTaxIds: TaxId[],
  taxRate: number
): ComplianceAssessment {
  const issues = validateDocument(profile, { sellerTaxIds, buyerTaxIds: [], taxRate })
  const blocking = issues.filter((issue) => issue.severity === "error")
  return {
    status: blocking.length > 0 ? "invalid" : issues.length > 0 ? "warning" : "valid",
    issues,
    blocking,
  }
}
