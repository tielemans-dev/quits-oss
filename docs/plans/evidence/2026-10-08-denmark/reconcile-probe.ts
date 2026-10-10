// The parent's three round-1 reproductions, using the explicit acknowledgment contract.
// The original parent probe is preserved unchanged in the program's review evidence.
import assert from "node:assert/strict"
import { applyEinvoiceDeliveryEvent as apply, initialEinvoiceDeliveryState as initial, nextEinvoiceDeliveryAction as next } from "../../../../packages/contracts/src/einvoice-delivery"

const start = () => apply(initial("peppol_bis_billing_3", { scheme: "0088", id: "5798009811639" }, "invoice"), { type: "validation_passed" })
const submitted = () => apply(start(), { type: "submitted", providerReference: "ref-1" })
for (const [name, state, type] of [
  ["timeout-then-provider-confirms-queued", apply(start(), { type: "submission_outcome_unknown" }), "submission_reconciled"],
  ["known-reference-reconciles-as-queued", apply(submitted(), { type: "submission_outcome_unknown" }), "submission_reconciled"],
  ["retry-acknowledged-with-same-reference", apply(submitted(), { type: "transport_failed", code: "temporary-upstream-error", retryable: true }), "retry_submitted"],
] as const) {
  const result = apply(state, { type, providerReference: "ref-1" })
  assert.equal(result.transport, "queued")
  assert.equal(next(result), "wait")
  console.log(JSON.stringify({ case: name, transport: result.transport, nextAction: next(result), providerReference: result.providerReference }))
}
