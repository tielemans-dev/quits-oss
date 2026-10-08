import { billableAllocationStateSchema } from "@quits/contracts/billing"
import { agreementStatusSchema, deliverableBillingStatusSchema, deliverableStatusSchema } from "@quits/contracts/agreements"
import { creditNoteStatusSchema } from "@quits/contracts/credit-notes"
import { emailDeliveryOutcomeSchema, emailDeliveryRuntimeStateSchema } from "@quits/contracts/email"
import { invoiceStatusSchema } from "@quits/contracts/invoices"
import { reminderStatusSchema } from "@quits/contracts/reminders"
import { recurringStatusSchema } from "@quits/contracts/recurring"
import { describe, expect, it } from "vitest"

import { daMessages, enMessages } from "../i18n/messages"
import {
  getStatusEntry,
  getStatusLabel,
  getStatusTone,
  statusTones,
  type StatusDomain,
  type StatusEntry,
  type StatusTone,
} from "../status-tones"

const tones: StatusTone[] = ["neutral", "info", "progress", "success", "warning", "danger", "muted"]

/** The statuses each domain can hold, from the contracts (the quote and settings ones have none). */
const contractStatuses: Partial<Record<StatusDomain, readonly string[]>> = {
  invoice: invoiceStatusSchema.options,
  creditNote: creditNoteStatusSchema.options,
  recurring: recurringStatusSchema.options,
  agreement: agreementStatusSchema.options,
  deliverable: deliverableStatusSchema.options,
  deliverableBilling: deliverableBillingStatusSchema.options,
  billableAllocation: billableAllocationStateSchema.options,
  emailDelivery: emailDeliveryOutcomeSchema.options,
  emailSetup: emailDeliveryRuntimeStateSchema.options,
  reminder: reminderStatusSchema.options,
}

describe("status tones", () => {
  it("covers every status the contracts define", () => {
    for (const [domain, statuses] of Object.entries(contractStatuses)) {
      const known = Object.keys(statusTones[domain as StatusDomain])
      for (const status of statuses ?? []) {
        expect(known, `${domain}.${status}`).toContain(status)
      }
    }
  })

  it("does not map statuses the contracts do not have", () => {
    for (const [domain, statuses] of Object.entries(contractStatuses)) {
      const extra = Object.keys(statusTones[domain as StatusDomain]).filter(
        (status) => !statuses?.includes(status)
      )
      // The invoice domain also holds `partially_paid`, derived from the payment status.
      expect(extra, domain).toEqual(domain === "invoice" ? ["partially_paid"] : [])
    }
  })

  it("covers the quote statuses and the sending-domain states", () => {
    expect(Object.keys(statusTones.quote)).toEqual(["draft", "sent", "accepted", "rejected", "expired"])
    expect(Object.keys(statusTones.documentSending)).toEqual([
      "not_configured",
      "pending_dns",
      "verifying",
      "verified",
      "failed",
    ])
  })

  it("labels every status in English and Danish", () => {
    for (const entries of Object.values<Record<string, StatusEntry>>(statusTones)) {
      for (const { labelKey } of Object.values(entries)) {
        expect(enMessages[labelKey], labelKey).toBeTruthy()
        expect(daMessages[labelKey], labelKey).toBeTruthy()
      }
    }
  })

  it("uses only known tones", () => {
    for (const entries of Object.values<Record<string, StatusEntry>>(statusTones)) {
      for (const { tone } of Object.values(entries)) expect(tones).toContain(tone)
    }
  })

  it("judges statuses by what they mean", () => {
    expect(getStatusTone("invoice", "draft")).toBe("neutral")
    expect(getStatusTone("invoice", "sent")).toBe("info")
    expect(getStatusTone("invoice", "viewed")).toBe("progress")
    expect(getStatusTone("invoice", "partially_paid")).toBe("warning")
    expect(getStatusTone("invoice", "paid")).toBe("success")
    expect(getStatusTone("invoice", "overdue")).toBe("danger")
    expect(getStatusTone("invoice", "credited")).toBe("muted")
    expect(getStatusTone("quote", "accepted")).toBe("success")
    expect(getStatusTone("quote", "rejected")).toBe("danger")
    expect(getStatusTone("quote", "expired")).toBe("muted")
    expect(getStatusTone("recurring", "active")).toBe("success")
    expect(getStatusTone("recurring", "paused")).toBe("warning")
    expect(getStatusTone("recurring", "ended")).toBe("muted")
    expect(getStatusTone("emailDelivery", "unconfirmed")).toBe("warning")
    expect(getStatusTone("reminder", "failed")).toBe("danger")
  })

  it("reads an unknown status as neutral and shows it as it is", () => {
    expect(getStatusEntry("invoice", "void")).toBeUndefined()
    expect(getStatusEntry("invoice", "constructor")).toBeUndefined()
    expect(getStatusTone("invoice", "void")).toBe("neutral")
    expect(getStatusLabel(() => "never", "invoice", "void")).toBe("void")
  })
})
