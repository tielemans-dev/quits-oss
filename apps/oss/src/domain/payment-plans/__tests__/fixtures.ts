import { createHash } from "node:crypto"
import { agreementOfferSnapshotV1Schema, agreementOfferSnapshotV2Schema } from "@quits/contracts/agreements"
import { calculateDraft } from "@quits/shared/pricing"
import { minorFromAmount } from "../amounts"
import type { BillingStep, Obligation, PlanVersion, StepTrigger } from "../model"

export const hash = (text: string) => createHash("sha256").update(text).digest("hex")
/** DKK amounts in these fixtures are written as kroner; `dkk("12500")` is 1,250,000 øre. */
export const dkk = (amount: string) => minorFromAmount(Number(amount).toFixed(2), "DKK")

type Line = { id: string; title?: string; net: string; rate?: string; fulfillable?: boolean; cancelled?: boolean; schedule?: boolean }
const price = (lines: Array<{ id?: string; title?: string; net: string; rate?: string }>) => calculateDraft({
  currency: "DKK", pricesIncludeTax: false, taxRate: "25",
  items: lines.map((line) => ({ description: line.title ?? line.id ?? "Line", quantity: "1", unitPrice: line.net, ...(line.rate ? { vat: { treatment: "standard" as const, rate: line.rate } } : {}) })),
})

/** An accepted agreement whose scope lines are priced exclusive of 25% Danish VAT. */
export function agreementObligation(input: { agreementId: string; acceptedOn: string; lines: Line[]; revision?: number }): Obligation {
  const scope = input.lines.filter((line) => !line.schedule), schedule = input.lines.filter((line) => line.schedule)
  const priced = price(scope), scheduled = schedule.length ? price(schedule) : null
  return {
    ref: { kind: "agreement_services", agreementId: input.agreementId, offerRevision: input.revision ?? 1, offerSnapshotHash: hash(`${input.agreementId}:${input.revision ?? 1}`) },
    currency: "DKK", grossMinor: minorFromAmount(priced.gross, "DKK"), vatGroups: priced.groups, effectiveOn: input.acceptedOn,
    deliverables: [
      ...scope.map((line, index) => ({ deliverableId: line.id, kind: "scope" as const, grossMinor: minorFromAmount(priced.lines[index]!.gross, "DKK"), fulfillable: line.fulfillable ?? true, cancelled: line.cancelled ?? false })),
      ...schedule.map((line, index) => ({ deliverableId: line.id, kind: "payment_schedule" as const, grossMinor: minorFromAmount(scheduled!.lines[index]!.gross, "DKK"), fulfillable: false, cancelled: line.cancelled ?? false })),
    ],
    dueDate: null,
  }
}

/** An issued invoice as a collection obligation. */
export function invoiceObligation(input: { invoiceId: string; issuedOn: string; dueDate: string; gross: string }): Obligation {
  const priced = calculateDraft({ currency: "DKK", pricesIncludeTax: true, taxRate: "25", items: [{ description: "Invoice", quantity: "1", unitPrice: input.gross }] })
  return {
    ref: { kind: "invoice", invoiceId: input.invoiceId, issuedArtifactHash: hash(`${input.invoiceId}:pdf`) },
    currency: "DKK", grossMinor: dkk(input.gross), vatGroups: priced.groups, effectiveOn: input.issuedOn, deliverables: [], dueDate: input.dueDate,
  }
}

export const shareStep = (stepId: string, gross: string, trigger: StepTrigger, dueInDays = 14): BillingStep =>
  ({ stepId, label: stepId, grossMinor: gross, source: { kind: "share" }, trigger, dueInDays })
export const accepted = { kind: "on_acceptance" } as const
export const onAccepted = (...deliverableIds: string[]) => ({ kind: "on_deliverables", event: "accepted", deliverableIds }) as const

export function plan(obligation: Obligation, arrangement: PlanVersion["arrangement"], overrides: Partial<PlanVersion> = {}): PlanVersion {
  return {
    planId: `plan_${obligation.ref.kind === "agreement_services" ? obligation.ref.agreementId : obligation.ref.invoiceId}`,
    version: 1, supersedes: null, obligation: obligation.ref, currency: obligation.currency, arrangement,
    source: "agreement_offer", actor: { kind: "customer", id: "contact_1" }, reason: null, ...overrides,
  }
}

/** A stored offer snapshot exactly as `buildOfferSnapshot` writes it, parsed by the real contract. */
export function offerSnapshot(version: 1 | 2, lines: Array<{ title: string; net: string; isDeposit?: boolean }>) {
  const all = price(lines)
  const deliverables = lines.map((line, sortOrder) => {
    const row = all.lines[sortOrder]!
    return {
      title: line.title, description: line.title, quantity: version === 1 ? "1.00" : "1", unitPriceNet: Number(line.net).toFixed(2), unitPriceGross: Number(row.gross).toFixed(2),
      lineNet: row.net, lineTax: row.tax, lineGross: row.gross, taxRate: "25.00", taxCategory: "standard", taxCode: null,
      agreedDate: null, isDeposit: line.isDeposit ?? false, sortOrder,
    }
  })
  const common = {
    sellerSnapshot: null, buyerSnapshot: null, title: "Agreement", summary: null, termsHtml: "<p>Terms</p>", validUntil: "2026-12-31T00:00:00.000Z",
    timezone: "Europe/Copenhagen", currency: "DKK", countryCode: "DK", locale: "da-DK", taxRegime: "dk_vat", taxRate: "25.00",
    pricesIncludeTax: false, dueInDays: 14, billingTrigger: "on_acceptance" as const,
  }
  if (version === 1) return agreementOfferSnapshotV1Schema.parse({ ...common, subtotalNet: all.net, totalTax: all.tax, totalGross: all.gross, deliverables })
  const services = price(lines.filter((line) => !line.isDeposit))
  const schedule = lines.filter((line) => line.isDeposit)
  const scheduled = schedule.length ? price(schedule) : null
  return agreementOfferSnapshotV2Schema.parse({
    ...common, subtotalNet: services.net, totalTax: services.tax, totalGross: services.gross, deliverables,
    offerFormatVersion: 2, calculationVersion: "v2",
    serviceTotal: { net: services.net, tax: services.tax, gross: services.gross, payableRounding: services.payableRounding, vatBasis: "net" },
    paymentSchedule: schedule.map((line, index) => {
      const row = scheduled!.lines[index]!
      return { title: line.title, sortOrder: lines.indexOf(line), amount: row.net, vatBasis: "net", trigger: "on_agreement_acceptance", vatGroupKey: row.groupKey, net: row.net, tax: row.tax, gross: row.gross }
    }),
    originalInputs: lines.map((line, sortOrder) => ({ sortOrder, quantity: "1", unitPrice: line.net, inputPrecision: "string", vat: { treatment: "standard", rate: "0.25", country: null, reasonCode: null } })),
    vatGroups: services.groups, scheduleVatGroups: scheduled?.groups ?? [],
  })
}
