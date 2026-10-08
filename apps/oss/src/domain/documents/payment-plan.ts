import { Effect } from "effect"
import { Prisma } from "../../../generated/prisma/client"
import { currencyFractionDigits, isExactInCurrency } from "../../lib/payments/stripe-amounts"
import { documentRef } from "./numbering"
import { computeSettlement } from "./settlement"
import { InvalidState, ValidationFailed } from "../errors"

/** Shared validation and allocation for recorded money. No collection or database writes. */
export const planManualPayment = (invoice: {
  number: string | null; status: string; currency: string; totalGross: Prisma.Decimal;
  amountPaid: Prisma.Decimal; amountCredited: Prisma.Decimal;
}, input: { amount: number }) => Effect.gen(function* () {
  if (invoice.status === "draft") return yield* new InvalidState({ code: "invoice_not_issued", message: `${documentRef("invoice", invoice.number)} is a draft. Send it before recording payments.` })
  const before = computeSettlement(invoice)
  const amount = new Prisma.Decimal(input.amount.toFixed(2))
  if (before.fullyCredited || invoice.status === "credited") {
    return yield* new InvalidState({
      message: `${documentRef("invoice", invoice.number)} is fully credited and cannot receive payments`,
      code: "invoice_credited",
    })
  }

  // Settling the exact remaining balance is always allowed, so an invoice whose total was
  // computed with more precision than its currency has can still be paid off.
  if (!isExactInCurrency(input.amount, invoice.currency) && !amount.equals(before.balanceDue)) {
    const digits = currencyFractionDigits(invoice.currency)
    const message =
      digits === 0
        ? `${invoice.currency} amounts cannot have decimals`
        : `${invoice.currency} amounts can have at most ${digits} decimals`
    return yield* new ValidationFailed({ message, issues: [{ path: "amount", message }] })
  }
  if (before.balanceDue.isZero()) {
    return yield* new InvalidState({
      message: `${documentRef("invoice", invoice.number)} is already paid`,
      code: "invoice_already_paid",
    })
  }
  if (amount.greaterThan(before.balanceDue)) {
    return yield* new InvalidState({
      message: `Payment of ${amount.toFixed(2)} ${invoice.currency} exceeds the balance due of ${before.balanceDue.toFixed(2)} ${invoice.currency}`,
      code: "overpayment",
    })
  }
  return { before, amount, balanceAfter: before.balanceDue.minus(amount) }
})
