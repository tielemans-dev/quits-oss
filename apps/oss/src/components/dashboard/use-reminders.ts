import { useCallback, useState } from "react"

/** What the server says about a reminder it accepted; `delivery` is how far the email got. */
export type SendReminder = (invoiceId: string) => Promise<{ delivery: string }>

/** Why a reminder was refused, as far as the server says so; `unknown` is everything else. */
export type ReminderFailure =
  | "alreadyReminded"
  | "noRecipient"
  | "emailUnavailable"
  | "notRemindable"
  | "forbidden"
  | "notFound"
  | "unknown"

export type ReminderState =
  | { status: "sending" }
  | { status: "sent"; delivery: string }
  | { status: "error"; failure: ReminderFailure }

const FAILURE_BY_REASON: Record<string, ReminderFailure> = {
  already_reminded: "alreadyReminded",
  missing_recipient: "noRecipient",
  email_unavailable: "emailUnavailable",
  not_remindable: "notRemindable",
}

const FAILURE_BY_CODE: Record<string, ReminderFailure> = {
  FORBIDDEN: "forbidden",
  NOT_FOUND: "notFound",
}

/**
 * Reads a refusal by its codes and never by its text, since the text is the server's English. A
 * domain refusal carries `data.reason` (`already_reminded`, `missing_recipient`, `email_unavailable`,
 * `not_remindable`), and every tRPC error carries `data.code`. A failure with neither, such as the
 * email provider refusing the message, is `unknown` and gets the generic line.
 */
export function reminderFailure(error: unknown): ReminderFailure {
  const data = (error as { data?: { reason?: unknown; code?: unknown } } | null)?.data
  if (typeof data?.reason === "string" && data.reason in FAILURE_BY_REASON) return FAILURE_BY_REASON[data.reason]!
  if (typeof data?.code === "string" && data.code in FAILURE_BY_CODE) return FAILURE_BY_CODE[data.code]!
  return "unknown"
}

/**
 * The state of each reminder sent from the dashboard, by invoice. It lives above the lists so a
 * reminder sent from the attention list is also known to the incoming list, and survives the
 * summary reloading underneath: once a reminder is sent today the server stops offering the
 * action (`canRemind` turns false), and the row keeps saying "Påmindelse sendt" instead of
 * going quiet.
 *
 * A refusal (the server rechecks everything) is an `error` with its failure, which the row words in
 * the catalogue; the action stays available so the person can try again or open the invoice.
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
        setStates((current) => ({ ...current, [invoiceId]: { status: "error", failure: reminderFailure(error) } }))
      } finally {
        // Success or refusal, what can be reminded has changed.
        onSettled?.()
      }
    },
    [send, onSettled]
  )

  return { states, remind }
}
