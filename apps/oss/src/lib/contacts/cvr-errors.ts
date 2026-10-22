import type { TranslationKey } from "../i18n/messages"

const code = (err: unknown) => (err as { data?: { code?: string } } | null)?.data?.code

/** The message for a failed register lookup: no such company, no lookup here, or the lookup failed. */
export function cvrLookupError(err: unknown): TranslationKey {
  return code(err) === "NOT_FOUND" ? "shell.request.customer.notFound" : code(err) === "NOT_IMPLEMENTED" ? "shell.request.customer.unavailable" : "shell.request.customer.lookupError"
}

/** Refusals of the save itself; any other server error on a save with `registryCvr` came from its lookup. */
const saveRefusals = new Set(["BAD_REQUEST", "UNAUTHORIZED", "FORBIDDEN", "CONFLICT", "PRECONDITION_FAILED"])

/** For a customer saved with `registryCvr`: the lookup message when the server's lookup failed, else null. */
export function cvrSaveLookupError(err: unknown): TranslationKey | null {
  const failed = code(err)
  return failed && !saveRefusals.has(failed) ? cvrLookupError(err) : null
}
