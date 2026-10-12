import { Effect } from "effect"
import { parseBuyerSnapshot, parseSellerSnapshot } from "@quits/contracts/documents"
import { validateVatIssuance, percentageToFraction, assertStoredDocumentEquation } from "@quits/shared/pricing"
import { isVatNumberScheme } from "../../lib/compliance"
import { toDecimal } from "../../lib/exports/format"
import { InvalidState } from "../errors"

/** Registration checks shared by invoices, quotes and agreement offers, without repricing. */
export function requireSellerVatIssuance(document: {
  taxRegime?: string
  sellerSnapshot: unknown
  items: Array<{
    vatRateInput: string | null
    vatTreatment: string
    taxRate: { toString(): string }
    lineTax: { toString(): string }
  }>
}) {
  const seller = parseSellerSnapshot(document.sellerSnapshot)
  if (document.taxRegime === "eu_vat" && seller?.momsRegistered == null)
    return Effect.fail(new InvalidState({ code: "seller_vat_status_unset", message: "Choose whether the seller is VAT-registered in company settings before sending." }))
  if (document.taxRegime === "eu_vat" && seller?.momsRegistered === false && document.items.some(item =>
    !toDecimal(item.taxRate.toString()).isZero() ||
    (item.vatRateInput !== null && !toDecimal(item.vatRateInput).isZero()) ||
    !toDecimal(item.lineTax.toString()).isZero()))
    return Effect.fail(new InvalidState({ code: "seller_not_vat_registered", message: "A seller who is not VAT-registered cannot issue a document with VAT. Set every line to 0% before sending." }))
  if (document.taxRegime === "eu_vat" && seller?.momsRegistered !== false &&
      document.items.some(item => item.vatTreatment === "unclassified_zero"))
    return Effect.fail(new InvalidState({ code: "evidence_incomplete", message: "Unclassified zero VAT requires a non-registered seller. Review the line VAT treatment before issuing." }))
  return Effect.void
}

/** Shared by issuance entry commands. Resends and issued-document operations never reprice. */
export function requireVatIssuance(document: {
  taxRegime?: string
  currency: string
  pricesIncludeTax: boolean
  subtotalNet: { toString(): string }
  totalTax: { toString(): string }
  totalGross: { toString(): string }
  vatEvidence: unknown
  sellerSnapshot: unknown
  buyerSnapshot: unknown
  items: Array<{
    vatRateInput: string | null
    vatTreatment: string
    vatReasonCode: string | null
    vatCountry: string | null
    taxRate: { toString(): string }
    lineNet: { toString(): string }
    lineTax: { toString(): string }
    lineGross: { toString(): string }
  }>
}) {
  return Effect.gen(function* () {
    const seller = parseSellerSnapshot(document.sellerSnapshot)
    const buyer = parseBuyerSnapshot(document.buyerSnapshot)
    yield* requireSellerVatIssuance(document)
    const issues = validateVatIssuance({
      momsRegistered: document.taxRegime === "eu_vat" ? seller?.momsRegistered : undefined,
      lines: document.items.map((item) => ({
        treatment: item.vatTreatment,
        reasonCode: item.vatReasonCode,
        country: item.vatCountry,
        // Stored nominal rates are percentages. Preserve their decimal spelling.
        rate: item.vatRateInput ?? percentageToFraction(item.taxRate.toString()),
      })),
      evidence: document.vatEvidence,
      sellerVatId: seller?.taxIds?.find((id) => isVatNumberScheme(id.scheme))?.value,
      buyerCountry: buyer?.country,
    })
    const evidence = document.vatEvidence as { buyerVatId?: string } | null
    if (document.items.some(item => item.vatTreatment === "intra_community") &&
        !buyer?.taxIds?.some(id => id.value === evidence?.buyerVatId)) issues.push("Buyer VAT evidence must match the buyer tax id refreshed at issuance")
    return yield* (issues.length
      ? Effect.fail(new InvalidState({ code: "evidence_incomplete", message: issues.join("; ") }))
      : Effect.try({
        try: () => assertStoredDocumentEquation({
          currency: document.currency,
          pricesIncludeTax: document.pricesIncludeTax,
          net: document.subtotalNet.toString(), tax: document.totalTax.toString(), gross: document.totalGross.toString(),
          lines: document.items.map((item) => ({
            vat: { treatment: item.vatTreatment, reasonCode: item.vatReasonCode, country: item.vatCountry, rate: item.vatRateInput ?? percentageToFraction(item.taxRate.toString()) },
            net: item.lineNet.toString(), tax: item.lineTax.toString(), gross: item.lineGross.toString(),
          })),
        }),
        catch: () => new InvalidState({ code: "invalid_document_equation", message: "Stored document amounts do not balance" }),
      }))
  })
}
