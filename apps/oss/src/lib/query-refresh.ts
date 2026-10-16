/** Query families, including every argument/filter variant of each reader. */
export const mutationQueries = {
  payments: ["payments", "invoices", "dashboard", "activity", "agents", "agreements"],
  paymentDetails: ["paymentDetails", "settings", "invoices", "quotes", "agreements", "dashboard"],
  invoices: ["invoices", "payments", "dashboard", "activity", "agents", "agreements", "recurring"],
  quotes: ["quotes", "invoices", "agreements", "dashboard", "activity", "agents"],
  creditNotes: ["creditNotes", "payments", "invoices", "agreements", "dashboard", "activity", "agents"],
  contacts: ["contacts", "invoices", "quotes", "agreements", "recurring", "dashboard", "activity"],
  catalog: ["catalog"],
  agreements: ["agreements", "quotes", "invoices", "dashboard", "activity", "agents"],
  recurring: ["recurring", "invoices", "dashboard", "activity", "agents"],
  agents: ["agents", "invoices", "quotes", "creditNotes", "agreements", "recurring", "dashboard", "activity"],
  settings: ["settings", "runtime", "invoices", "quotes", "creditNotes", "agreements", "recurring", "dashboard", "agents"],
  reminders: ["reminders", "invoices", "contacts", "dashboard", "activity", "jobs"],
  jobs: ["jobs", "invoices", "creditNotes", "dashboard", "activity"],
  onboarding: ["onboarding", "settings", "runtime"],
} as const
export type QueryKey = typeof mutationQueries[keyof typeof mutationQueries][number]

export function affectedQueries(path: string): readonly QueryKey[] {
  return mutationQueries[path.split(".")[0] as keyof typeof mutationQueries] ?? []
}

type Listener = { keys: readonly QueryKey[]; organizationId: string | null; refresh: () => void }
const listeners = new Set<Listener>()
export function subscribeQueryRefresh(keys: readonly QueryKey[], organizationId: string | null, refresh: () => void) {
  const listener = { keys, organizationId, refresh }
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
export function notifyMutation(path: string, organizationId: string | null) {
  const affected = affectedQueries(path)
  for (const listener of listeners) {
    if (listener.organizationId === organizationId && listener.keys.some(key => affected.includes(key))) listener.refresh()
  }
}

type MutationFailure = { error: Error; organizationId: string | null }
const errorListeners = new Set<(failure: MutationFailure) => void>()
export function reportMutationError(error: Error, organizationId: string | null) {
  for (const listener of errorListeners) listener({ error, organizationId })
}
export function subscribeMutationErrors(listener: (failure: MutationFailure) => void) {
  errorListeners.add(listener)
  return () => { errorListeners.delete(listener) }
}

/** Issuance/delivery may persist before the email provider rejects the operation. */
export function mayPartiallyCommit(path: string) {
  return path === "reminders.sendNow" || /^agreements\.(send|resend|sendReadLink)$/.test(path) || /^(invoices|quotes|creditNotes)\.(send|resendEmail|issue)$/.test(path)
}

/** Callers with inline error handling opt out of the global fallback. */
export const handledMutationError = { context: { handlesMutationError: true } }
