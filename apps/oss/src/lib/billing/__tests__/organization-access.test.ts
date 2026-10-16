import { afterEach, describe, expect, it } from "vitest"
import { billingProvider } from "../index"
import { NoopBillingProvider } from "../noop-provider"
import type { OrganizationAccess } from "../types"
import { setRuntimeServices } from "../../runtime/services"

const trial: OrganizationAccess = { state: "trial", daysLeft: 14, trialStart: 1, trialEnd: 2, progress: 0 }
afterEach(() => setRuntimeServices({ billingProvider: new NoopBillingProvider() }))

describe("one organization access decision", () => {
  it.each(["self_hosted", "subscribed", "complimentary", "trial", "read_only"] as const)("uses %s for reads and writes despite contradictory payment fields", async state => {
    const organizationAccess: OrganizationAccess = state === "trial" ? trial : state === "read_only" ? { state, reason: "trial_ended" } : { state }
    setRuntimeServices({ billingProvider: {
      getSubscription: async () => ({ status: state === "read_only" ? "active" : "expired", priceId: null, organizationAccess }),
      assertInvoiceCreationAllowed: async () => { throw new Error("Legacy gate must not decide access") },
    } })
    expect((await billingProvider.getSubscription("org")).organizationAccess).toEqual(organizationAccess)
    const write = billingProvider.assertInvoiceCreationAllowed("org")
    if (state === "read_only") await expect(write).rejects.toMatchObject({ code: "FORBIDDEN" })
    else await expect(write).resolves.toBeUndefined()
  })

  it("rechecks transitions on every mutation without caching a grant", async () => {
    let organizationAccess: OrganizationAccess = trial
    setRuntimeServices({ billingProvider: {
      getSubscription: async () => ({ status: "active", priceId: null, organizationAccess }),
      assertInvoiceCreationAllowed: async () => {},
    } })
    // Trial expiry, payment, cancellation after paid-through, comp grant/revocation, recovery.
    for (const next of [trial, { state: "read_only", reason: "trial_ended" }, { state: "subscribed" }, { state: "read_only", reason: "canceled" },
      { state: "complimentary" }, { state: "read_only", reason: "payment_failed" }, { state: "subscribed" }, { state: "self_hosted" }] as OrganizationAccess[]) {
      organizationAccess = next
      if (next.state === "read_only") await expect(billingProvider.assertInvoiceCreationAllowed("org")).rejects.toMatchObject({ code: "FORBIDDEN" })
      else await expect(billingProvider.assertInvoiceCreationAllowed("org")).resolves.toBeUndefined()
    }
  })

  it("fails closed for an adapter missing the new decision", async () => {
    setRuntimeServices({ billingProvider: { getSubscription: async () => ({ status: "active", priceId: null }) } as never })
    await expect(billingProvider.assertInvoiceCreationAllowed("org")).rejects.toMatchObject({ code: "FORBIDDEN" })
  })
})
