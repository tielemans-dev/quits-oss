import { useCallback, useState } from "react"

/** What the server says about a reminder it accepted; `delivery` is how far the email got. */
export type SendReminder = (invoiceId: string) => Promise<{ delivery: string }>

export type ReminderState =
  | { status: "sending" }
  | { status: "sent"; delivery: string }
  | { status: "error"; message: string | null }

/**
 * The state of each reminder sent from the dashboard, by invoice. It lives above the lists so a
 * reminder sent from the attention list is also known to the incoming list, and survives the
 * summary reloading underneath: once a reminder is sent today the server stops offering the
 * action (`canRemind` turns false), and the row keeps saying "Påmindelse sendt" instead of
 * going quiet.
 *
 * A refusal (the server rechecks everything) is an `error` with the server's own message, and the
 * action stays available so the person can try again or open the invoice.
 */
export function useReminders(send: SendReminder, onSettled?: () => void) {
  const [states, setStates] = useState<Record<string, ReminderState>>({})

  const remind = useCallback(
    async (invoiceId: string) => {
      setStates((current) => {
        if (current[invoiceId]?.status === "sending") return current
        return { ...current, [invoiceId]: { status: "sending" } }
      })
      try {
        const result = await send(invoiceId)
        setStates((current) => ({ ...current, [invoiceId]: { status: "sent", delivery: result.delivery } }))
      } catch (error) {
        const message = error instanceof Error && error.message ? error.message : null
        setStates((current) => ({ ...current, [invoiceId]: { status: "error", message } }))
      } finally {
        // Success or refusal, what can be reminded has changed.
        onSettled?.()
      }
    },
    [send, onSettled]
  )

  return { states, remind }
}
