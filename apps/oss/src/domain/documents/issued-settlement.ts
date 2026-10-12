import { issuedInvoiceSnapshot } from "./issued-invoice"
import { computeSettlement, type InvoiceSettlement } from "./settlement"

type Amount = Parameters<typeof computeSettlement>[0]["totalGross"]

/**
 * Outstanding balance of an issued invoice. The gross is the one frozen at issuance; payments
 * and credits are that invoice's own. Organization settings never supply an amount.
 */
export function issuedInvoiceSettlement(input: {
  issuanceSnapshot?: unknown
  totalGross: Amount
  amountPaid: Amount
  amountCredited: Amount
}): InvoiceSettlement {
  const frozen = issuedInvoiceSnapshot(input.issuanceSnapshot)
  return computeSettlement({
    totalGross: frozen ? frozen.totals.gross : input.totalGross,
    amountPaid: input.amountPaid,
    amountCredited: input.amountCredited,
  })
}
