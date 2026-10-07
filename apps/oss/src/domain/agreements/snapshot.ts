import { calculateDraft, percentageToFraction } from "@quits/shared/pricing"
import type { VatTreatment, VatReasonCode } from "@quits/contracts/vat"
import { createHash } from "node:crypto"
import { agreementOfferSnapshotV1Schema, agreementOfferSnapshotV2Schema } from "@quits/contracts/agreements"
import type { Agreement, Deliverable } from "../../../generated/prisma/client"
import { renderAgreementMarkdown } from "../../lib/agreements/markdown"

/** Recursively sorted object keys; array order is part of the offer. */
export function canonicalizeOffer(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalizeOffer).join(",")}]`
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalizeOffer(item)}`)
      .join(",")}}`
  }
  return JSON.stringify(value)
}

export function agreementPlaceholders(agreement: Agreement & { deliverables: Deliverable[] }) {
  const seller = agreement.sellerSnapshot as { companyName?: string | null } | null
  const buyer = agreement.buyerSnapshot as { name?: string } | null
  return {
    "seller.name": seller?.companyName ?? "",
    "buyer.name": buyer?.name ?? "",
    "agreement.title": agreement.title,
    "agreement.validUntil": agreement.validUntil.toISOString().slice(0, 10),
    "agreement.total": `${agreement.totalGross.toFixed(2)} ${agreement.currency}`,
    deliverables: agreement.deliverables
      .slice()
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((line) => `${line.title}: ${line.description}`)
      .join("\n"),
  }
}

/** Explicit allowlist: operational state, identity, and audit data cannot enter the frozen offer. */
export function buildOfferSnapshotV1(agreement: Agreement & { deliverables: Deliverable[] }) {
  return agreementOfferSnapshotV1Schema.parse({
    sellerSnapshot: agreement.sellerSnapshot,
    buyerSnapshot: agreement.buyerSnapshot,
    title: agreement.title,
    summary: agreement.summary,
    termsHtml: renderAgreementMarkdown(agreement.termsMarkdown, agreementPlaceholders(agreement)),
    validUntil: agreement.validUntil.toISOString(),
    timezone: agreement.timezone,
    currency: agreement.currency,
    countryCode: agreement.countryCode,
    locale: agreement.locale,
    taxRegime: agreement.taxRegime,
    taxRate: agreement.taxRate.toFixed(2),
    pricesIncludeTax: agreement.pricesIncludeTax,
    dueInDays: agreement.dueInDays,
    billingTrigger: agreement.billingTrigger,
    subtotalNet: agreement.subtotalNet.toFixed(2),
    totalTax: agreement.totalTax.toFixed(2),
    totalGross: agreement.totalGross.toFixed(2),
    deliverables: agreement.deliverables
      .slice()
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((line) => ({
        title: line.title,
        description: line.description,
        quantity: line.quantity.toFixed(2),
        unitPriceNet: line.unitPriceNet.toFixed(2),
        unitPriceGross: line.unitPriceGross.toFixed(2),
        lineNet: line.lineNet.toFixed(2),
        lineTax: line.lineTax.toFixed(2),
        lineGross: line.lineGross.toFixed(2),
        taxRate: line.taxRate.toFixed(2),
        taxCategory: line.taxCategory,
        taxCode: line.taxCode,
        agreedDate: line.agreedDate?.toISOString() ?? null,
        isDeposit: line.isDeposit,
        sortOrder: line.sortOrder,
      })),
  })
}

/** Explicit version dispatch preserves every byte of the v1 builder above. */
export function buildOfferSnapshot(agreement: Agreement & { deliverables: Deliverable[] }) {
  if (agreement.offerFormatVersion == null) return buildOfferSnapshotV1(agreement)
  if (agreement.offerFormatVersion !== 2) throw new Error("Unsupported offer format version")
  const lines = agreement.deliverables.slice().sort((a, b) => a.sortOrder - b.sortOrder)
  const input = (line: Deliverable) => ({
    description: line.description || line.title,
    quantity: line.quantityInput ?? line.quantity.toString(),
    unitPrice: line.unitPriceInput ?? (agreement.pricesIncludeTax ? line.unitPriceGross : line.unitPriceNet).toString(),
    vat: { treatment: line.vatTreatment as VatTreatment,
      rate: line.vatRateInput ?? percentageToFraction(line.taxRate.toString()),
      country: line.vatCountry, reasonCode: line.vatReasonCode as VatReasonCode | null },
  })
  const services = calculateDraft({ currency: agreement.currency, pricesIncludeTax: agreement.pricesIncludeTax,
    taxRate: agreement.taxRateInput ?? agreement.taxRate.toString(), items: lines.filter(line => !line.isDeposit).map(input) })
  const schedule = calculateDraft({ currency: agreement.currency, pricesIncludeTax: agreement.pricesIncludeTax,
    taxRate: agreement.taxRateInput ?? agreement.taxRate.toString(), items: lines.filter(line => line.isDeposit).map(input) })
  const vatBasis = agreement.pricesIncludeTax ? "gross" as const : "net" as const
  // Reuse the frozen v1 field allowlist, then extend it only on the v2 branch.
  const common = buildOfferSnapshotV1(agreement)
  let scheduleIndex = 0
  return agreementOfferSnapshotV2Schema.parse({
    ...common, deliverables: common.deliverables.map((line, i) => ({ ...line, quantity: input(lines[i]!).quantity })),
    offerFormatVersion: 2, calculationVersion: "v2",
    serviceTotal: { net: services.net, tax: services.tax, gross: services.gross, payableRounding: services.payableRounding, vatBasis },
    paymentSchedule: lines.filter(line => line.isDeposit).map(line => {
      const priced = schedule.lines[scheduleIndex++]!
      return { title: line.title, sortOrder: line.sortOrder,
        amount: vatBasis === "gross" ? priced.gross : priced.net, vatBasis,
        trigger: "on_agreement_acceptance", vatGroupKey: priced.groupKey,
        net: priced.net, tax: priced.tax, gross: priced.gross }
    }),
    originalInputs: lines.map(line => ({ sortOrder: line.sortOrder, quantity: input(line).quantity,
      unitPrice: input(line).unitPrice, inputPrecision: line.inputPrecision ?? "backfilled", vat: input(line).vat })),
    vatGroups: services.groups, scheduleVatGroups: schedule.groups,
  })
}

export function hashOfferSnapshot(snapshot: ReturnType<typeof buildOfferSnapshot>) {
  return createHash("sha256").update(canonicalizeOffer(snapshot)).digest("hex")
}
