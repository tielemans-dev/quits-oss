import { describe, expect, it } from "vitest"
import { updatePaymentDetails } from "../commands/payment-details"
import { getCommandDefinition } from "../registry"

describe("approval command registry", () => {
  it("never dispatches a change of the bank details printed on invoices", () => {
    expect(getCommandDefinition(updatePaymentDetails.type)).toBeUndefined()
  })
})
