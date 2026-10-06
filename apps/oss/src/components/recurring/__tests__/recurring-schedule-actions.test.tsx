// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"

vi.mock("../../../trpc/client", () => ({ trpc: {} }))

vi.mock("../../../lib/i18n/react", () => ({
  useI18n: () => ({ locale: "en-US", t: (key: string) => key }),
}))

vi.mock("../recurring-schedule-dialog", () => ({
  RecurringScheduleDialog: () => null,
}))

import { RecurringScheduleActions } from "../recurring-schedule-actions"

const schedule = {
  id: "rec_1",
  status: "active" as const,
  nextRunAt: new Date("2099-01-01T00:00:00Z"),
  autoSend: false,
} as Parameters<typeof RecurringScheduleActions>[0]["schedule"]

afterEach(() => {
  cleanup()
})

describe("RecurringScheduleActions", () => {
  it("offers edit, pause, end, and run now to people who may update schedules", () => {
    render(
      <RecurringScheduleActions
        schedule={schedule}
        canUpdate
        variant="buttons"
        onChanged={() => undefined}
        onMessage={() => undefined}
      />
    )
    for (const label of ["recurring.action.edit", "recurring.action.pause", "recurring.action.end", "recurring.action.runNow"]) {
      expect(screen.getByRole("button", { name: label })).toBeTruthy()
    }
  })

  it("renders nothing for an accountant", () => {
    for (const variant of ["buttons", "menu"] as const) {
      const { container } = render(
        <RecurringScheduleActions
          schedule={schedule}
          canUpdate={false}
          variant={variant}
          onChanged={() => undefined}
          onMessage={() => undefined}
        />
      )
      expect(container.innerHTML).toBe("")
      cleanup()
    }
  })
})
