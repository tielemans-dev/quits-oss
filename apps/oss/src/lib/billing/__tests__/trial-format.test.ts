import { describe, expect, it } from "vitest"
import { formatPlanPrice, trialDaysLeft } from "../trial-format"

describe("hosted plan display", () => {
  it("formats the Stripe minor-unit price in Danish and English without Stripe's currency style", () => {
    const plan = { name: "quits", unitAmount: 9900, currency: "dkk", interval: "month" as const, taxBehavior: "exclusive" as const }
    expect(formatPlanPrice(plan, "da-DK")).toBe("99 kr./md.")
    expect(formatPlanPrice(plan, "en-US")).toBe("99 DKK/month")
  })

  it("shows the pre-tax amount for an inclusive Danish VAT price", () => {
    const plan = { name: "quits", unitAmount: 12375, currency: "dkk", interval: "month" as const, taxBehavior: "inclusive" as const }
    expect(formatPlanPrice(plan, "da-DK")).toBe("99 kr./md.")
  })

  it("switches to the final-three-day banner at the calendar-day boundary", () => {
    const now = Date.UTC(2026, 9, 11)
    expect(trialDaysLeft((now + 4 * 86400_000) / 1000, now)).toBe(4)
    expect(trialDaysLeft((now + 3 * 86400_000) / 1000, now)).toBe(3)
    expect(trialDaysLeft(now / 1000, now)).toBe(0)
  })
})
