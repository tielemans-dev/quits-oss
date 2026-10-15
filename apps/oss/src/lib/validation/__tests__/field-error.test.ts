import { describe, expect, it } from "vitest"
import { visibleFieldError } from "../field-error"

describe("visibleFieldError", () => {
  const error = { field: "contact", message: "Choose a customer" } as const

  it("shows the message while its field is still invalid", () => {
    expect(visibleFieldError(error, new Set(["contact", "items"]))).toBe("Choose a customer")
  })

  it("hides the message once its field is valid, even if other fields are invalid", () => {
    expect(visibleFieldError(error, new Set(["items"]))).toBeNull()
  })

  it("returns null without an error", () => {
    expect(visibleFieldError(null, new Set(["contact"]))).toBeNull()
  })
})
