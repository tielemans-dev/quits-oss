import { calculateLegacyDocument } from "@quits/shared/pricing"
import type { CountryProfile, TaxComputationInput, TaxComputationOutput } from "./country-profile"

/** Frozen v1 per-line arithmetic retained for agreement offer snapshots. */
export function computeDocumentTotals(_profile: CountryProfile, input: TaxComputationInput): TaxComputationOutput {
  return calculateLegacyDocument(input)
}
