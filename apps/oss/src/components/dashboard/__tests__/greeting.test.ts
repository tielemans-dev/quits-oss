import { describe, expect, it } from "vitest"

import { firstName, greetingKey } from "../greeting"

describe("greeting", () => {
  it("follows the hour in the organization's time zone, not the browser's", () => {
    // 06:30 UTC is 08:30 in Copenhagen in summer and 23:30 the evening before in Los Angeles.
    expect(greetingKey("2026-07-01T06:30:00Z", "Europe/Copenhagen")).toBe("dashboard.greeting.morning")
    expect(greetingKey("2026-07-01T06:30:00Z", "America/Los_Angeles")).toBe("dashboard.greeting.evening")
    expect(greetingKey("2026-07-01T09:30:00Z", "Europe/Copenhagen")).toBe("dashboard.greeting.forenoon")
    expect(greetingKey("2026-07-01T12:00:00Z", "Europe/Copenhagen")).toBe("dashboard.greeting.afternoon")
    expect(greetingKey("2026-07-01T23:30:00Z", "Europe/Copenhagen")).toBe("dashboard.greeting.evening")
  })

  it("addresses the person by first name, and by none when there is no name", () => {
    expect(firstName("  Martin Tielemans ")).toBe("Martin")
    expect(firstName("")).toBeUndefined()
    expect(firstName(null)).toBeUndefined()
  })
})
