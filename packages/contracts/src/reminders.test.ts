import { describe, expect, it } from "vitest"
import { DEFAULT_REMINDER_POLICY, parseReminderPolicy, reminderPolicySchema } from "./reminders"

describe("reminder policy contract", () => {
  it("sorts offsets into canonical order", () => {
    expect(reminderPolicySchema.parse({ enabled: true, offsetsDays: [14, -3, 7] })).toEqual({
      enabled: true,
      offsetsDays: [-3, 7, 14],
    })
  })

  it.each([
    [[7, 7]],
    [[-31]],
    [[91]],
    [[1.5]],
    [[1, 2, 3, 4, 5, 6]],
  ])("rejects invalid offsets %j", (offsetsDays) => {
    expect(reminderPolicySchema.safeParse({ enabled: true, offsetsDays }).success).toBe(false)
  })

  it("accepts an empty schedule and the boundaries", () => {
    expect(reminderPolicySchema.safeParse({ enabled: false, offsetsDays: [] }).success).toBe(true)
    expect(reminderPolicySchema.safeParse({ enabled: true, offsetsDays: [-30, 90] }).success).toBe(true)
  })

  it("falls back to the disabled default for missing or malformed stored policies", () => {
    expect(parseReminderPolicy(null)).toEqual(DEFAULT_REMINDER_POLICY)
    expect(parseReminderPolicy({ enabled: "yes" })).toEqual({ enabled: false, offsetsDays: [-3, 7, 14] })
    expect(parseReminderPolicy({ enabled: true, offsetsDays: [7] })).toEqual({ enabled: true, offsetsDays: [7] })
  })
})
