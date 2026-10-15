// @vitest-environment jsdom

import { cleanup, fireEvent, render, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { I18nProvider } from "../../../lib/i18n/react"
import type { TrackerJob } from "../../../lib/jobs/reminder-tracker"
import { TrackerToast } from "../reminder-tracker"

afterEach(cleanup)
const job = (id: string, statuses: string[], status = "running"): TrackerJob => ({
  id, status, createdAt: new Date(),
  steps: statuses.map((stepStatus, index) => ({
    id: `${id}-${index}`, label: "reminders.jobs.step", labelParams: { customerName: `Kunde ${index}` },
    invoiceId: `inv-${index}`, status: stepStatus,
  })),
})

function renderToasts(locale: string, ...jobs: TrackerJob[]) {
  const onRetry = vi.fn()
  const view = render(
    <I18nProvider locale={locale}>
      {jobs.map((item) => <TrackerToast key={item.id} job={item} onRetry={onRetry} onDismiss={() => {}} />)}
    </I18nProvider>
  )
  return { ...view, onRetry }
}

describe("TrackerToast", () => {
  it("names the job, its steps and the counter in Danish", () => {
    const { container } = renderToasts("da-DK", job("a", ["succeeded", "running", "pending"]))
    const toast = within(container.querySelector<HTMLElement>("[data-slot=reminder-tracker]")!)
    expect(toast.getByText("Sender rykkere")).toBeTruthy()
    expect(toast.getByText("Rykker til Kunde 0")).toBeTruthy()
    expect(toast.getByText("Sendt")).toBeTruthy()
    expect(toast.getByText("Sender …")).toBeTruthy()
    expect(toast.getByText("1/3 trin udført").className).toContain("tabular-nums")
    expect(toast.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("1")
  })

  it("speaks English when the organization does", () => {
    const { getByText } = renderToasts("en-US", job("a", ["succeeded"], "done"))
    expect(getByText("Reminders sent")).toBeTruthy()
    expect(getByText("1/1 steps done")).toBeTruthy()
  })

  it("shows a failed step as failed with a retry, and the job is not reported as sent", () => {
    const { container, onRetry } = renderToasts("da-DK", job("a", ["succeeded", "failed"], "failed"))
    const toast = within(container.firstElementChild as HTMLElement)
    expect(toast.getByText("Nogle rykkere fejlede")).toBeTruthy()
    expect(toast.getByText("Fejlede")).toBeTruthy()
    expect(toast.queryByText("Rykkere sendt")).toBeNull()
    fireEvent.click(toast.getByRole("button", { name: "Prøv igen" }))
    expect(onRetry).toHaveBeenCalledWith("a-1")
  })

  it("reads updates from its own job, so a hidden clone of another job cannot capture them", () => {
    const toasts = (container: HTMLElement) =>
      [...container.querySelectorAll<HTMLElement>("[data-slot=reminder-tracker]")] as [HTMLElement, HTMLElement]
    const tree = (...jobs: TrackerJob[]) => (
      <I18nProvider locale="da-DK">
        {jobs.map((item) => <TrackerToast key={item.id} job={item} onRetry={() => {}} onDismiss={() => {}} />)}
      </I18nProvider>
    )
    const { container, rerender } = render(tree(job("clone", ["running", "running"]), job("live", ["running", "running"])))
    toasts(container)[0].hidden = true
    rerender(tree(job("clone", ["running", "running"]), job("live", ["succeeded", "succeeded"], "done")))
    const [clone, live] = toasts(container)
    expect(within(live).getByText("2/2 trin udført")).toBeTruthy()
    expect(within(clone).getByText("0/2 trin udført")).toBeTruthy()
  })
})
