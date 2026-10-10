import type { AgreementOfferSnapshot } from "@quits/contracts/agreements"

/** Frozen v1 lines and v2 schedules both describe advance-payment obligations. */
export function offerHasDeposits(snapshot: AgreementOfferSnapshot) {
  return snapshot.deliverables.some(line => line.isDeposit) ||
    ("paymentSchedule" in snapshot && snapshot.paymentSchedule.length > 0)
}
