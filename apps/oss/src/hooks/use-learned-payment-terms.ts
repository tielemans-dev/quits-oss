import { useCallback, useEffect, useState } from "react"

import { loadOrganizationSettings } from "../lib/organization-settings-query"
import { trpc } from "../trpc/client"
import { invoiceDueDate } from "./use-invoice-due-date"

/** Terms a customer's last invoices agree on, with the due date counted from today by the same code the form uses. */
export type LearnedDueDate = { days: number; count: number; dueDate: string }

type State = { contactId: string; learned: LearnedDueDate | null; cleared: LearnedDueDate | null }
const none = (contactId: string): State => ({ contactId, learned: null, cleared: null })

/**
 * The due date learned for one customer, or null. A missing or failed read is no hint at all and
 * never blocks the invoice. `clear` drops the default; `restore` is its Fortryd.
 */
export function useLearnedPaymentTerms(contactId: string) {
  const [state, setState] = useState<State>(none(""))

  useEffect(() => {
    if (!contactId) return
    let cancelled = false
    Promise.all([trpc.invoices.learnedDefaults.query({ contactId }), loadOrganizationSettings()])
      .then(([{ paymentTerms }, settings]) => {
        if (cancelled) return
        const dueDate = paymentTerms ? invoiceDueDate(paymentTerms.days, settings.timezone) : ""
        setState({ contactId, learned: paymentTerms && dueDate ? { ...paymentTerms, dueDate } : null, cleared: null })
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [contactId])

  const current = state.contactId === contactId ? state : none(contactId)

  const clear = useCallback(async () => {
    const { learned } = current
    if (!learned) return
    await trpc.invoices.clearLearnedDefault.mutate({ contactId })
    setState({ contactId, learned: null, cleared: learned })
  }, [contactId, current])

  const restore = useCallback(async () => {
    const { cleared } = current
    if (!cleared) return
    await trpc.invoices.restoreLearnedDefault.mutate({ contactId })
    setState({ contactId, learned: cleared, cleared: null })
  }, [contactId, current])

  return { learned: current.learned, cleared: current.cleared, clear, restore }
}
