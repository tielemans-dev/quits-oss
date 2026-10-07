import { createHash } from "node:crypto"
import { agreementOfferSnapshotSchema } from "@quits/contracts/agreements"
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
export function buildOfferSnapshot(agreement: Agreement & { deliverables: Deliverable[] }) {
  return agreementOfferSnapshotSchema.parse({
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

export function hashOfferSnapshot(snapshot: ReturnType<typeof buildOfferSnapshot>) {
  return createHash("sha256").update(canonicalizeOffer(snapshot)).digest("hex")
}
