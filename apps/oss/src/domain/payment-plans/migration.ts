import { readAgreementOfferSnapshot, type AgreementOfferSnapshot } from "@quits/contracts/agreements"
import { recurringItemsSchema } from "@quits/contracts/recurring"
import { draftVatEvidenceSchema } from "@quits/contracts/vat"
import { getCurrencyExponent } from "@quits/shared/currency"
import { priceDocumentV2 } from "../documents/pricing"
import type { PlanFacts } from "./amendment"
import { minorFromAmount, sumMinor } from "./amounts"
import type { BillingStep, Consent, Obligation, PlanVersion, RecurringInstruction } from "./model"
import { billableGross, validatePlan } from "./validate"

/*
 * Report-only classification of today's agreement schedules and recurring schedules into the
 * canonical model. It reads rows as they are stored and never changes them: issued invoices,
 * drafts, reservations and the prepayment block stay exactly as they are. Anything that needs a
 * person's judgement is a finding, never an automatic fix.
 */

export type MigrationFinding = {
  code:
    | "not_accepted" | "unsupported_currency" | "offer_snapshot_unreadable" | "scope_does_not_match_offer" | "plan_invalid"
    | "v1_deposit_in_total" | "v1_prepayment_draft_bills_scope" | "v2_schedule_is_advance" | "prepayment_draft_remains_blocked"
    | "v2_schedule_invoiced_as_sale" | "double_count_exposure" | "double_counted" | "cancelled_line_excluded"
    | "recurring_ended" | "recurring_price_follows_settings" | "recurring_items_unreadable" | "generation_is_not_collection"
  severity: "info" | "review" | "blocking"
  detail: string
  invoiceIds?: string[]
  deliverableIds?: string[]
  amountMinor?: string
}

/** The subset of today's agreement, deliverable and invoice rows the migration reads. */
export type CurrentAgreement = {
  id: string
  status: string
  currency: string
  offerFormatVersion: number | null
  offerRevision: number
  acceptedOfferRevision: number | null
  offerSnapshotHash: string | null
  offerSnapshot: unknown
  /** Acceptance as a calendar date in the agreement's timezone. */
  acceptedOn: string | null
  billingTrigger: "on_acceptance" | "on_delivery"
  dueInDays: number
  deliverables: Array<{ id: string; title: string; isDeposit: boolean; status: string; billingStatus: string; lineGross: string; sortOrder: number }>
  invoices: Array<{
    id: string
    purpose: "sale" | "prepayment"
    status: string
    scheduleSaleChoice: { deliverableIds?: string[] } | null
    items: Array<{ deliverableId: string | null; lineGross: string }>
  }>
}

export type AgreementMigration = {
  agreementId: string
  obligation: Obligation | null
  plan: PlanVersion | null
  consent: Consent | null
  /** Existing linked invoices mapped to the plan's steps and advances. */
  facts: PlanFacts | null
  findings: MigrationFinding[]
}

export const migrationActor = { kind: "migration" as const, id: "canonical-payment-schedule-v1" }

export function migrateAgreement(row: CurrentAgreement): AgreementMigration {
  const findings: MigrationFinding[] = []
  const result = (rest: Partial<AgreementMigration> = {}): AgreementMigration =>
    ({ agreementId: row.id, obligation: null, plan: null, consent: null, facts: null, findings, ...rest })
  if (row.acceptedOfferRevision === null || !row.acceptedOn) {
    findings.push({ code: "not_accepted", severity: "info", detail: "The plan becomes authoritative when the offer is accepted" })
    return result()
  }
  const exponent = getCurrencyExponent(row.currency)
  if (exponent === undefined || exponent > 2) {
    findings.push({ code: "unsupported_currency", severity: "blocking", detail: `${row.currency} has no supported minor unit` })
    return result()
  }
  const snapshot = ((): AgreementOfferSnapshot | null => {
    try { return readAgreementOfferSnapshot(row.offerSnapshot) } catch { return null }
  })()
  if (!snapshot || !row.offerSnapshotHash || row.offerRevision !== row.acceptedOfferRevision) {
    findings.push({ code: "offer_snapshot_unreadable", severity: "blocking", detail: "The accepted offer snapshot is missing, unreadable or not the accepted revision" })
    return result()
  }
  const v2 = "offerFormatVersion" in snapshot ? snapshot : null
  const minor = (amount: string) => minorFromAmount(amount, row.currency)
  const lines = [...row.deliverables].sort((a, b) => a.sortOrder - b.sortOrder)
  const isSchedule = (line: CurrentAgreement["deliverables"][number]) => v2 !== null && line.isDeposit
  const obligation: Obligation = {
    ref: { kind: "agreement_services", agreementId: row.id, offerRevision: row.acceptedOfferRevision, offerSnapshotHash: row.offerSnapshotHash },
    currency: row.currency,
    grossMinor: minor(v2 ? v2.serviceTotal.gross : snapshot.totalGross),
    vatGroups: v2?.vatGroups ?? [],
    effectiveOn: row.acceptedOn,
    deliverables: lines.map((line) => ({
      deliverableId: line.id, kind: isSchedule(line) ? "payment_schedule" as const : "scope" as const, grossMinor: minor(line.lineGross),
      fulfillable: !line.isDeposit, cancelled: line.status === "cancelled",
    })),
    dueDate: null,
  }
  if (sumMinor(obligation.deliverables.filter((line) => line.kind === "scope").map((line) => line.grossMinor)) !== BigInt(obligation.grossMinor)) {
    findings.push({ code: "scope_does_not_match_offer", severity: "blocking", detail: "Stored lines do not add up to the accepted total" })
    return result({ obligation })
  }
  const cancelled = lines.filter((line) => line.status === "cancelled")
  if (cancelled.length) findings.push({ code: "cancelled_line_excluded", severity: "info", detail: "Cancelled lines are not billed by the plan", deliverableIds: cancelled.map((line) => line.id) })

  const scope = lines.filter((line) => !isSchedule(line) && line.status !== "cancelled")
  const schedule = lines.filter((line) => isSchedule(line) && line.status !== "cancelled")
  const steps: BillingStep[] = scope.map((line) => ({
    stepId: line.id, label: line.title, grossMinor: minor(line.lineGross), source: { kind: "deliverable", deliverableId: line.id },
    trigger: line.isDeposit ? { kind: "on_acceptance" } : { kind: "on_deliverables", event: row.billingTrigger === "on_delivery" ? "delivered" : "accepted", deliverableIds: [line.id] },
    dueInDays: row.dueInDays,
  }))
  if (!v2 && lines.some((line) => line.isDeposit))
    findings.push({ code: "v1_deposit_in_total", severity: "info", detail: "In this offer the deposit lines are part of the agreed total: billing steps due on acceptance, not advances" })
  if (schedule.length)
    findings.push({ code: "v2_schedule_is_advance", severity: "info", detail: "The payment schedule requests money against the service total; it is an advance arrangement, gated until the Danish advance rules are decided (#24)", deliverableIds: schedule.map((line) => line.id) })
  const plan: PlanVersion = {
    planId: `plan_${row.id}`, version: 1, supersedes: null, obligation: obligation.ref, currency: row.currency,
    arrangement: schedule.length
      ? { kind: "advance_then_billing", application: "next_sale_invoice", steps,
          advances: schedule.map((line) => ({ advanceId: line.id, label: line.title, grossMinor: minor(line.lineGross), trigger: { kind: "on_acceptance" as const }, dueInDays: row.dueInDays })) }
      : { kind: "billing_steps", steps },
    source: "migration", actor: migrationActor, reason: `Migrated from ${v2 ? "v2" : "v1"} offer revision ${row.acceptedOfferRevision}`,
  }
  const invalid = validatePlan(obligation, plan)
  for (const refusal of invalid) findings.push({ code: "plan_invalid", severity: "blocking", detail: `${refusal.code}: ${refusal.detail}` })

  const documents: PlanFacts["documents"] = []
  const scheduleSales: Array<{ invoiceId: string; deliverableId: string; grossMinor: string; issued: boolean }> = []
  for (const invoice of row.invoices) {
    const issued = invoice.status !== "draft"
    for (const item of invoice.items) {
      const line = lines.find((candidate) => candidate.id === item.deliverableId)
      if (!line) continue
      if (isSchedule(line) && invoice.purpose === "sale") scheduleSales.push({ invoiceId: invoice.id, deliverableId: line.id, grossMinor: minor(item.lineGross), issued })
      else documents.push({ targetId: line.id, invoiceId: invoice.id, status: issued ? "issued" : "draft" })
    }
    if (invoice.purpose === "prepayment" && invoice.items.some((item) => lines.find((line) => line.id === item.deliverableId && !isSchedule(line))))
      findings.push({ code: "v1_prepayment_draft_bills_scope", severity: "review", detail: "This prepayment draft bills part of the agreed total, not an advance. Invoice it as a sale by explicit choice; it is never converted automatically", invoiceIds: [invoice.id] })
    else if (invoice.purpose === "prepayment")
      findings.push({ code: "prepayment_draft_remains_blocked", severity: "info", detail: "Kept as a draft for the advance request; issuing it stays blocked until #24", invoiceIds: [invoice.id] })
  }
  if (scheduleSales.length) {
    const exposure = sumMinor(scheduleSales.map((sale) => sale.grossMinor))
    findings.push({
      code: "v2_schedule_invoiced_as_sale", severity: "review",
      detail: "A payment-schedule line was invoiced as a sale. The service lines still bill the full service total, and Quits has no deduction for the earlier sale",
      invoiceIds: [...new Set(scheduleSales.map((sale) => sale.invoiceId))], deliverableIds: scheduleSales.map((sale) => sale.deliverableId), amountMinor: exposure.toString(),
    })
    const issuedScope = sumMinor(documents.filter((doc) => doc.status === "issued").map((doc) => lines.find((line) => line.id === doc.targetId)!.lineGross).map(minor))
    const issuedSchedule = sumMinor(scheduleSales.filter((sale) => sale.issued).map((sale) => sale.grossMinor))
    const excess = issuedScope + issuedSchedule - billableGross(obligation)
    findings.push(excess > 0n
      ? { code: "double_counted", severity: "blocking", detail: "Issued sale invoices already bill more than the agreed service total; correct with a credit note after review", amountMinor: excess.toString() }
      : { code: "double_count_exposure", severity: "review", detail: "Invoicing the remaining service lines as they stand would bill more than the agreed total", amountMinor: exposure.toString() })
  }
  return result({
    obligation, plan: invalid.length ? null : plan,
    consent: { kind: "offer_acceptance", offerRevision: row.acceptedOfferRevision, acceptedOn: row.acceptedOn },
    facts: { documents, advanceReceipts: [], paidMinor: "0", reminders: [] },
  })
}

/** The subset of a `RecurringInvoice` row the migration reads. Dates are calendar dates. */
export type CurrentRecurring = {
  id: string
  status: "active" | "paused" | "ended"
  currency: string
  intervalCount: number
  intervalUnit: "week" | "month" | "year"
  startDate: string
  nextRunAt: string
  endsAt: string | null
  remainingRuns: number | null
  dueInDays: number
  autoSend: boolean
  taxRate: string
  items: unknown
  vatEvidence: unknown
}

/**
 * Today a run prices its items at run time with the organization's current prices-include-tax
 * setting. The instruction freezes the period amount that setting gives now, and says so.
 */
export function migrateRecurring(row: CurrentRecurring, settings: { pricesIncludeTax: boolean }): { instruction: RecurringInstruction | null; findings: MigrationFinding[] } {
  const findings: MigrationFinding[] = []
  if (row.status === "ended") return { instruction: null, findings: [{ code: "recurring_ended", severity: "info", detail: "Ended schedules generate nothing and need no instruction" }] }
  const exponent = getCurrencyExponent(row.currency)
  if (exponent === undefined || exponent > 2) return { instruction: null, findings: [{ code: "unsupported_currency", severity: "blocking", detail: `${row.currency} has no supported minor unit` }] }
  const items = recurringItemsSchema.safeParse(row.items)
  if (!items.success) return { instruction: null, findings: [{ code: "recurring_items_unreadable", severity: "blocking", detail: "The schedule's items cannot be priced" }] }
  const priced = priceDocumentV2({ items: items.data, taxRate: Number(row.taxRate), pricesIncludeTax: settings.pricesIncludeTax, currency: row.currency, vatEvidence: draftVatEvidenceSchema.parse(row.vatEvidence ?? {}) })
  findings.push({ code: "recurring_price_follows_settings", severity: "review", detail: "Runs are priced with the organization's current prices-include-tax setting. The instruction freezes today's amount; a later setting change becomes an explicit instruction amendment" })
  findings.push({ code: "generation_is_not_collection", severity: "info", detail: row.autoSend ? "The schedule creates and emails invoices; customers still pay each invoice themselves" : "The schedule creates drafts; nothing is sent or collected automatically" })
  return {
    findings,
    instruction: {
      recurringInvoiceId: row.id, version: 1, currency: row.currency, periodGrossMinor: minorFromAmount(priced.totalGross, row.currency),
      intervalUnit: row.intervalUnit, intervalCount: row.intervalCount, anchorDate: row.startDate, effectiveFrom: row.nextRunAt, dueInDays: row.dueInDays,
      end: row.endsAt ? { type: "on_date", endsAt: row.endsAt } : row.remainingRuns !== null ? { type: "after_runs", runs: row.remainingRuns } : { type: "none" },
      delivery: row.autoSend ? "auto_send" : "draft_only",
      collection: { kind: "manual" },
    },
  }
}
