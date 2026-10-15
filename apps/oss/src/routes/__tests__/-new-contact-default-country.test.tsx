// @vitest-environment jsdom
// MOCK: trpc client with a settings lookup the test controls; the new-contact form is real.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { ComponentType } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { I18nProvider } from "../../lib/i18n/react"

const trpcMock = vi.hoisted(() => ({
  settings: vi.fn<() => Promise<{ countryCode: string }>>(),
  create: vi.fn(async (_input: unknown) => ({})),
}))
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: Record<string, unknown>) => options,
  useNavigate: () => vi.fn(),
}))
vi.mock("../../trpc/client", () => ({ trpc: {
  settings: { get: { query: trpcMock.settings } },
  contacts: { create: { mutate: trpcMock.create } },
} }))
import { Route } from "../_app/contacts/new"

const Page = (Route as unknown as { component: ComponentType }).component
const submit = () => screen.getByRole("button", { name: "Create Customer" }) as HTMLButtonElement

beforeEach(() => vi.clearAllMocks())
afterEach(cleanup)
describe("new customer default country", () => {
  it("keeps submission closed until the organization's country answered, then submits it", async () => {
    let answer!: (value: { countryCode: string }) => void
    trpcMock.settings.mockReturnValue(new Promise(resolve => { answer = resolve }))
    render(<I18nProvider locale="en-US"><Page /></I18nProvider>)
    expect(submit().disabled).toBe(true)
    await act(async () => { answer({ countryCode: "XK" }) })
    await waitFor(() => expect(submit().disabled).toBe(false))
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: "Synthetic buyer" } })
    fireEvent.click(submit())
    await waitFor(() => expect(trpcMock.create).toHaveBeenCalledWith(expect.objectContaining({ country: "XK" })))
  })
  it("opens the form with no default country when the lookup fails", async () => {
    trpcMock.settings.mockRejectedValue(new Error("offline"))
    render(<I18nProvider locale="en-US"><Page /></I18nProvider>)
    await waitFor(() => expect(submit().disabled).toBe(false))
    expect((screen.getByLabelText("Country") as HTMLSelectElement).value).toBe("")
  })
})
