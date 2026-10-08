import { z } from "zod"
import { sumMinor } from "./amounts"
import { minorSchema, obligationSchema, planVersionSchema, refuse, type PlanRefusal } from "./model"
import { billableGross, validatePlan } from "./validate"

const id = z.string().min(1).max(200)
const positiveMinor = minorSchema.refine((value) => value !== "0", "Must be greater than zero")

/**
 * A complete snapshot for one agreement obligation and a validated plan version. Applications
 * are cumulative per receipt/invoice pair; refunds are cumulative per receipt. They are not
 * event lists. The caller must read the authoritative plan and ledger in the same transaction.
 */
export const positionInputSchema = z.strictObject({
  obligation: obligationSchema,
  plan: planVersionSchema,
  saleInvoices: z.array(z.strictObject({
    invoiceId: id, stepId: id, grossMinor: positiveMinor, taxMinor: minorSchema, creditedMinor: minorSchema,
    /** The part of the credit that forgives debt, rather than correcting a document for rebilling. */
    obligationReductionMinor: minorSchema.default("0"),
    /** Required for partial credits; full credits reverse the invoice's entire tax. */
    creditedTaxMinor: minorSchema.optional(),
  })),
  receipts: z.array(z.strictObject({
    receiptId: id, method: z.enum(["card", "bank_transfer"]), grossMinor: positiveMinor,
    for: z.discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("invoice"), invoiceId: id }),
      z.strictObject({ kind: z.literal("advance"), advanceId: id }),
    ]),
  })),
  applications: z.array(z.strictObject({ receiptId: id, invoiceId: id, grossMinor: positiveMinor })),
  refunds: z.array(z.strictObject({ receiptId: id, grossMinor: positiveMinor })),
})
export type PositionInput = z.input<typeof positionInputSchema>

export type Position = {
  billableMinor: bigint
  invoicedMinor: bigint
  creditedMinor: bigint
  obligationReductionMinor: bigint
  /** Agreed gross less explicit concessions; document corrections do not reduce it. */
  payableMinor: bigint
  /** Billable but not yet on a sale invoice. */
  uninvoicedMinor: bigint
  /** Output VAT on the sale invoices less credited tax; advances carry none here until #24 decides their treatment. */
  saleTaxMinor: bigint
  advanceRequestedMinor: bigint
  advanceReceivedMinor: bigint
  advanceAppliedMinor: bigint
  advanceRefundedMinor: bigint
  advanceAvailableMinor: bigint
  invoices: Array<{ invoiceId: string; stepId: string; grossMinor: bigint; creditedMinor: bigint; appliedMinor: bigint; paidMinor: bigint; openMinor: bigint; overpaidMinor: bigint }>
  /** What the customer still owes on issued sale invoices. */
  receivableMinor: bigint
  /** What the customer still has to pay for the whole obligation, invoiced or not. Negative is an overpayment to resolve. */
  remainingMinor: bigint
}

export function obligationPosition(raw: PositionInput): { ok: true; position: Position } | { ok: false; refusals: PlanRefusal[] } {
  const parsed = positionInputSchema.safeParse(raw)
  if (!parsed.success) return { ok: false, refusals: parsed.error.issues.map((issue) => refuse("invalid_position", `${issue.path.join(".")}: ${issue.message}`)) }
  const input = parsed.data
  const refusals = validatePlan(input.obligation, input.plan)
  if (refusals.length) return { ok: false, refusals }
  const arrangement = input.plan.arrangement
  if (arrangement.kind === "collection_installments") return { ok: false, refusals: [refuse("arrangement_not_allowed", "Positions are per agreement obligation")] }
  const steps = new Map(arrangement.steps.map((step) => [step.stepId, step]))
  const advances = new Map((arrangement.kind === "advance_then_billing" ? arrangement.advances : []).map((advance) => [advance.advanceId, advance]))

  const unique = (keys: string[], label: string) => {
    if (new Set(keys).size !== keys.length) refusals.push(refuse("duplicate_position_entry", `${label} must be unique`))
  }
  unique(input.saleInvoices.map((invoice) => invoice.invoiceId), "Invoice ids")
  unique(input.receipts.map((receipt) => receipt.receiptId), "Receipt ids")
  unique(input.applications.map((item) => JSON.stringify([item.receiptId, item.invoiceId])), "Application receipt/invoice pairs")
  unique(input.refunds.map((item) => item.receiptId), "Refund receipt ids")
  if (refusals.length) return { ok: false, refusals }

  const live = new Map<string, string>()
  const creditedTax = new Map<string, bigint>()
  for (const invoice of input.saleInvoices) {
    const step = steps.get(invoice.stepId)
    if (!step) { refusals.push(refuse("stale_plan_reference", `${invoice.invoiceId} bills a step outside the plan`)); continue }
    if (invoice.grossMinor !== step.grossMinor) refusals.push(refuse("total_mismatch", `${invoice.invoiceId} must bill exactly its step`))
    const gross = BigInt(invoice.grossMinor), tax = BigInt(invoice.taxMinor), credit = BigInt(invoice.creditedMinor)
    const reduction = BigInt(invoice.obligationReductionMinor)
    if (tax > gross || credit > gross || reduction > credit)
      refusals.push(refuse("invalid_position", `${invoice.invoiceId} tax or credit exceeds gross, or obligation reduction exceeds credit`))
    const fullyCredited = credit === gross
    const creditTax = invoice.creditedTaxMinor === undefined ? (fullyCredited ? tax : 0n) : BigInt(invoice.creditedTaxMinor)
    if ((credit > 0n && !fullyCredited && invoice.creditedTaxMinor === undefined) ||
        creditTax > tax || creditTax > credit || credit - creditTax > gross - tax || (fullyCredited && creditTax !== tax))
      refusals.push(refuse("invalid_position", `${invoice.invoiceId} needs the credit's valid frozen tax amount`))
    creditedTax.set(invoice.invoiceId, creditTax)
    if (!fullyCredited && live.has(invoice.stepId)) refusals.push(refuse("duplicate_step", `Step ${invoice.stepId} is billed by ${live.get(invoice.stepId)} and ${invoice.invoiceId}`))
    if (!fullyCredited) live.set(invoice.stepId, invoice.invoiceId)
  }
  const billableMinor = billableGross(input.obligation)
  const invoicedMinor = sumMinor(input.saleInvoices.map((invoice) => invoice.grossMinor))
  const creditedMinor = sumMinor(input.saleInvoices.map((invoice) => invoice.creditedMinor))
  const obligationReductionMinor = sumMinor(input.saleInvoices.map((invoice) => invoice.obligationReductionMinor))
  const payableMinor = billableMinor - obligationReductionMinor
  for (const step of steps.values()) {
    const billed = input.saleInvoices.filter((invoice) => invoice.stepId === step.stepId)
    const consumed = sumMinor(billed.map((invoice) => BigInt(invoice.grossMinor) - BigInt(invoice.creditedMinor) + BigInt(invoice.obligationReductionMinor)))
    if (consumed > BigInt(step.grossMinor)) refusals.push(refuse("double_counted", `Step ${step.stepId} rebills forgiven debt or exceeds its amount`))
  }
  if (invoicedMinor - creditedMinor > payableMinor) refusals.push(refuse("double_counted", "Sale invoices bill more than the payable obligation"))

  const receipts = new Map(input.receipts.map((receipt) => [receipt.receiptId, receipt]))
  const invoiceIds = new Set(input.saleInvoices.map((invoice) => invoice.invoiceId))
  for (const receipt of input.receipts) {
    if (receipt.for.kind === "advance" && !advances.has(receipt.for.advanceId)) refusals.push(refuse("stale_plan_reference", `${receipt.receiptId} pays an advance outside the plan`))
    if (receipt.for.kind === "invoice" && !invoiceIds.has(receipt.for.invoiceId))
      refusals.push(refuse("stale_plan_reference", `${receipt.receiptId} pays an invoice outside the obligation`))
  }
  for (const application of input.applications) {
    if (!receipts.has(application.receiptId)) refusals.push(refuse("stale_plan_reference", `Unknown advance receipt ${application.receiptId}`))
    if (!invoiceIds.has(application.invoiceId)) refusals.push(refuse("stale_plan_reference", `Unknown application invoice ${application.invoiceId}`))
  }
  for (const refund of input.refunds) {
    if (!receipts.has(refund.receiptId)) refusals.push(refuse("stale_plan_reference", `Unknown refund receipt ${refund.receiptId}`))
  }
  for (const [receiptId, receipt] of receipts) {
    const applied = sumMinor(input.applications.filter((item) => item.receiptId === receiptId).map((item) => item.grossMinor))
    const refunded = sumMinor(input.refunds.filter((item) => item.receiptId === receiptId).map((item) => item.grossMinor))
    if ((applied > 0n || refunded > 0n) && receipt.for.kind !== "advance") refusals.push(refuse("over_application", `${receiptId} paid an invoice; only advance money is applied or refunded here`))
    if (applied + refunded > BigInt(receipt.grossMinor)) refusals.push(refuse("over_application", `${receiptId} is applied or refunded beyond what was received`))
  }

  const invoices = input.saleInvoices.map((invoice) => {
    const grossMinor = BigInt(invoice.grossMinor), credited = BigInt(invoice.creditedMinor)
    const appliedMinor = sumMinor(input.applications.filter((item) => item.invoiceId === invoice.invoiceId).map((item) => item.grossMinor))
    const paidMinor = sumMinor(input.receipts.filter((receipt) => receipt.for.kind === "invoice" && receipt.for.invoiceId === invoice.invoiceId).map((receipt) => receipt.grossMinor))
    // Direct overpayments remain visible, but never allocate an advance on top of paid money.
    const unpaid = grossMinor - credited - paidMinor
    if (appliedMinor > (unpaid > 0n ? unpaid : 0n)) refusals.push(refuse("over_application", `Advances applied to ${invoice.invoiceId} exceed its unpaid balance`))
    const open = unpaid - appliedMinor
    return { invoiceId: invoice.invoiceId, stepId: invoice.stepId, grossMinor, creditedMinor: credited, appliedMinor, paidMinor, openMinor: open > 0n ? open : 0n, overpaidMinor: open < 0n ? -open : 0n }
  })
  if (refusals.length) return { ok: false, refusals }

  const advanceReceipts = input.receipts.filter((receipt) => receipt.for.kind === "advance")
  const advanceReceivedMinor = sumMinor(advanceReceipts.map((receipt) => receipt.grossMinor))
  const advanceAppliedMinor = sumMinor(input.applications.map((item) => item.grossMinor))
  const advanceRefundedMinor = sumMinor(input.refunds.map((item) => item.grossMinor))
  const paidOnInvoices = sumMinor(invoices.map((invoice) => invoice.paidMinor))
  return {
    ok: true,
    position: {
      billableMinor, invoicedMinor, creditedMinor, obligationReductionMinor, payableMinor,
      uninvoicedMinor: payableMinor - (invoicedMinor - creditedMinor),
      saleTaxMinor: sumMinor(input.saleInvoices.map((invoice) => BigInt(invoice.taxMinor) - creditedTax.get(invoice.invoiceId)!)),
      advanceRequestedMinor: sumMinor([...advances.values()].map((advance) => advance.grossMinor)),
      advanceReceivedMinor, advanceAppliedMinor, advanceRefundedMinor,
      advanceAvailableMinor: advanceReceivedMinor - advanceAppliedMinor - advanceRefundedMinor,
      invoices,
      receivableMinor: sumMinor(invoices.map((invoice) => invoice.openMinor)),
      remainingMinor: payableMinor - paidOnInvoices - (advanceReceivedMinor - advanceRefundedMinor),
    },
  }
}
