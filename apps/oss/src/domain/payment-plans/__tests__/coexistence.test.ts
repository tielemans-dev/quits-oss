import { describe, expect, it } from "vitest"
import { conflicts, relate, type InstructionClaim } from "../coexistence"

const fixed: InstructionClaim = { kind: "billing_plan", id: "plan_website", obligationKey: "agreement:agr_website" }
const competing: InstructionClaim = { kind: "billing_plan", id: "plan_30_70", obligationKey: "agreement:agr_website" }
const otherFixed: InstructionClaim = { kind: "billing_plan", id: "plan_logo", obligationKey: "agreement:agr_logo" }
const stepInvoiceCollection: InstructionClaim = { kind: "collection_plan", id: "collect_inv_2", invoiceKey: "invoice:INV-2", invoiceBillsObligationKey: "agreement:agr_website" }
const secondCollection: InstructionClaim = { kind: "collection_plan", id: "collect_inv_2b", invoiceKey: "invoice:INV-2", invoiceBillsObligationKey: "agreement:agr_website" }
const support: InstructionClaim = { kind: "recurring", id: "rec_support", instructionKey: "recurring:rec_support", billsObligationKey: null }
const splitByRecurrence: InstructionClaim = { kind: "recurring", id: "rec_split", instructionKey: "recurring:rec_split", billsObligationKey: "agreement:agr_website" }
const supportAuthority: InstructionClaim = { kind: "authority", id: "auth_support", scopeKey: "recurring:rec_support" }
const secondAuthority: InstructionClaim = { kind: "authority", id: "auth_support_2", scopeKey: "recurring:rec_support" }
const planAuthority: InstructionClaim = { kind: "authority", id: "auth_website", scopeKey: "plan:plan_website" }

describe("which instructions may coexist", () => {
  it.each([
    [fixed, competing, "duplicate", "plan_already_authoritative"],
    [fixed, otherFixed, "independent", null],
    [fixed, stepInvoiceCollection, "layered", null],
    [stepInvoiceCollection, secondCollection, "duplicate", "plan_already_authoritative"],
    [fixed, support, "independent", null],
    [fixed, splitByRecurrence, "duplicate", "recurring_cannot_split_fixed_obligation"],
    [support, supportAuthority, "layered", null],
    [fixed, planAuthority, "layered", null],
    [fixed, supportAuthority, "independent", null],
    [supportAuthority, secondAuthority, "duplicate", "duplicate_instruction"],
  ] as const)("%o and %o are %s", (a, b, relation, code) => {
    expect(relate(a, b)).toMatchObject({ relation, refusal: code ? { code } : null })
    expect(relate(b, a)).toMatchObject({ relation, refusal: code ? { code } : null })
  })

  it("accepts a fixed project, its installment collection, a support schedule and their authorities together", () => {
    expect(conflicts([fixed, stepInvoiceCollection, support, supportAuthority, planAuthority, otherFixed])).toEqual([])
    expect(conflicts([fixed, competing, splitByRecurrence]).map((found) => found.refusal.code)).toEqual(["recurring_cannot_split_fixed_obligation", "plan_already_authoritative"])
  })
})
