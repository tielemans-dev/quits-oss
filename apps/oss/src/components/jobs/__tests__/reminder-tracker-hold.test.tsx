// @vitest-environment jsdom

import { act, cleanup, render } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

const store = vi.hoisted(() => ({ jobs: vi.fn() }))
vi.mock("../reminder-jobs-store", () => ({ useReminderJobs: store.jobs, retryReminderStep: vi.fn() }))

import { I18nProvider } from "../../../lib/i18n/react"
import { ReminderTracker } from "../reminder-tracker"
import { holdTracker } from "../tracker-hold"

afterEach(cleanup)

describe("ReminderTracker", () => {
  it("waits for a card that is flying to the corner, then shows the job it grew out of", () => {
    store.jobs.mockReturnValue([{ id: "a", status: "running", createdAt: new Date(), steps: [{ id: "s", label: "reminders.jobs.step", labelParams: { customerName: "Kunde" }, invoiceId: "i", status: "running" }] }])
    let release!: () => void
    act(() => { release = holdTracker() })
    const { container } = render(<I18nProvider locale="da-DK"><ReminderTracker /></I18nProvider>)

    expect(container.querySelector("[data-slot=reminder-tracker]")).toBeNull()
    act(() => release())
    expect(container.querySelector("[data-slot=reminder-tracker]")?.getAttribute("data-job-id")).toBe("a")
  })
})
