import { normalizePeppolIdentifier, peppolEndpointIssue } from "@quits/contracts/exports"

export type PeppolEndpointFormError =
  | "exports.contact.peppolEndpoint.incomplete"
  | "exports.contact.peppolEndpointScheme.invalid"
  | "exports.contact.peppolEndpointId.invalid"

export type PeppolEndpointFormValue =
  | { ok: true; peppolEndpointId: string | null; peppolEndpointScheme: string | null }
  | { ok: false; error: PeppolEndpointFormError }

/**
 * Reads the Peppol endpoint fields of a contact form. Two empty fields mean "no endpoint" (`null`,
 * which clears a saved one on edit); one empty field or a value that does not fit the EAS scheme is
 * an error the form shows before submitting.
 */
export function readPeppolEndpoint(form: FormData): PeppolEndpointFormValue {
  const id = String(form.get("peppolEndpointId") ?? "").trim()
  const scheme = String(form.get("peppolEndpointScheme") ?? "").trim()
  if (!id && !scheme) return { ok: true, peppolEndpointId: null, peppolEndpointScheme: null }
  if (!id || !scheme) return { ok: false, error: "exports.contact.peppolEndpoint.incomplete" }
  const issue = peppolEndpointIssue(scheme, id)
  if (issue === "scheme") return { ok: false, error: "exports.contact.peppolEndpointScheme.invalid" }
  if (issue === "id") return { ok: false, error: "exports.contact.peppolEndpointId.invalid" }
  // Save the identifier exactly as the e-invoice export will emit it.
  return { ok: true, peppolEndpointId: normalizePeppolIdentifier(scheme, id), peppolEndpointScheme: scheme }
}
