// @vitest-environment jsdom
// MOCK: settings and transport only; the dialog, controls and translations are real.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { I18nProvider } from "../../../lib/i18n/react"
import { translate } from "../../../lib/i18n/translate"
const api = vi.hoisted(() => ({ save: vi.fn() }))
vi.mock("../../../trpc/client", () => ({ trpc: {
  contacts: { list: { query: async () => [{ id: "buyer", name: "Synthetic buyer" }] } },
  recurring: { createV2: { mutate: api.save }, updateV2: { mutate: api.save } },
} }))
vi.mock("../../../hooks/use-org-currency", () => ({ useOrgCurrency: () => "DKK" }))
vi.mock("../../../hooks/use-org-pricing-settings", () => ({ useOrgPricingSettings: () => ({ pricesIncludeTax: false }) }))
import { RecurringScheduleDialog, type EditableSchedule } from "../recurring-schedule-dialog"
const schedule = { id: "synthetic", name: "Monthly work", contactId: "buyer", items: [{ description: "Work", quantity: "1", unitPrice: "100" }],
  taxRate: 25, currency: "DKK", notes: null, intervalCount: 1, intervalUnit: "month", startDate: "2026-10-15", dueInDays: 14,
  autoSend: false, endsAt: null, remainingRuns: null } as unknown as EditableSchedule
beforeEach(() => { api.save.mockReset() })
afterEach(cleanup)
describe.each(["da-DK", "en-US"])("recurring validation in %s", locale => {
  const t = (key: Parameters<typeof translate>[0], params?: Parameters<typeof translate>[2]) => translate(key, locale, params)
  async function open(edit = true) {
    render(<I18nProvider locale={locale}><RecurringScheduleDialog open schedule={edit ? schedule : undefined} onOpenChange={() => {}} onSaved={() => {}} /></I18nProvider>)
    await waitFor(() => expect(screen.queryByText(t("docForm.loadingContacts"))).toBeNull())
    return screen.getByRole("button", { name: t(edit ? "recurring.form.save" : "recurring.form.create") })
  }
  it.each([false, true])("shows an inline name error and clears it only when valid (edit=%s)", async edit => {
    const submit = await open(edit)
    const name = screen.getByLabelText(`${t("recurring.form.name")} *`)
    fireEvent.change(name, { target: { value: "" } })
    fireEvent.blur(name)
    expect(screen.getByText(t("validation.required"))).toBeTruthy()
    fireEvent.click(submit)
    expect(await screen.findByText(t("validation.required"))).toBeTruthy()
    expect(name.getAttribute("aria-invalid")).toBe("true")
    expect(name.getAttribute("aria-describedby")).toBe("recurring-name-error")
    fireEvent.change(name, { target: { value: "   " } })
    expect(screen.getByText(t("validation.required"))).toBeTruthy()
    fireEvent.change(name, { target: { value: "Fixed" } })
    expect(screen.queryByText(t("validation.required"))).toBeNull()
    expect(name.getAttribute("aria-invalid")).not.toBe("true")
    expect(api.save).not.toHaveBeenCalled()
  })
  it("summarizes every missing field and updates the count as they are fixed", async () => {
    const submit = await open(false)
    expect(screen.queryByRole("alert", { name: t("summary.title.other", { n: 3 }) })).toBeNull()
    fireEvent.click(submit)
    const summary = screen.getByRole("alert", { name: t("summary.title.other", { n: 3 }) })
    expect(document.activeElement).toBe(summary)
    fireEvent.click(screen.getByRole("link", { name: `${t("recurring.form.name")}: ${t("validation.required")}` }))
    const name = screen.getByLabelText(`${t("recurring.form.name")} *`)
    expect(document.activeElement).toBe(name)
    fireEvent.change(name, { target: { value: "Monthly work" } })
    expect(screen.getByRole("alert", { name: t("summary.title.other", { n: 2 }) })).toBe(summary)
    fireEvent.click(screen.getByRole("link", { name: `${t("docForm.column.description")} 1: ${t("validation.line.description.required")}` }))
    expect(document.activeElement).toBe(screen.getByLabelText(`${t("docForm.column.description")} 1`))
    expect(api.save).not.toHaveBeenCalled()
  })
  it.each(["Internal database failure", "{broken JSON}"])("uses a readable fallback for %s", async message => {
    api.save.mockRejectedValue(new Error(message))
    fireEvent.click(await open())
    expect(await screen.findByText(t(message.startsWith("{") ? "validation.unknown" : "validation.save.failed"))).toBeTruthy()
    expect(document.body.textContent).not.toContain(message)
  })
  it("never renders server JSON and allows a successful retry", async () => {
    api.save.mockRejectedValueOnce(new Error('[{"path":["name"],"code":"too_big","origin":"string","maximum":200}]')).mockResolvedValueOnce({})
    const submit = await open()
    fireEvent.click(submit)
    expect(await screen.findByText(t("validation.tooLong", { max: 200 }))).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/"path"|"code"|too_big/)
    const summary = screen.getByRole("alert", { name: t("summary.title.one") })
    expect(document.activeElement).toBe(summary)
    fireEvent.click(screen.getByRole("link", { name: `${t("recurring.form.name")}: ${t("validation.tooLong", { max: 200 })}` }))
    expect(document.activeElement).toBe(screen.getByLabelText(`${t("recurring.form.name")} *`))
    fireEvent.change(screen.getByLabelText(`${t("recurring.form.name")} *`), { target: { value: "Corrected" } })
    expect(screen.queryByText(t("validation.tooLong", { max: 200 }))).toBeNull()
    fireEvent.click(submit)
    await waitFor(() => expect(api.save).toHaveBeenCalledTimes(2))
  })
})
