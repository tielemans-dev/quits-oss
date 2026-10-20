// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { CvrCompany } from "@quits/contracts/cvr"
import { I18nProvider } from "../../lib/i18n/react"
import { DURATION } from "../../lib/motion"
import { OnboardingV2 } from "../onboarding-v2/onboarding-v2"
import { addressLines, settleMs } from "../onboarding-v2/lookup-preview"
import type { OnboardingV2Client } from "../onboarding-v2/client"

vi.mock("../../trpc/client", () => ({ trpc: {} }))

const company: CvrCompany = {
  cvr: "24256790", name: "Synthetic Studio ApS", address: "Vestergade 1, 2100 København Ø", companyForm: "ApS",
  industry: "Software", status: "active", statusClass: "active", momsRegistered: true,
}
let answer: (value: CvrCompany | null) => void = () => {}
const client = (): OnboardingV2Client => ({
  search: async () => [company],
  get: () => new Promise((resolve) => { answer = resolve }),
  confirm: async () => ({ status: "complete" }),
})
const reduced = (matches: boolean) =>
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: matches && query.includes("reduce"), media: query }))
const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms))

async function startLookup(locale: "en-US" | "da-DK" = "en-US") {
  render(<I18nProvider locale={locale}><OnboardingV2 userId="u" organizationId="o" signupEmail="s@example.test" client={client()} onComplete={() => {}} /></I18nProvider>)
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "Synthetic" } })
  await advance(300)
  fireEvent.click(screen.getByRole("button", { name: /Synthetic Studio ApS/ }))
}
const busy = () => document.querySelector(".ob-preview")?.getAttribute("aria-busy")

beforeEach(() => { vi.useFakeTimers(); reduced(false) })
afterEach(() => { cleanup(); sessionStorage.clear(); vi.useRealTimers(); vi.unstubAllGlobals() })

describe("lookup skeleton", () => {
  it("shows skeletons while pending, says so after 3 seconds, and never announces before the data", async () => {
    await startLookup()
    expect(busy()).toBe("true")
    expect(document.querySelectorAll("[data-slot='skeleton'][aria-hidden='true']").length).toBeGreaterThan(0)
    expect(screen.queryByText("Fetching company details…")).toBeNull()
    await advance(3000)
    expect(screen.getByText("Fetching company details…")).toBeTruthy()
    expect(screen.queryByText(/Company details loaded/)).toBeNull()
  })

  it("formats the empty invoice for Danish", async () => {
    await startLookup("da-DK")
    expect(screen.getAllByText("0,00 kr.")).toHaveLength(3)
    expect(screen.getByText("Moms 25 %")).toBeTruthy()
  })

  it("holds a fast answer until 300ms, fills the card and invoice, then opens the review form", async () => {
    await startLookup()
    await advance(50)
    answer(company)
    await advance(100)
    expect(busy()).toBe("true")
    expect(document.querySelector("[data-filled]")).toBeNull()
    await advance(200)
    expect(busy()).toBe("false")
    // Card and the invoice's seller block both carry the company.
    expect(screen.getAllByText("Synthetic Studio ApS").length).toBeGreaterThanOrEqual(2)
    expect(screen.getAllByText("2100 København Ø").length).toBe(2)
    expect(screen.getByText("Company details loaded. Review and edit as needed.")).toBeTruthy()
    await advance(settleMs())
    expect(screen.getByRole("heading", { name: "Check your settings" })).toBeTruthy()
  })

  it("lets the user enter details manually while loading and ignores the late answer", async () => {
    await startLookup()
    fireEvent.click(screen.getByRole("button", { name: "Set up manually" }))
    expect(screen.getByRole("heading", { name: "Set up your company yourself" })).toBeTruthy()
    answer(company)
    await advance(settleMs() + 1000)
    expect(screen.getByRole("heading", { name: "Set up your company yourself" })).toBeTruthy()
  })

  it("does not time out a lookup that already answered", async () => {
    await startLookup()
    await advance(9_900)
    answer(company)
    await advance(10_000)
    expect(screen.getByRole("heading", { name: "Check your settings" })).toBeTruthy()
  })
})

describe("reduced motion", () => {
  it("settles after one fade instead of the staggered fill", () => {
    reduced(true)
    expect(settleMs()).toBe(DURATION.fade + 300)
  })
})

describe("addressLines", () => {
  it("puts street first and postnr and by second", () => {
    expect(addressLines("Vestergade 1, 2100 København Ø")).toEqual(["Vestergade 1", "2100 København Ø"])
    expect(addressLines("Vestergade 1\n2100 København Ø")).toEqual(["Vestergade 1", "2100 København Ø"])
  })
})

describe("search as you type", () => {
  it("does not time out on behalf of a search the user typed past", async () => {
    // A request that ignores its abort signal must not end the next search after 10 seconds.
    const hung: OnboardingV2Client = { ...client(), search: () => new Promise(() => {}) }
    render(<I18nProvider locale="en-US"><OnboardingV2 userId="u" organizationId="o" signupEmail="s@example.test" client={hung} onComplete={() => {}} /></I18nProvider>)
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Synthetic" } })
    await advance(300)
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Sy" } })
    await advance(10_000)
    expect(screen.queryByText("The lookup is taking too long")).toBeNull()
    expect(screen.getByRole("textbox")).toBeTruthy()
  })
})
