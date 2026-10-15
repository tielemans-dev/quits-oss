// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import type { ComponentType } from "react"
import { afterEach, expect, it, vi } from "vitest"
import { I18nProvider } from "../../lib/i18n/react"
import { translate } from "../../lib/i18n/translate"

const api = vi.hoisted(() => ({ get: vi.fn(), resume: vi.fn() }))
vi.mock("@tanstack/react-router", () => ({ createFileRoute: () => (options: object) => ({ ...options, useParams: () => ({ contactId: "buyer" }) }), useNavigate: () => vi.fn() }))
vi.mock("../../trpc/client", () => ({ trpc: { invoices: { sendReadiness: { query: async () => ({ businessBuyersOnly: false }) } }, contacts: { get: { query: api.get }, resumeReminders: { mutate: api.resume } } } }))
import { Route } from "../_app/contacts/$contactId"
const Page = (Route as unknown as { component: ComponentType }).component
afterEach(() => { cleanup(); vi.resetAllMocks() })

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
