import type { AnyCommandDefinition } from "../command"
import { contactCommands } from "./contacts"
import { invoiceCommands } from "./invoices"
import { paymentCommands } from "./payments"
import { creditNoteCommands } from "./credit-notes"
import { reminderCommands } from "./reminders"
import { recurringCommands } from "./recurring"

/** Every command that can be queued for approval must be listed here. */
export const allCommands: readonly AnyCommandDefinition[] = [
  ...contactCommands,
  ...invoiceCommands,
  ...paymentCommands,
  ...creditNoteCommands,
  ...reminderCommands,
  ...recurringCommands,
]
