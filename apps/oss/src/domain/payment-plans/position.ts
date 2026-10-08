import { sumMinor } from "./amounts"
import { refuse, type Obligation, type PlanRefusal, type PlanVersion } from "./model"
import { billableGross } from "./validate"

/**
 * One obligation's money, kept in separate buckets so nothing counts twice: sale invoices are the
 * only revenue documents; an advance is money held for the customer until it is applied to a sale
 * invoice or refunded; a receipt is either for an invoice or for an advance, never both.
 */
export type PositionInput = {
  obligation: Obligation
  plan: PlanVersion
  saleInvoices: Array<{ invoiceId: string; stepId: string; grossMinor: string; taxMinor: string; creditedMinor: string }>
  receipts: Array<{
    receiptId: string
    method: "card" | "bank_transfer"
    grossMinor: string
    for: { kind: "invoice"; invoiceId: string } | { kind: "advance"; advanceId: string }
  }>
  /** Advance money applied to a sale invoice of the same obligation. */
  applications: Array<{ receiptId: string; invoiceId: string; grossMinor: string }>
  refunds: Array<{ receiptId: string; grossMinor: string }>
}

export type Position = {
  billableMinor: bigint
  invoicedMinor: bigint
  creditedMinor: bigint
  /** Billable but not yet on a sale invoice. */
  uninvoicedMinor: bigint
  /** Output VAT on the sale invoices; advances carry none here until #24 decides their treatment. */
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

export function obligationPosition(input: PositionInput): { ok: true; position: Position } | { ok: false; refusals: PlanRefusal[] } {
  const refusals: PlanRefusal[] = []
  const arrangement = input.plan.arrangement
  if (arrangement.kind === "collection_installments") return { ok: false, refusals: [refuse("arrangement_not_allowed", "Positions are per agreement obligation")] }
  const steps = new Map(arrangement.steps.map((step) => [step.stepId, step]))
  const advances = new Map((arrangement.kind === "advance_then_billing" ? arrangement.advances : []).map((advance) => [advance.advanceId, advance]))

  const live = new Map<string, string>()
  for (const invoice of input.saleInvoices) {
    const step = steps.get(invoice.stepId)
    if (!step) { refusals.push(refuse("stale_plan_reference", `${invoice.invoiceId} bills a step outside the plan`)); continue }
    if (invoice.grossMinor !== step.grossMinor) refusals.push(refuse("total_mismatch", `${invoice.invoiceId} must bill exactly its step`))
    const fullyCredited = invoice.creditedMinor === invoice.grossMinor
    if (!fullyCredited && live.has(invoice.stepId)) refusals.push(refuse("duplicate_step", `Step ${invoice.stepId} is billed by ${live.get(invoice.stepId)} and ${invoice.invoiceId}`))
    if (!fullyCredited) live.set(invoice.stepId, invoice.invoiceId)
  }
  const billableMinor = billableGross(input.obligation)
  const invoicedMinor = sumMinor(input.saleInvoices.map((invoice) => invoice.grossMinor))
  const creditedMinor = sumMinor(input.saleInvoices.map((invoice) => invoice.creditedMinor))
  if (invoicedMinor - creditedMinor > billableMinor) refusals.push(refuse("double_counted", "Sale invoices bill more than the obligation"))

  const receipts = new Map(input.receipts.map((receipt) => [receipt.receiptId, receipt]))
  for (const receipt of input.receipts) {
    if (receipt.for.kind === "advance" && !advances.has(receipt.for.advanceId)) refusals.push(refuse("stale_plan_reference", `${receipt.receiptId} pays an advance outside the plan`))
    if (receipt.for.kind === "invoice" && !input.saleInvoices.some((invoice) => receipt.for.kind === "invoice" && invoice.invoiceId === receipt.for.invoiceId))
      refusals.push(refuse("stale_plan_reference", `${receipt.receiptId} pays an invoice outside the obligation`))
  }
  for (const [receiptId, receipt] of receipts) {
    const applied = sumMinor(input.applications.filter((item) => item.receiptId === receiptId).map((item) => item.grossMinor))
    const refunded = sumMinor(input.refunds.filter((item) => item.receiptId === receiptId).map((item) => item.grossMinor))
    if ((applied > 0n || refunded > 0n) && receipt.for.kind !== "advance") refusals.push(refuse("over_application", `${receiptId} paid an invoice; only advance money is applied or refunded here`))
    if (applied + refunded > BigInt(receipt.grossMinor)) refusals.push(refuse("over_application", `${receiptId} is applied or refunded beyond what was received`))
  }
  for (const application of input.applications) if (!receipts.has(application.receiptId)) refusals.push(refuse("over_application", `Unknown advance receipt ${application.receiptId}`))

  const invoices = input.saleInvoices.map((invoice) => {
    const grossMinor = BigInt(invoice.grossMinor), credited = BigInt(invoice.creditedMinor)
    const appliedMinor = sumMinor(input.applications.filter((item) => item.invoiceId === invoice.invoiceId).map((item) => item.grossMinor))
    const paidMinor = sumMinor(input.receipts.filter((receipt) => receipt.for.kind === "invoice" && receipt.for.invoiceId === invoice.invoiceId).map((receipt) => receipt.grossMinor))
    if (appliedMinor > grossMinor - credited) refusals.push(refuse("over_application", `Advances applied to ${invoice.invoiceId} exceed what it bills`))
    const open = grossMinor - credited - appliedMinor - paidMinor
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
      billableMinor, invoicedMinor, creditedMinor,
      uninvoicedMinor: billableMinor - (invoicedMinor - creditedMinor),
      saleTaxMinor: sumMinor(input.saleInvoices.map((invoice) => invoice.taxMinor)),
      advanceRequestedMinor: sumMinor([...advances.values()].map((advance) => advance.grossMinor)),
      advanceReceivedMinor, advanceAppliedMinor, advanceRefundedMinor,
      advanceAvailableMinor: advanceReceivedMinor - advanceAppliedMinor - advanceRefundedMinor,
      invoices,
      receivableMinor: sumMinor(invoices.map((invoice) => invoice.openMinor)),
      remainingMinor: billableMinor - creditedMinor - paidOnInvoices - (advanceReceivedMinor - advanceRefundedMinor),
    },
  }
}
