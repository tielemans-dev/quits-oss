import { afterEach, expect, it, vi } from "vitest"
import { newDraft } from "./draft"

afterEach(() => vi.useRealTimers())

it("uses the current Danish year for each fresh screen draft across midnight", () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date("2026-12-31T22:59:59.999Z"))
  expect(newDraft(null, "synthetic@example.test", false).values.invoicePrefix).toBe("2026")
  vi.setSystemTime(new Date("2026-12-31T23:00:00.000Z"))
  expect(newDraft(null, "synthetic@example.test", false).values.invoicePrefix).toBe("2027")
})
