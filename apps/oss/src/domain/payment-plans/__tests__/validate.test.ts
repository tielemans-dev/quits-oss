import { describe, expect, it } from "vitest"
import { planVersionSchema, type BillingStep, type PlanVersion } from "../model"
import { billableGross, validatePlan } from "../validate"
import { accepted, agreementObligation, dkk, invoiceObligation, onAccepted, plan, shareStep } from "./fixtures"

const obligation = agreementObligation({ agreementId: "agr_v", acceptedOn: "2026-10-01", lines: [
  { id: "design", net: "8000" }, { id: "build", net: "12000" }, { id: "deposit", net: "3000", schedule: true },
] })
const codes = (version: PlanVersion, against = obligation) => validatePlan(against, version).map((refusal) => refusal.code)
const steps = (...items: BillingStep[]) => plan(obligation, { kind: "billing_steps", steps: items })
const deliverableStep = (id: string, gross: string) => ({ stepId: id, label: id, grossMinor: gross, source: { kind: "deliverable" as const, deliverableId: id }, trigger: onAccepted(id), dueInDays: 14 })

describe("plan validation", () => {
  it("accepts the default per-deliverable plan and an exact share split", () => {
    expect(codes(steps(deliverableStep("design", dkk("10000")), deliverableStep("build", dkk("15000"))))).toEqual([])
    expect(codes(steps(shareStep("a", dkk("12500"), accepted), shareStep("b", dkk("12500"), onAccepted("design", "build"))))).toEqual([])
  })

  it("refuses totals that bill the obligation more or less than once", () => {
    expect(codes(steps(shareStep("a", dkk("12500"), accepted), shareStep("b", dkk("12499.99"), accepted)))).toEqual(["total_mismatch"])
    expect(codes(steps(deliverableStep("design", dkk("10000"))))).toEqual(["total_mismatch"])
    // The v2 payment schedule is not scope: billing it as a step would bill 3,750.00 twice.
    expect(codes(steps(deliverableStep("design", dkk("10000")), deliverableStep("build", dkk("15000")), deliverableStep("deposit", dkk("3750"))))).toEqual(["deliverable_not_scope"])
    expect(codes(steps(deliverableStep("design", dkk("9999")), deliverableStep("build", dkk("15001"))))).toEqual(["total_mismatch"])
  })

  it("refuses duplicates, mixed sources and triggers that never fire", () => {
    expect(codes(steps(shareStep("a", dkk("12500"), accepted), shareStep("a", dkk("12500"), accepted)))).toEqual(["duplicate_step"])
    expect(codes(steps(deliverableStep("design", dkk("10000")), shareStep("rest", dkk("15000"), accepted)))).toEqual(["mixed_step_sources"])
    expect(codes(steps(shareStep("a", dkk("25000"), onAccepted("deposit"))))).toEqual(["trigger_not_fulfillable"])
    expect(codes(steps(shareStep("a", dkk("25000"), onAccepted("missing"))))).toEqual(["unknown_deliverable"])
    expect(codes(steps(shareStep("a", dkk("25000"), { kind: "on_date", date: "2026-09-30" })))).toEqual(["date_before_obligation"])
  })

  it("checks currency and the exact obligation version the plan references", () => {
    const whole = shareStep("a", dkk("25000"), accepted), valid = steps(whole)
    expect(codes({ ...valid, currency: "EUR" })).toEqual(["currency_mismatch"])
    expect(codes({ ...valid, obligation: { ...obligation.ref, offerRevision: 2 } } as PlanVersion)).toEqual(["stale_obligation_version"])
    expect(codes({ ...valid, obligation: { ...obligation.ref, agreementId: "agr_other" } } as PlanVersion)).toEqual(["obligation_mismatch"])
    expect(codes(valid, { ...obligation, currency: "KWD" })).toEqual(["currency_unsupported"])
    expect(planVersionSchema.safeParse({ ...valid, arrangement: { kind: "billing_steps", steps: [{ ...whole, grossMinor: "12.5" }] } }).success).toBe(false)
    expect(planVersionSchema.safeParse({ ...valid, arrangement: { kind: "billing_steps", steps: [{ ...whole, grossMinor: "0" }] } }).success).toBe(false)
    expect(planVersionSchema.safeParse(valid).success).toBe(true)
  })

  it("bills cancelled scope nowhere and needs frozen VAT groups for shares", () => {
    const cancelled = { ...obligation, deliverables: obligation.deliverables.map((line) => line.deliverableId === "build" ? { ...line, cancelled: true } : line) }
    expect(billableGross(cancelled)).toBe(1_000_000n)
    expect(codes(steps(deliverableStep("design", dkk("10000"))), cancelled)).toEqual([])
    expect(codes(steps(shareStep("a", dkk("10000"), accepted)), cancelled)).toEqual(["stale_obligation_version"])
    expect(codes(steps(shareStep("a", dkk("25000"), accepted)), { ...obligation, vatGroups: [] })).toEqual(["vat_groups_unavailable"])
  })

  it("bounds advances by the obligation and keeps their ids apart from steps", () => {
    const advance = (gross: string, id = "adv") => plan(obligation, { kind: "advance_then_billing", application: "next_sale_invoice",
      advances: [{ advanceId: id, label: "Advance", grossMinor: gross, trigger: accepted, dueInDays: 7 }], steps: [shareStep("all", dkk("25000"), onAccepted("design", "build"))] })
    expect(codes(advance(dkk("3750")))).toEqual([])
    expect(codes(advance(dkk("25000")))).toEqual([])
    expect(codes(advance(dkk("25000.01")))).toEqual(["advance_exceeds_obligation"])
    expect(codes(advance(dkk("3750"), "all"))).toEqual(["duplicate_step"])
  })

  it("validates a collection plan against the invoice it schedules", () => {
    const invoice = invoiceObligation({ invoiceId: "inv_v", issuedOn: "2026-10-01", dueDate: "2026-10-31", gross: "1000" })
    const collection = (...installments: Array<[string, string]>) => plan(invoice, { kind: "collection_installments",
      installments: installments.map(([gross, dueDate], index) => ({ installmentId: `i${index}`, grossMinor: dkk(gross), dueDate })) })
    expect(codes(collection(["400", "2026-10-31"], ["600", "2026-11-30"]), invoice)).toEqual([])
    expect(codes(collection(["400", "2026-11-30"], ["600", "2026-10-31"]), invoice)).toEqual(["dates_not_increasing"])
    expect(codes(collection(["400", "2026-09-30"], ["600", "2026-10-31"]), invoice)).toEqual(["date_before_obligation"])
    expect(codes(collection(["400", "2026-10-31"], ["500", "2026-11-30"]), invoice)).toEqual(["total_mismatch"])
    expect(codes(plan(invoice, { kind: "billing_steps", steps: [shareStep("a", dkk("1000"), accepted)] }), invoice)).toEqual(["arrangement_not_allowed"])
    expect(codes(plan(obligation, { kind: "collection_installments", installments: [{ installmentId: "x", grossMinor: dkk("25000"), dueDate: "2026-11-01" }] }))).toEqual(["arrangement_not_allowed"])
  })
})
