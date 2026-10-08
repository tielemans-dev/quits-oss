import { recordBaseValuation } from "./base-valuation"
import { agreementCommands } from "./agreements"
import type { AnyCommandDefinition } from "../command"
import { contactCommands } from "./contacts"
import { invoiceCommands } from "./invoices"
import { quoteCommands } from "./quotes"
import { paymentCommands } from "./payments"
import { creditNoteCommands } from "./credit-notes"
import { reminderCommands } from "./reminders"
import { recurringCommands } from "./recurring"
import { paymentDetailsCommands } from "./payment-details"

/** Every command that can be queued for approval must be listed here. */
export const allCommands: readonly AnyCommandDefinition[] = [
  ...contactCommands,
  ...invoiceCommands,
  recordBaseValuation,
  ...quoteCommands,
  ...agreementCommands,
  ...paymentCommands,
  ...creditNoteCommands,
  ...reminderCommands,
  ...recurringCommands,
  ...paymentDetailsCommands,
]
