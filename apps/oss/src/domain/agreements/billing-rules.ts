export function isBillable(agreement: { status: string; billingTrigger: string }, line: { billingStatus: string; status: string; isDeposit: boolean }) {
  return agreement.status === "accepted" && line.billingStatus === "unbilled" && line.status !== "cancelled" &&
    (line.isDeposit || line.status === "accepted" || (line.status === "delivered" && agreement.billingTrigger === "on_delivery"))
}
