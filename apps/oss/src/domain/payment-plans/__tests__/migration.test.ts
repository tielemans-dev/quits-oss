import { describe, expect, it } from "vitest"
import { adoptPlan, emptyPlanState } from "../authority"
import { planAmendmentImpact } from "../amendment"
import { migrateAgreement, migrateRecurring, type CurrentAgreement, type CurrentRecurring } from "../migration"
import { validatePlan } from "../validate"
import { dkk, hash, offerSnapshot } from "./fixtures"

/*
 * Fixtures shaped like today's rows: agreements with deposit lines (v1, part of the total) or a
 * payment schedule (v2, beside the service total), drafts from `invoice.create_from_deliverables`
 * and the explicit `invoice.schedule_as_sale` choice. Synthetic data, not a production migration.
 */

type Line = { title: string; net: string; isDeposit?: boolean; status?: string; billingStatus?: string }
function agreement(version: 1 | 2, lines: Line[], invoices: CurrentAgreement["invoices"] = [], overrides: Partial<CurrentAgreement> = {}): CurrentAgreement {
  const snapshot = offerSnapshot(version, lines)
  return {
    id: "agr_m", status: "accepted", currency: "DKK", offerFormatVersion: version === 2 ? 2 : null, offerRevision: 1, acceptedOfferRevision: 1,
    offerSnapshotHash: hash("agr_m"), offerSnapshot: snapshot, acceptedOn: "2026-10-01", billingTrigger: "on_acceptance", dueInDays: 14,
    deliverables: lines.map((line, sortOrder) => ({
      id: line.title.toLowerCase(), title: line.title, isDeposit: line.isDeposit ?? false, status: line.status ?? "planned",
      billingStatus: line.billingStatus ?? "unbilled", lineGross: snapshot.deliverables[sortOrder]!.lineGross, sortOrder,
    })),
    invoices, ...overrides,
  }
}
const item = (deliverableId: string, gross: string) => ({ deliverableId, lineGross: gross })
const codes = (result: ReturnType<typeof migrateAgreement>) => result.findings.map((finding) => `${finding.severity}:${finding.code}`)

describe("migrating agreement schedules", () => {
  it("v1: a deposit inside the agreed total becomes a billing step due on acceptance; its prepayment draft needs review", () => {
    const result = migrateAgreement(agreement(1, [{ title: "Deposit", net: "3000", isDeposit: true, billingStatus: "reserved" }, { title: "Website", net: "7000" }], [
      { id: "inv_prepay", purpose: "prepayment", status: "draft", scheduleSaleChoice: null, items: [item("deposit", "3750.00")] },
    ]))
    expect(codes(result)).toEqual(["info:v1_deposit_in_total", "review:v1_prepayment_draft_bills_scope"])
    expect(result.obligation).toMatchObject({ grossMinor: dkk("12500"), vatGroups: [] })
    expect(result.plan?.arrangement).toEqual({ kind: "billing_steps", steps: [
      { stepId: "deposit", label: "Deposit", grossMinor: dkk("3750"), source: { kind: "deliverable", deliverableId: "deposit" }, trigger: { kind: "on_acceptance" }, dueInDays: 14 },
      { stepId: "website", label: "Website", grossMinor: dkk("8750"), source: { kind: "deliverable", deliverableId: "website" }, trigger: { kind: "on_deliverables", event: "accepted", deliverableIds: ["website"] }, dueInDays: 14 },
    ] })
    expect(result.facts?.documents).toEqual([{ targetId: "deposit", invoiceId: "inv_prepay", status: "draft" }])
    expect(validatePlan(result.obligation!, result.plan!)).toEqual([])
  })

  it("v2: the payment schedule becomes a gated advance beside the service total, and its prepayment draft stays blocked", () => {
    const row = agreement(2, [{ title: "Design", net: "10000" }, { title: "Build", net: "20000" }, { title: "Deposit", net: "9000", isDeposit: true, billingStatus: "reserved" }], [
      { id: "inv_design", purpose: "sale", status: "draft", scheduleSaleChoice: null, items: [item("design", "12500.00")] },
      { id: "inv_prepay", purpose: "prepayment", status: "draft", scheduleSaleChoice: null, items: [item("deposit", "11250.00")] },
    ], { billingTrigger: "on_delivery" })
    const result = migrateAgreement(row)
    expect(codes(result)).toEqual(["info:v2_schedule_is_advance", "info:prepayment_draft_remains_blocked"])
    expect(result.obligation).toMatchObject({ grossMinor: dkk("37500") })
    expect(result.obligation!.vatGroups).toHaveLength(1)
    expect(result.plan?.arrangement).toMatchObject({
      kind: "advance_then_billing", application: "next_sale_invoice",
      advances: [{ advanceId: "deposit", grossMinor: dkk("11250"), trigger: { kind: "on_acceptance" } }],
      steps: [{ stepId: "design", grossMinor: dkk("12500"), trigger: { event: "delivered" } }, { stepId: "build", grossMinor: dkk("25000") }],
    })
    expect(result.facts?.documents).toEqual([{ targetId: "design", invoiceId: "inv_design", status: "draft" }, { targetId: "deposit", invoiceId: "inv_prepay", status: "draft" }])
    // The migrated version becomes authoritative on the original acceptance; nothing is re-asked.
    const adopted = adoptPlan(emptyPlanState(result.plan!.planId, result.obligation!), result.plan!, {
      obligation: result.obligation!, expectedVersion: null, expectedPaidMinor: "0", facts: result.facts!, consent: result.consent,
    })
    expect(adopted).toMatchObject({ ok: true, outcome: "authoritative" })
  })

  it("v2: an explicit schedule-as-sale choice is reported as double-count exposure, never fixed silently", () => {
    const lines = [{ title: "Design", net: "10000" }, { title: "Build", net: "20000" }, { title: "Deposit", net: "9000", isDeposit: true }]
    const scheduleSale = { id: "inv_deposit_sale", purpose: "sale" as const, status: "sent", scheduleSaleChoice: { deliverableIds: ["deposit"] }, items: [item("deposit", "11250.00")] }
    const design = { id: "inv_design", purpose: "sale" as const, status: "paid", scheduleSaleChoice: null, items: [item("design", "12500.00")] }
    const exposure = migrateAgreement(agreement(2, lines, [scheduleSale, design]))
    expect(codes(exposure)).toEqual(["info:v2_schedule_is_advance", "review:v2_schedule_invoiced_as_sale", "review:double_count_exposure"])
    expect(exposure.findings.find((finding) => finding.code === "double_count_exposure")?.amountMinor).toBe(dkk("11250"))
    // The sale of the schedule line is outside the plan; only the service invoice maps to a step.
    expect(exposure.facts?.documents).toEqual([{ targetId: "design", invoiceId: "inv_design", status: "issued" }])

    const build = { id: "inv_build", purpose: "sale" as const, status: "sent", scheduleSaleChoice: null, items: [item("build", "25000.00")] }
    const counted = migrateAgreement(agreement(2, lines, [scheduleSale, design, build]))
    expect(codes(counted)).toContain("blocking:double_counted")
    expect(counted.findings.find((finding) => finding.code === "double_counted")?.amountMinor).toBe(dkk("11250"))
  })

  it("keeps issued history: a migrated plan refuses edits to steps already invoiced", () => {
    const result = migrateAgreement(agreement(2, [{ title: "Design", net: "10000" }, { title: "Build", net: "20000" }], [
      { id: "inv_design", purpose: "sale", status: "sent", scheduleSaleChoice: null, items: [item("design", "12500.00")] },
    ]))
    const current = result.plan!
    if (current.arrangement.kind !== "billing_steps") throw new Error("Expected billing steps")
    const next = { ...current, version: 2, supersedes: 1, arrangement: { kind: "billing_steps" as const, steps: current.arrangement.steps.map((step) => ({ ...step, dueInDays: 30 })) } }
    expect(planAmendmentImpact(current, next, result.obligation!, result.facts!).refusals).toMatchObject([{ code: "issued_step_immutable" }])
  })

  it("excludes cancelled lines, and reports what cannot be migrated", () => {
    const cancelled = migrateAgreement(agreement(1, [{ title: "Design", net: "10000" }, { title: "Build", net: "20000", status: "cancelled" }]))
    expect(codes(cancelled)).toEqual(["info:cancelled_line_excluded"])
    expect(cancelled.plan?.arrangement).toMatchObject({ steps: [{ stepId: "design" }] })
    expect(validatePlan(cancelled.obligation!, cancelled.plan!)).toEqual([])

    expect(codes(migrateAgreement(agreement(2, [{ title: "Design", net: "10000" }], [], { status: "sent", acceptedOfferRevision: null, acceptedOn: null })))).toEqual(["info:not_accepted"])
    expect(codes(migrateAgreement(agreement(2, [{ title: "Design", net: "10000" }], [], { offerSnapshot: { title: "corrupt" } })))).toEqual(["blocking:offer_snapshot_unreadable"])
    expect(codes(migrateAgreement(agreement(2, [{ title: "Design", net: "10000" }], [], { currency: "KWD" })))).toEqual(["blocking:unsupported_currency"])
    const drifted = agreement(2, [{ title: "Design", net: "10000" }])
    drifted.deliverables[0]!.lineGross = "12499.00"
    expect(codes(migrateAgreement(drifted))).toEqual(["blocking:scope_does_not_match_offer"])
  })
})

describe("migrating recurring schedules", () => {
  const row: CurrentRecurring = {
    id: "rec_support", status: "active", currency: "DKK", intervalCount: 1, intervalUnit: "month", startDate: "2026-11-01", nextRunAt: "2026-12-01",
    endsAt: null, remainingRuns: 10, dueInDays: 14, autoSend: true, taxRate: "25", items: [{ description: "Support", quantity: "1", unitPrice: "1500" }], vatEvidence: null,
  }

  it("records a version-1 instruction with today's period amount and manual collection", () => {
    const result = migrateRecurring(row, { pricesIncludeTax: false })
    expect(result.instruction).toEqual({
      recurringInvoiceId: "rec_support", version: 1, currency: "DKK", periodGrossMinor: dkk("1875"), intervalUnit: "month", intervalCount: 1,
      anchorDate: "2026-11-01", effectiveFrom: "2026-12-01", dueInDays: 14, end: { type: "after_runs", runs: 10 }, delivery: "auto_send", collection: { kind: "manual" },
    })
    expect(result.findings.map((finding) => finding.code)).toEqual(["recurring_price_follows_settings", "generation_is_not_collection"])
    // The same row prices differently under the other organization setting, which is why the instruction freezes it.
    expect(migrateRecurring(row, { pricesIncludeTax: true }).instruction?.periodGrossMinor).toBe(dkk("1500"))
  })

  it("skips ended schedules and refuses unreadable ones", () => {
    expect(migrateRecurring({ ...row, status: "ended" }, { pricesIncludeTax: false })).toMatchObject({ instruction: null, findings: [{ code: "recurring_ended" }] })
    expect(migrateRecurring({ ...row, items: [] }, { pricesIncludeTax: false })).toMatchObject({ instruction: null, findings: [{ code: "recurring_items_unreadable", severity: "blocking" }] })
  })
})
