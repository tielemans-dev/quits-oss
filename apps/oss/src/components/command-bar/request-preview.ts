import { useSyncExternalStore } from "react"

/**
 * What the card being looked at would do to the page, before it is confirmed: an invoice that
 * would be added, invoices that would be paid or reminded. The page draws it in place, as a ghost
 * of the result, and forgets it when the card goes.
 */
export type RequestPreview =
  | { kind: "invoice"; customer: string; amount: number; currency: string; dueDate: string }
  | { kind: "paid" | "reminded"; invoiceIds: readonly string[] }

let current: RequestPreview | null = null
const listeners = new Set<() => void>()

export function previewRequest(preview: RequestPreview | null): void {
  if (JSON.stringify(preview) === JSON.stringify(current)) return
  current = preview
  for (const listener of listeners) listener()
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export const useRequestPreview = () => useSyncExternalStore(subscribe, () => current, () => null)
