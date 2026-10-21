// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { I18nProvider } from "../../lib/i18n/react"
import { OnboardingV2 } from "../onboarding-v2/onboarding-v2"
import { createOnboardingV2Client, type OnboardingV2Client } from "../onboarding-v2/client"
import * as connectSettings from "../../lib/runtime/stripe-connect-settings"

const api = vi.hoisted(() => ({
  confirm: vi.fn(async (_input: unknown) => ({ status: "complete" as const })),
  get: vi.fn(),
  run: vi.fn(),
}))
vi.mock("../../trpc/client", () => ({ trpc: {
  onboarding: { confirmV2: { mutate: api.confirm } },
  settings: { get: { query: api.get }, runStripeConnectAction: { mutate: api.run } },
} }))
afterEach(() => { cleanup(); sessionStorage.clear(); vi.clearAllMocks() })

const steps = (name: string) => within(screen.getByRole("navigation", { name })).getAllByRole("listitem").map(item => item.textContent?.replace(/^\d/, ""))
const account = (status: string) => ({ stripeAccount: { mode: "connect", status }, stripeConnectActions: true })

async function createCompany(client: OnboardingV2Client, onComplete: () => void, locale: "en-US" | "da-DK" = "en-US") {
  render(<I18nProvider locale={locale}><OnboardingV2 userId="synthetic-user" organizationId="synthetic-org" signupEmail="signup@example.test" client={client} onComplete={onComplete} /></I18nProvider>)
  fireEvent.click(screen.getByRole("button", { name: locale === "en-US" ? "Set up manually instead" : "Opsæt manuelt i stedet" }))
  fireEvent.change(screen.getByLabelText(locale === "en-US" ? "Name" : "Navn"), { target: { value: "Synthetic Seller" } })
  fireEvent.change(screen.getByLabelText(locale === "en-US" ? "Address" : "Adresse"), { target: { value: "Testvej 1" } })
  fireEvent.click(screen.getByRole("button", { name: locale === "en-US" ? "Create company" : "Opret virksomhed" }))
}

describe("hosted payments step", () => {
  it("offers Connect after saving, follows the https URL, and can be skipped", async () => {
    api.get.mockResolvedValue(account("none"))
    api.run.mockResolvedValue({ url: "https://connect.stripe.test/setup" })
    const follow = vi.spyOn(connectSettings, "followStripeConnectUrl").mockImplementation(() => {})
    const done = vi.fn()
    await createCompany(createOnboardingV2Client(false, false, true), done)
    await screen.findByRole("heading", { name: "Get paid by card and MobilePay" })
    expect(done).not.toHaveBeenCalled()
    expect(steps("Step 3/3")).toEqual(["Company", "Review", "Payments"])
    fireEvent.click(screen.getByRole("button", { name: "Connect Stripe" }))
    await waitFor(() => expect(follow).toHaveBeenCalledWith("https://connect.stripe.test/setup"))
    expect(api.run).toHaveBeenCalledWith({ action: "connect" })
  })

  it("skips straight into the app without calling Stripe", async () => {
    api.get.mockResolvedValue(account("none"))
    const done = vi.fn()
    await createCompany(createOnboardingV2Client(false, false, true), done, "da-DK")
    await screen.findByRole("heading", { name: "Få betalt med kort og MobilePay" })
    fireEvent.click(screen.getByRole("button", { name: "Spring over for nu" }))
    expect(done).toHaveBeenCalledOnce()
    expect(api.run).not.toHaveBeenCalled()
  })

  it("keeps the step and offers a retry when Stripe cannot be opened", async () => {
    api.get.mockResolvedValue(account("none"))
    api.run.mockRejectedValue(new Error("boom"))
    const done = vi.fn()
    await createCompany(createOnboardingV2Client(false, false, true), done)
    fireEvent.click(await screen.findByRole("button", { name: "Connect Stripe" }))
    await screen.findByText("We couldn't open Stripe")
    expect((screen.getByRole("button", { name: "Connect Stripe" }) as HTMLButtonElement).disabled).toBe(false)
    expect(done).not.toHaveBeenCalled()
  })

  it.each([
    ["an organization that already connected", account("active")],
    ["a runtime without a Connect handler", { stripeAccount: { mode: "connect", status: "none" }, stripeConnectActions: false }],
    ["self-hosted keys", { stripeAccount: { mode: "byok", status: "none" }, stripeConnectActions: false }],
  ])("completes without the step for %s", async (_name, settings) => {
    api.get.mockResolvedValue(settings)
    const done = vi.fn()
    await createCompany(createOnboardingV2Client(false, false, true), done)
    await waitFor(() => expect(done).toHaveBeenCalledOnce())
    expect(screen.queryByRole("heading", { name: "Get paid by card and MobilePay" })).toBeNull()
  })

  it("completes when the capability check fails", async () => {
    api.get.mockRejectedValue(new Error("down"))
    const done = vi.fn()
    await createCompany(createOnboardingV2Client(false, false, true), done)
    await waitFor(() => expect(done).toHaveBeenCalledOnce())
  })

  it("shows only user steps and adds Payments only after the check says yes (QUI-241)", async () => {
    api.get.mockResolvedValue(account("active"))
    const done = vi.fn()
    render(<I18nProvider locale="en-US"><OnboardingV2 userId="synthetic-user" organizationId="synthetic-org" signupEmail="signup@example.test" client={createOnboardingV2Client(false, false, true)} onComplete={done} /></I18nProvider>)
    expect(steps("Step 1/2")).toEqual(["Company", "Review"])
    fireEvent.click(screen.getByRole("button", { name: "Set up manually instead" }))
    expect(steps("Step 2/2")).toEqual(["Company", "Review"])
    // The step count is only the navigation's name; the named steps are what users see.
    expect(screen.queryByText(/^Step \d/)).toBeNull()
    // Asking before the save would create settings for an organization that isn't set up yet.
    expect(api.get).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Synthetic Seller" } })
    fireEvent.change(screen.getByLabelText("Address"), { target: { value: "Testvej 1" } })
    fireEvent.change(screen.getByLabelText("Company type"), { target: { value: "ApS" } })
    fireEvent.click(screen.getByRole("button", { name: "Create company" }))
    await waitFor(() => expect(done).toHaveBeenCalledOnce())
    expect(screen.queryByRole("listitem", { name: "Payments" })).toBeNull()
    expect(screen.queryByText("Payments")).toBeNull()
  })

  it("never asks self-hosted onboarding about Stripe", async () => {
    const done = vi.fn()
    await createCompany(createOnboardingV2Client(false), done)
    await waitFor(() => expect(done).toHaveBeenCalledOnce())
    expect(api.get).not.toHaveBeenCalled()
  })
})
