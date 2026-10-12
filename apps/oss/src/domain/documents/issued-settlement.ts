import { Prisma } from "../../../generated/prisma/client"
import { issuedInvoiceSnapshot } from "./issued-invoice"
import { computeSettlement, type InvoiceSettlement } from "./settlement"

type Amount = Prisma.Decimal | number | string | { toNumber(): number }

/** Keep a real decimal intact. Plain numbers and snapshot strings stay exact too. */
function settlementAmount(value: Amount): Prisma.Decimal | number | string {
  if (typeof value === "number" || typeof value === "string" || value instanceof Prisma.Decimal) return value
  return value.toNumber()
}

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
    totalGross: frozen ? frozen.totals.gross : settlementAmount(input.totalGross),
    amountPaid: settlementAmount(input.amountPaid),
    amountCredited: settlementAmount(input.amountCredited),
  })
}

/** Net, tax, and gross as plain numbers: the issue-time snapshot when it parses, the row otherwise. */
export function issuedInvoiceTotals(input: {
  issuanceSnapshot?: unknown
  subtotalNet: Amount
  totalTax: Amount
  totalGross: Amount
}) {
  const frozen = issuedInvoiceSnapshot(input.issuanceSnapshot)
  const num = (value: Amount) => new Prisma.Decimal(settlementAmount(value)).toNumber()
  return {
    subtotal: num(frozen ? frozen.totals.net : input.subtotalNet),
    taxAmount: num(frozen ? frozen.totals.tax : input.totalTax),
    total: num(frozen ? frozen.totals.gross : input.totalGross),
  }
}
