import { describe, expect, it } from "vitest"

import { stripeConnectRedirectUrl } from "../stripe-connect-settings"

describe("stripeConnectRedirectUrl", () => {
  it("keeps https addresses and drops anything else", () => {
    expect(stripeConnectRedirectUrl("https://connect.stripe.com/setup/s/test")).toBe(
      "https://connect.stripe.com/setup/s/test"
    )
    expect(stripeConnectRedirectUrl("http://connect.stripe.com/setup")).toBeNull()
    expect(stripeConnectRedirectUrl("https://user:pass@connect.stripe.com/setup")).toBeNull()
    expect(stripeConnectRedirectUrl("javascript:alert(1)")).toBeNull()
    expect(stripeConnectRedirectUrl(null)).toBeNull()
    expect(stripeConnectRedirectUrl("")).toBeNull()
  })
})