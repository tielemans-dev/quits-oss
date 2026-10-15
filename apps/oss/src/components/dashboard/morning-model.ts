import { normalizeCountryCode } from "../../lib/compliance/registry"
import { nextVatDeadline, type VatDeadline, type VatPeriod } from "../../lib/vat-deadline"
import { overdueInvoices, totalsByCurrency, MAX_BATCH, type Invoice } from "../command-bar/overdue-invoices"

/** The moms deadline joins the summary once it is this close; before that it is not news. */
export const VAT_NOTICE_DAYS = 60

export type DraftInvoice = Invoice & {
  contactId: string | null
  total: number
  lastEmailAttemptOutcome?: string | null
}

export type MorningSettings = {
  timezone: string | null
  countryCode: string
  taxRegime: string
  momsRegistered?: boolean | null
  vatPeriod?: VatPeriod | null
}

/** The key of what `invoices.sendReadiness` answers for: one customer in one currency. */
export const readinessKey = (draft: Pick<DraftInvoice, "contactId" | "currency">) => `${draft.contactId}|${draft.currency}`

/**
 * The drafts that Fakturaer lists as Kladde and that can be sent as they are: a customer, an
 * amount, and a clean `sendReadiness` for that customer (`readyKeys`). The server still checks on send.
 */
export function readyDrafts(invoices: readonly DraftInvoice[], readyKeys: ReadonlySet<string>) {
  return invoices.filter(
    (invoice) =>
      invoice.status === "draft" &&
      invoice.contactId !== null &&
      invoice.total > 0 &&
      invoice.lastEmailAttemptOutcome !== "sending" &&
      readyKeys.has(readinessKey(invoice))
  )
}

/** The moms deadline of the organization's own period, or null when it files none or has not said. */
export function morningVat(settings: MorningSettings | null, today: string): VatDeadline | null {
  if (!settings?.vatPeriod || settings.momsRegistered !== true) return null
  if (normalizeCountryCode(settings.countryCode) !== "DK" || settings.taxRegime !== "eu_vat") return null
  return nextVatDeadline(settings.vatPeriod, today)
}

export function presentMorning(input: {
  invoices: readonly DraftInvoice[]
  settings: MorningSettings | null
  reminded: ReadonlySet<string>
  readyKeys: ReadonlySet<string>
  today: string
}) {
  const overdue = overdueInvoices(input.invoices, input.settings?.timezone ?? null, input.reminded)
  const drafts = readyDrafts(input.invoices, input.readyKeys)
  const vat = morningVat(input.settings, input.today)
  return {
    overdue: {
      count: overdue.length,
      // What "Send rykker til N" will tick: the same N the overdue card starts with.
      batch: Math.min(overdue.length, MAX_BATCH),
      totals: totalsByCurrency(overdue.map(({ invoice }) => invoice)),
      oldestDays: overdue[0]?.days ?? 0,
    },
    drafts: {
      count: drafts.length,
      totals: totalsByCurrency(drafts.map((draft) => ({ ...draft, balanceDue: draft.total }))),
      customers: [...new Set(drafts.map((draft) => draft.contact.name))],
    },
    vat,
    /** Nothing to do today: no overdue, no draft, no deadline close enough to count. */
    visible: overdue.length > 0 || drafts.length > 0 || (vat !== null && vat.daysLeft <= VAT_NOTICE_DAYS),
  }
}

export type MorningModel = ReturnType<typeof presentMorning>
