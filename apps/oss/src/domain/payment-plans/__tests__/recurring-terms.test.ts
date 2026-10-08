import { describe, expect, it } from "vitest"
import type { CollectionAuthority, RecurringInstruction } from "../model"
import { previewRuns, recurringAmendmentImpact } from "../recurring-instructions"

const current: RecurringInstruction = {
  recurringInvoiceId: "support", version: 1, currency: "DKK", periodGrossMinor: "10000",
  intervalUnit: "month", intervalCount: 1, anchorDate: "2026-10-01", effectiveFrom: "2026-10-01",
  dueInDays: 14, end: { type: "on_date", endsAt: "2026-12-01" }, delivery: "draft_only", collection: { kind: "manual" },
}
const amend = (before: RecurringInstruction, change: Partial<RecurringInstruction>, previewCount = 3) =>
  recurringAmendmentImpact(before, { ...before, version: before.version + 1, effectiveFrom: "2026-11-01", ...change }, { today: "2026-10-08", generatedRuns: [], previewCount })

describe("recurring term consent", () => {
  it.each([0, 1, 3])("requires consent for end extensions independently of preview length %i", (previewCount) => {
    const impact = amend(current, { end: { type: "on_date", endsAt: "2027-12-01" } }, previewCount)
    expect(impact.refusals).toEqual([])
    expect(impact.consent).toEqual({ required: true, reasons: ["Extends the agreed end date"] })
  })
  it("detects an extension beyond a full first year preview", () => {
    const before = { ...current, end: { type: "on_date" as const, endsAt: "2030-12-01" } }
    const impact = amend(before, { end: { type: "on_date", endsAt: "2031-12-01" } }, 12)
    expect(impact.futureRuns.every((run) => !run.changed)).toBe(true)
    expect(impact.consent.required).toBe(true)
  })
  it.each([{ type: "on_date", endsAt: "2026-12-01" }, { type: "after_runs", runs: 3 }] as const)("requires consent to remove finite end %j", (end) => {
    expect(amend({ ...current, end }, { end: { type: "none" } }).consent).toMatchObject({ required: true, reasons: ["Removes the agreed end condition"] })
  })
  it("compares count limits against remaining runs, including an unchanged count with a later effective date", () => {
    const before = { ...current, end: { type: "after_runs" as const, runs: 3 } }
    expect(previewRuns(before, "2026-11-01", 10).map((run) => run.runDate)).toEqual(["2026-11-01", "2026-12-01"])
    expect(amend(before, { end: { type: "after_runs", runs: 4 } }).consent.required).toBe(true)
    expect(amend(before, {}).consent).toEqual({ required: true, reasons: ["Adds runs beyond the remaining agreed count"] })
    expect(amend(before, { end: { type: "after_runs", runs: 2 } }).consent.required).toBe(false)
    expect(amend(before, { end: { type: "after_runs", runs: 1 } }).consent.required).toBe(false)
  })
  it.each([{ type: "on_date", endsAt: "2026-12-01" }, { type: "after_runs", runs: 3 }] as const)("requires consent to restart ended instruction %j", (end) => {
    expect(amend({ ...current, end }, { effectiveFrom: "2027-01-01", end: { type: "after_runs", runs: 1 } }, 0).consent)
      .toEqual({ required: true, reasons: ["Restarts an instruction with no remaining authorized runs"] })
  })
  it("requires consent to change between finite limit kinds", () => {
    expect(amend(current, { end: { type: "after_runs", runs: 2 } }).consent.required).toBe(true)
    expect(amend({ ...current, end: { type: "after_runs", runs: 3 } }, { end: { type: "on_date", endsAt: "2026-12-01" } }).consent.required).toBe(true)
  })
  it("permits unchanged or shortened dates, adding a finite end, and amendments generating no runs", () => {
    expect(amend(current, {}).consent.required).toBe(false)
    expect(amend(current, { end: { type: "on_date", endsAt: "2026-11-01" } }).consent.required).toBe(false)
    expect(amend({ ...current, end: { type: "none" } }, { end: { type: "on_date", endsAt: "2026-12-01" } }).consent.required).toBe(false)
    expect(amend(current, { effectiveFrom: "2027-01-01" }).consent.required).toBe(false)
  })
  it("preserves issued history and identifies governed drafts on extension", () => {
    const before = structuredClone(current)
    const impact = recurringAmendmentImpact(current, { ...current, version: 2, effectiveFrom: "2026-11-01", end: { type: "on_date", endsAt: "2027-12-01" } }, {
      today: "2026-10-08", generatedRuns: [{ runDate: "2026-10-01", invoiceId: "issued", status: "issued" }, { runDate: "2026-11-01", invoiceId: "draft", status: "draft" }],
    })
    expect(impact).toMatchObject({ refusals: [], unchangedRuns: ["issued"], draftsToRegenerate: [{ invoiceId: "draft", runDate: "2026-11-01" }], consent: { required: true } })
    expect(current).toEqual(before)
  })
  it("requires authority renewal for term extensions even with no visible preview", () => {
    const before = { ...current, collection: { kind: "saved_method" as const, authorityId: "authority" } }
    const authority: CollectionAuthority = {
      authorityId: "authority", version: 1, status: "active", scope: { kind: "recurring", recurringInvoiceId: "support", version: 1 },
      currency: "DKK", maxChargeMinor: "10000", minDaysBetweenCharges: 25, consentEvidenceRef: "evidence",
    }
    const impact = recurringAmendmentImpact(before, { ...before, version: 2, effectiveFrom: "2026-11-01", end: { type: "none" } }, { today: "2026-10-08", generatedRuns: [], previewCount: 0 }, authority)
    expect(impact.authority?.renewalRequired).toBe(true)
    expect(impact.consent.required).toBe(true)
  })
})
