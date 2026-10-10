import { invoiceIssuedSchema } from "../events/money"

const presentationSnapshotSchema = invoiceIssuedSchema.omit({ artifacts: true, provenance: true }).strip()

/** Sparse historic snapshots stay sparse. Never derive missing historic identities or dates. */
export function issuedInvoiceSnapshot(value: unknown) {
  const parsed = presentationSnapshotSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}
