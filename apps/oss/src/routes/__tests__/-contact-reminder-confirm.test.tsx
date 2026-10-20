// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import type { ComponentType } from "react"
import { afterEach, expect, it, vi } from "vitest"
import { notifyMutation } from "../../lib/query-refresh"
import { I18nProvider } from "../../lib/i18n/react"
import { translate } from "../../lib/i18n/translate"

const api = vi.hoisted(() => ({ get: vi.fn(), resume: vi.fn(), search: {} as { edit?: boolean } }))
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: object) => ({ ...options, useParams: () => ({ contactId: "buyer" }), useSearch: () => api.search }),
  useNavigate: () => vi.fn(),
  Link: ({ children, to, search }: { children: React.ReactNode; to: string; search?: { edit?: boolean } }) => <a href={search?.edit ? `${to}?edit=true` : to}>{children}</a>,
}))
vi.mock("../../trpc/client", () => ({ trpc: { invoices: { sendReadiness: { query: async () => ({ businessBuyersOnly: false }) } }, contacts: { get: { query: api.get }, resumeReminders: { mutate: api.resume } } } }))
import { Route } from "../_app/contacts/$contactId"
const Page = (Route as unknown as { component: ComponentType }).component
afterEach(() => { cleanup(); vi.resetAllMocks(); api.search = {} })

it.each(["da-DK", "en-US"])("requires confirmation and permits cancellation before seller resume in %s", async locale => {
  const contact = { id: "buyer", name: "Buyer", email: "buyer@example.test", reminderUnsubscribedAt: new Date(), canResumeReminders: true }
  api.get.mockResolvedValue(contact)
  api.resume.mockImplementation(async () => { api.get.mockResolvedValue({ ...contact, reminderUnsubscribedAt: null }) })
  const t = (key: Parameters<typeof translate>[0]) => translate(key, locale)
  render(<I18nProvider locale={locale}><Page /></I18nProvider>)
  const resume = await screen.findByRole("button", { name: t("contacts.reminders.resume") })
  fireEvent.click(resume)
  const dialog = await screen.findByRole("alertdialog")
  expect(within(dialog).getByText(translate("contacts.reminders.confirm", locale, { email: contact.email }))).toBeTruthy()
  expect(api.resume).not.toHaveBeenCalled()
  fireEvent.click(within(dialog).getByRole("button", { name: t("contacts.action.cancel") }))
  expect(screen.queryByRole("alertdialog")).toBeNull()
  expect(api.resume).not.toHaveBeenCalled()
  fireEvent.click(resume)
  fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: t("contacts.reminders.resume") }))
  await waitFor(() => expect(api.resume).toHaveBeenCalledExactlyOnceWith({ id: "buyer" }))
  await waitFor(() => expect(screen.getByRole("status").textContent).toBe(t("contacts.reminders.active")))
})

it("preserves customer edits through a failed background refresh and retry", async () => {
  api.search = { edit: true }
  api.get.mockResolvedValue({ id: "buyer", name: "Buyer", email: null })
  render(<I18nProvider locale="en-US"><Page /></I18nProvider>)
  const name = await screen.findByDisplayValue("Buyer")
  fireEvent.change(name, { target: { value: "Unsaved buyer" } })
  api.get.mockRejectedValueOnce(new Error("Customer refresh unavailable"))
  await act(async () => notifyMutation("contacts.update", null))
  await screen.findByText("Customer refresh unavailable")
  expect(name.isConnected).toBe(true)
  fireEvent.click(screen.getByRole("button", { name: "Try again" }))
  await waitFor(() => expect(screen.queryByText("Customer refresh unavailable")).toBeNull())
  expect(screen.getByDisplayValue("Unsaved buyer")).toBe(name)
})

it.each([
  ["da-DK", "Rediger"],
  ["en-US", "Edit"],
])("opens a customer on a read-only summary with an edit link in %s", async (locale, edit) => {
  api.get.mockResolvedValue({
    id: "buyer", name: "Mads Holm", email: "mads@example.test", company: "Holm & Co ApS", address: "Vestergade 5", zip: "8000", city: "Aarhus C",
    country: "DK", taxId: "12345678", phone: null, reminderUnsubscribedAt: null, canResumeReminders: false,
  })
  render(<I18nProvider locale={locale}><Page /></I18nProvider>)
  expect(await screen.findByRole("heading", { name: "Mads Holm" })).toBeTruthy()
  expect(screen.getByRole("link", { name: edit }).getAttribute("href")).toBe("/contacts/$contactId?edit=true")
  // Under the name, as the person works there, and in the facts.
  expect(screen.getAllByText("Holm & Co ApS")).toHaveLength(2)
  expect(screen.getByText("8000 Aarhus C")).toBeTruthy()
  expect(screen.getByText("12345678")).toBeTruthy()
  expect(screen.queryByRole("textbox")).toBeNull()
})

it("opens the form directly with ?edit=true", async () => {
  api.search = { edit: true }
  api.get.mockResolvedValue({ id: "buyer", name: "Mads Holm", email: null })
  render(<I18nProvider locale="en-US"><Page /></I18nProvider>)
  expect(await screen.findByDisplayValue("Mads Holm")).toBeTruthy()
  expect(screen.queryByRole("link", { name: "Edit" })).toBeNull()
})
