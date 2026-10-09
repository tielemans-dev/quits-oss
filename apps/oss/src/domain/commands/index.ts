import { provenanceCommands } from "./settlement-provenance"
import { settlementCommands } from "./settlements"
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
import { billingAllocationCommands } from "./billing-allocation"

/**
 * Every command that can be queued for approval must be listed here.
 *
 * `organization.update_payment_details` is deliberately absent: changing where customers send money
 * is a person's decision in settings, never something an approved agent request may dispatch.
 */
export const allCommands: readonly AnyCommandDefinition[] = [
  ...contactCommands,
  ...invoiceCommands,
  recordBaseValuation,
  ...quoteCommands,
  ...agreementCommands,
  ...billingAllocationCommands,
  ...paymentCommands,
  ...settlementCommands,
  ...provenanceCommands,
  ...creditNoteCommands,
  ...reminderCommands,
  ...recurringCommands,
]
