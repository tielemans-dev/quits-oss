// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { asMockedRoute } from "../../test-utils/mocked-route"

const api = vi.hoisted(() => ({ navigate: vi.fn(), initialize: vi.fn(), complete: vi.fn(), getStatus: vi.fn() }))
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => options,
  redirect: vi.fn(),
  useNavigate: () => api.navigate,
}))
vi.mock("../../trpc/client", () => ({
  trpc: { setup: {
    getStatus: { query: api.getStatus },
    initialize: { mutate: api.initialize },
    complete: { mutate: api.complete },
  } },
}))
import { Route } from "../setup"
const SetupPage = asMockedRoute(Route).component

beforeEach(() => {
  api.getStatus.mockResolvedValue({ stage: "new", isSetupComplete: false })
})

afterEach(() => {
  cleanup()
  localStorage.clear()
  vi.resetAllMocks()
})

async function openFinalStep() {
  render(<SetupPage />)
  await screen.findByText("Opsæt din Quits-instans")
  fireEvent.click(screen.getByRole("button", { name: "Næste" }))
  for (const [label, value] of [
    ["Organisationsnavn", "Test ApS"],
    ["Administratornavn", "Test Admin"],
    ["Administrator-e-mail", "admin@example.invalid"],
    ["Administratoradgangskode", "TestPassword123!"],
  ]) fireEvent.change(screen.getByLabelText(label!), { target: { value } })
  fireEvent.click(screen.getByRole("button", { name: "Næste" }))
  expect(screen.getByText("Godkendelsestilstand")).toBeTruthy()
  fireEvent.click(screen.getByRole("button", { name: "Næste" }))
}

describe("Danish first-run setup", () => {
  it("uses Danish copy and persists Danish org defaults even in an English browser", async () => {
    expect(navigator.language).toBe("en-US")
    await openFinalStep()
    expect((screen.getByLabelText(/^(Sprog|Locale)$/) as HTMLInputElement).value).toBe("da-DK")
    expect((screen.getByLabelText("Landekode") as HTMLInputElement).value).toBe("DK")
    expect((screen.getByLabelText("Tidszone") as HTMLInputElement).value).toBe("Europe/Copenhagen")
    expect((screen.getByLabelText("Valuta") as HTMLInputElement).value).toBe("DKK")
    fireEvent.click(screen.getByRole("button", { name: "Afslut opsætning" }))
    await waitFor(() => expect(api.complete).toHaveBeenCalledOnce())
    expect(api.initialize).toHaveBeenCalledWith(expect.objectContaining({
      organization: { name: "Test ApS", slug: "test-aps", cvr: undefined },
      locale: { locale: "da-DK", countryCode: "DK", timezone: "Europe/Copenhagen", currency: "DKK" },
    }))
    expect(api.navigate).toHaveBeenCalledWith({ to: "/login", search: { message: "Opsætningen er fuldført. Log ind for at fortsætte." } })
  })

  it("switches all wizard steps to the selected English catalog and back", async () => {
    await openFinalStep()
    fireEvent.change(screen.getByLabelText(/^(Sprog|Locale)$/), { target: { value: "en-US" } })
    expect(screen.getByText("Localization and email defaults")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Back" }))
    expect(screen.getByText("Authentication mode")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Back" }))
    expect(screen.getByText("Create admin and organization")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Back" }))
    expect(screen.getByText("Choose your instance profile")).toBeTruthy()
    for (let i = 0; i < 3; i++) fireEvent.click(screen.getByRole("button", { name: "Next" }))
    fireEvent.change(screen.getByLabelText(/^(Sprog|Locale)$/), { target: { value: "da-DK" } })
    expect(screen.getByText("Lokalisering og e-mailstandarder")).toBeTruthy()
  })

  it("loads setup status once while the locale is edited", async () => {
    await openFinalStep()
    const locale = screen.getByLabelText(/^(Sprog|Locale)$/)
    for (const value of ["e", "en", "en-US", "da-DK"]) fireEvent.change(locale, { target: { value } })
    await Promise.resolve()
    expect(api.getStatus).toHaveBeenCalledTimes(1)
  })

  it("preserves an existing draft's locale and regional choices", async () => {
    localStorage.setItem("quits.setup.wizard.v1", JSON.stringify({ locale: "en-US", countryCode: "GB", timezone: "Europe/London", currency: "GBP" }))
    render(<SetupPage />)
    await screen.findByText("Set up your Quits instance")
    expect(JSON.parse(localStorage.getItem("quits.setup.wizard.v1")!)).toMatchObject({ locale: "en-US", countryCode: "GB", timezone: "Europe/London", currency: "GBP" })
  })

  it.each(["da-DK", "en-US"])("keeps server English out of %s errors", async locale => {
    api.initialize.mockRejectedValue(new Error("Admin email is already in use"))
    await openFinalStep()
    fireEvent.change(screen.getByLabelText(/^(Sprog|Locale)$/), { target: { value: locale } })
    fireEvent.click(screen.getByRole("button", { name: locale === "da-DK" ? "Afslut opsætning" : "Finish setup" }))
    await screen.findByText(locale === "da-DK" ? "Noget gik galt under gemning af opsætningen." : "Something went wrong while saving setup.")
    expect(screen.queryByText("Admin email is already in use")).toBeNull()
    expect(api.complete).not.toHaveBeenCalled()
  })
})
