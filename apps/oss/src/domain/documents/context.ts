import { Effect } from "effect"
import {
  resolveCountryProfile,
  validateDocument,
  type ComplianceError,
  type CountryProfile,
  type TaxId,
} from "../../lib/compliance"
import { Command, Db } from "../services"

/** Primary tax id first, then older rows. Document VAT resolution follows this order. */
export function orderedDocumentTaxIds<T extends { isPrimary?: boolean; createdAt?: Date }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => Number(Boolean(b.isPrimary)) - Number(Boolean(a.isPrimary)) || (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0))
}

/** Organization settings, seller tax ids, and the country profile documents are built with. */
export const loadDocumentContext = Effect.gen(function* () {
  const db = yield* Db
  const { organizationId } = yield* Command

  const settings = yield* Effect.promise(() =>
    db.orgSettings.upsert({ where: { organizationId }, create: { organizationId }, update: {} })
  )
  const sellerTaxIds: TaxId[] = yield* Effect.promise(async () => {
    const rows = await db.organizationTaxId.findMany({
      where: { organizationId },
      orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
      select: { scheme: true, value: true, countryCode: true, isPrimary: true, createdAt: true },
    })
    return orderedDocumentTaxIds(rows).map(({ scheme, value, countryCode }) => ({ scheme, value, countryCode }))
  })

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
