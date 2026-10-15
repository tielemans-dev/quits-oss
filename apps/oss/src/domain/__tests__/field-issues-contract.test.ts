import { describe, expect, it } from "vitest"
import { commandErrorSchema } from "@quits/contracts/agent"
import { InvalidState, serializeDomainError } from "../errors"
import { toToolError } from "../agent-tools/mcp"
import { invoiceFieldIssues } from "../../lib/invoice-field-issues"

const issue = { code: "customer.country.unsupported", field: "customer.country", params: { countries: "DK" } }

describe("structured refusals stay backward compatible", () => {
  it("accepts the original { path, message } issues and payloads without field issues", () => {
    expect(commandErrorSchema.parse({ tag: "ValidationFailed", message: "x", issues: [{ path: "amount", message: "bad" }] }).issues).toEqual([{ path: "amount", message: "bad" }])
    expect(commandErrorSchema.safeParse({ tag: "ValidationFailed", message: "x", issues: [issue] }).success).toBe(false)
  })

  it("serializes a structured refusal with both the legacy issues and the field issues", () => {
    const error = serializeDomainError(new InvalidState({ code: "invoice_issuance_policy", message: "Complete the invoice details before sending", fieldIssues: [issue] }))
    expect(error.issues).toEqual([{ path: "customer.country", message: "customer.country.unsupported" }])
    expect(error.fieldIssues).toEqual([issue])
    expect(commandErrorSchema.safeParse(error).success).toBe(true)
  })

  it("gives agents the same two shapes", () => {
    const error = toToolError(new InvalidState({ code: "missing_recipient", message: "no email", fieldIssues: [{ code: "missing_recipient", field: "customer.email", params: {} }] }))
    expect(error.issues).toEqual([{ path: "customer.email", message: "missing_recipient" }])
    expect(error.fieldIssues).toHaveLength(1)
  })

  it("reads field issues from a tRPC error and ignores legacy issues", () => {
    expect(invoiceFieldIssues({ data: { fieldIssues: [issue], issues: [{ path: "customer.country", message: "customer.country.unsupported" }] } })).toEqual([issue])
    expect(invoiceFieldIssues({ data: { issues: [{ path: "amount", message: "bad" }] } })).toEqual([])
  })
})
