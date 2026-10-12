// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { I18nProvider } from "../../lib/i18n/react"
import { OnboardingV2 } from "../onboarding-v2/onboarding-v2"
import { createOnboardingV2Client } from "../onboarding-v2/client"
import { confirmationPayload, newDraft } from "../onboarding-v2/draft"

const api = vi.hoisted(() => ({ prepare: vi.fn(async () => ({ token: "signed-final-identity" })), confirm: vi.fn(async (_input: unknown) => ({ status: "complete" as const })) }))
vi.mock("../../trpc/client", () => ({ trpc: {
  runtime: { prepareSellerVatConfirmation: { mutate: api.prepare } },
  onboarding: { confirmV2: { mutate: api.confirm } },
} }))
afterEach(() => { cleanup(); sessionStorage.clear(); vi.clearAllMocks() })

describe("production v2 seller confirmation", () => {
  it.each([true, false])("saves explicit registration %s and prepares the final edited identity", async registered => {
    const done = vi.fn()
    render(<I18nProvider locale="en-US"><OnboardingV2 userId="synthetic-user" organizationId="synthetic-org" signupEmail="signup@example.test" confirmationEnabled client={createOnboardingV2Client(false, true)} onComplete={done} /></I18nProvider>)
    fireEvent.click(screen.getByRole("button", { name: "Set up manually instead" }))
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Synthetic Seller" } })
    fireEvent.change(screen.getByLabelText("Address"), { target: { value: "Testvej 1" } })
    fireEvent.change(screen.getByLabelText("CVR number"), { target: { value: "24256790" } })
    const radios = screen.getAllByRole("radio") as HTMLInputElement[]
    expect(radios.every(radio => !radio.checked)).toBe(true)
    const save = screen.getByRole("button", { name: "Create company" }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    fireEvent.click(radios[0]!)
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Edited Seller" } })
    expect(radios.every(radio => !radio.checked)).toBe(true)
    expect(save.disabled).toBe(true)
    fireEvent.click(radios[registered ? 0 : 1]!)
    fireEvent.click(save)
    await waitFor(() => expect(done).toHaveBeenCalledOnce())
    expect(api.prepare).toHaveBeenCalledWith({ companyName: "Edited Seller", companyAddress: "Testvej 1", cvr: "24256790", countryCode: "DK" })
    expect(api.confirm).toHaveBeenCalledWith(expect.objectContaining({ companyName: "Edited Seller", momsRegistered: registered, sellerVatConfirmationToken: "signed-final-identity", settings: expect.objectContaining({ taxRate: registered ? 25 : 0 }) }))
  })
  it("keeps the disabled extension's existing transport without preparing evidence", async () => {
    const draft = newDraft(null, "signup@example.test", false)
    Object.assign(draft.values, { companyName: "Synthetic Seller", companyAddress: "Testvej 1", momsRegistered: false })
    await createOnboardingV2Client(false).confirm(confirmationPayload(draft))
    expect(api.prepare).not.toHaveBeenCalled()
    expect(api.confirm).toHaveBeenCalledWith(expect.objectContaining({ momsRegistered: false }))
    expect(api.confirm.mock.calls[0]?.[0]).not.toHaveProperty("sellerVatConfirmationToken")
  })
})
