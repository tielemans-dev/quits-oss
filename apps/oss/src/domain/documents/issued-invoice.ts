import { parseSellerSnapshot } from "@quits/contracts/documents"
import { invoiceIssuedSchema } from "../events/money"

const presentationSnapshotSchema = invoiceIssuedSchema.omit({ artifacts: true, provenance: true }).strip()

/** Sparse historic snapshots stay sparse. Never derive missing historic identities or dates. */
export function issuedInvoiceSnapshot(value: unknown) {
  const parsed = presentationSnapshotSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

/**
 * Seller frozen when the invoice was issued. A readable issuance snapshot wins even when its
 * seller is sparse: the row snapshot and later organization settings must not fill it in.
 */
export function issuedSeller(issuanceSnapshot: unknown, sellerSnapshot: unknown) {
  const frozen = issuedInvoiceSnapshot(issuanceSnapshot)
  return frozen ? frozen.seller : parseSellerSnapshot(sellerSnapshot)
}
