import { invoiceRemindersPausedInputSchema, reminderSendNowInputSchema } from "@yaip/contracts/reminders"
import { sendReminderNow, setInvoiceRemindersPaused } from "../../commands/reminders"
import { defineCommandTool, type AgentTool } from "../define"

export const reminderTools: AgentTool[] = [
  defineCommandTool({
    name: "reminder_send_now",
    title: "Send payment reminder",
    description:
      "Emails the customer a payment reminder for an open invoice with its balance and pay link. At " +
      "most one manual reminder per invoice per day.",
    command: sendReminderNow,
    input: reminderSendNowInputSchema,
  }),

  defineCommandTool({
    name: "invoice_set_reminders_paused",
    title: "Pause or resume reminders",
    description: "Stops or restarts automatic reminders for one invoice, e.g. while a dispute is open.",
    command: setInvoiceRemindersPaused,
    input: invoiceRemindersPausedInputSchema,
  }),
]
