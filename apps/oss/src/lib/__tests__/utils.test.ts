import { describe, expect, it } from "vitest"

import { cn } from "../utils"

describe("cn", () => {
  it("lets a later weight or tracking replace the heading tokens", () => {
    expect(cn("leading-none font-heading tracking-heading", "font-medium")).toBe(
      "leading-none tracking-heading font-medium"
    )
    expect(cn("tracking-heading", "tracking-tight")).toBe("tracking-tight")
    expect(cn("font-medium", "font-heading")).toBe("font-heading")
  })

  it("keeps ordinary utilities that do not conflict", () => {
    expect(cn("font-heading", "text-sm")).toBe("font-heading text-sm")
  })
})
