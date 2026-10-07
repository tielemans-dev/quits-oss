import { reminderSendNowInputSchema } from "@quits/contracts/reminders"
import {
  invoiceReminderTargetSchema,
  pauseInvoiceReminders,
  resumeInvoiceReminders,
  sendReminderNow,
} from "../../commands/reminders"
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
    name: "invoice_pause_reminders",
    title: "Pause reminders",
    description: "Stops automatic payment reminders for one invoice, e.g. while a dispute is open.",
    command: pauseInvoiceReminders,
    input: invoiceReminderTargetSchema,
  }),

  defineCommandTool({
    name: "invoice_resume_reminders",
    title: "Resume reminders",
    description:
      "Restarts automatic payment reminders for one invoice, so the customer is emailed again on the " +
      "reminder schedule.",
    command: resumeInvoiceReminders,
    input: invoiceReminderTargetSchema,
  }),
]
