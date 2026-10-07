import { Effect } from "effect"
import { InvalidState } from "../errors"
import { calculateDraft, calculateLegacyDocument, decimalInput, decimalReferencePrices, percentageToFraction, fractionToPercentage } from "@quits/shared/pricing"
import type { DraftVatEvidence } from "@quits/contracts/vat"
import type { DocumentLineInput } from "@quits/contracts/invoices"
import { currencyFractionDigits } from "../../lib/payments/stripe-amounts"

/** Document amounts are stored with two decimals, so three-decimal currencies round to two. */
export function documentFractionDigits(currency: string) {
  return Math.min(currencyFractionDigits(currency), 2)
}

/** Prices lines and returns totals plus item rows ready to persist. */
export function priceDocument(input: {
  items: Array<{ description: string; quantity: number; unitPrice: number }>
  taxRate: number
  pricesIncludeTax: boolean
  currency: string
}) {
  const totals = calculateLegacyDocument({
    items: input.items,
    taxRate: input.taxRate,
    pricesIncludeTax: input.pricesIncludeTax,
    fractionDigits: documentFractionDigits(input.currency),
  })

  return {
    subtotalNet: totals.subtotalNet,
    totalTax: totals.totalTax,
    totalGross: totals.totalGross,
    itemRows: totals.lines.map((line, index) => ({
      description: line.description,
      quantity: line.quantity,
      unitPriceNet: line.unitPriceNet,
      unitPriceGross: line.unitPriceGross,
      lineNet: line.lineNet,
      lineTax: line.lineTax,
      lineGross: line.lineGross,
      taxRate: line.taxRate,
      taxCategory: "standard",
      sortOrder: index,
    })),
  }
}

/** Recover the document-rate convenience from a nominal line rate, never rounded totals. */
export function impliedTaxRate(document: {
  subtotalNet: { toNumber(): number }
  totalTax: { toNumber(): number }
  items?: ReadonlyArray<{ taxRate: { toNumber(): number } }>
}) {
  // Lines store the nominal rate. Deriving it from rounded totals drifts (25% on 105 JPY rounds to
  // 26 tax, which reads back as 24.76%), so totals are only a fallback for documents without lines.
  const lineRate = (document.items?.find((item) => item.taxRate.toNumber() > 0) ?? document.items?.[0])?.taxRate.toNumber()
  if (lineRate !== undefined) {
    return lineRate
  }
  const net = document.subtotalNet.toNumber()
  return net > 0 ? (document.totalTax.toNumber() / net) * 100 : 0
}

/** Current pricing path; legacy priceDocument stays frozen for v1 agreement offers. */
export function priceDocumentV2(input: {
  items: DocumentLineInput[]
  taxRate: string | number
  pricesIncludeTax: boolean
  currency: string
  vatEvidence?: DraftVatEvidence
}) {
  const calculation = calculateDraft(input)
  return {
    calculation,
    calculationVersion: "v2" as const,
    subtotalNet: calculation.net,
    totalTax: calculation.tax,
    totalGross: calculation.gross,
    itemRows: calculation.lines.map((line, index) => {
      const source = input.items[index]!
      return {
        description: source.description,
        quantity: line.quantity,
        quantityInput: line.quantity,
        unitPriceInput: line.unitPrice,
        inputPrecision: typeof source.quantity === "number" || typeof source.unitPrice === "number"
          ? "number" : source.inputPrecision ?? decimalInput(source.quantity).inputPrecision,
        // Compatibility columns are display references, never inputs to another v2 calculation.
        ...decimalReferencePrices(line.quantity, line.net, line.gross),
        lineNet: line.net,
        lineTax: line.tax,
        lineGross: line.gross,
        taxRate: fractionToPercentage(line.vat.rate),
        taxCategory: line.vat.treatment,
        vatTreatment: line.vat.treatment,
        vatRateInput: line.vat.rate,
        vatCountry: line.vat.country,
        vatReasonCode: line.vat.reasonCode,
        sortOrder: line.sortOrder,
      }
    }),
  }
}

/** Recover original inputs, including the original gross/net basis, on every draft edit. */
export function storedDraftItems(document: {
  pricesIncludeTax: boolean
  items: Array<{
    description: string
    quantity: { toString(): string }
    unitPriceNet: { toString(): string }
    unitPriceGross: { toString(): string }
    quantityInput: string | null
    unitPriceInput: string | null
    inputPrecision: string | null
    vatRateInput: string | null
    vatTreatment: string
    vatCountry: string | null
    vatReasonCode: string | null
    taxRate: { toString(): string }
  }>
}): DocumentLineInput[] {
  return document.items.map((item) => ({
    description: item.description,
    quantity: item.quantityInput ?? item.quantity.toString(),
    unitPrice: item.unitPriceInput ?? (document.pricesIncludeTax ? item.unitPriceGross : item.unitPriceNet).toString(),
    inputPrecision: (item.inputPrecision ?? "backfilled") as DocumentLineInput["inputPrecision"],
    vat: {
      treatment: item.vatTreatment as NonNullable<DocumentLineInput["vat"]>["treatment"],
      rate: item.vatRateInput ?? percentageToFraction(item.taxRate.toString()),
      country: item.vatCountry,
      reasonCode: item.vatReasonCode as NonNullable<DocumentLineInput["vat"]>["reasonCode"],
    },
  }))
}

/** Convert input/precision refusals into command errors before any draft writes commit. */
export function priceCurrentDraft(input: Parameters<typeof priceDocumentV2>[0]) {
  return Effect.try({
    try: () => priceDocumentV2(input),
    catch: () => new InvalidState({ code: "invalid_pricing_input", message: "Invalid decimal inputs or VAT classification" }),
  })
}
