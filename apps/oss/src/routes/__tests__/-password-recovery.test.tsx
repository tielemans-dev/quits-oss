// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { I18nProvider } from "../../lib/i18n/react"

const { search, requestPasswordReset, resetPassword } = vi.hoisted(() => ({
  search: { value: { token: "valid-token" } as Record<string, string | undefined> },
  requestPasswordReset: vi.fn(), resetPassword: vi.fn(),
}))
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: Record<string, unknown>) => ({ ...options, useSearch: () => search.value }),
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => <a href={to}>{children}</a>,
}))
vi.mock("../../lib/auth-client", () => ({ authClient: { requestPasswordReset, resetPassword } }))

import { Route as ForgotRoute } from "../forgot-password"
import { Route as ResetRoute } from "../reset-password"
import { asMockedRoute } from "../../test-utils/mocked-route"

const ForgotPage = asMockedRoute(ForgotRoute).component
const ResetPage = asMockedRoute(ResetRoute).component
const fillPasswords = (password: string, confirmation = password) => {
  fireEvent.change(screen.getByLabelText("New password"), { target: { value: password } })
  fireEvent.change(screen.getByLabelText("Confirm password"), { target: { value: confirmation } })
  fireEvent.click(screen.getByRole("button", { name: "Save new password" }))
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  requestPasswordReset.mockReset()
  resetPassword.mockReset()
  search.value = { token: "valid-token" }
})

describe("password recovery screens", () => {
  it("requests a same-origin reset and shows a generic confirmation", async () => {
    requestPasswordReset.mockResolvedValue({ data: { status: true } })
    render(<I18nProvider><ForgotPage /></I18nProvider>)
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "user@example.com" } })
    fireEvent.click(screen.getByRole("button", { name: "Send reset link" }))
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("If an account exists"))
    expect(requestPasswordReset).toHaveBeenCalledWith({ email: "user@example.com", redirectTo: `${window.location.origin}/reset-password` })
    expect(screen.getByRole("link", { name: "Back to log in" }).getAttribute("href")).toBe("/login")
  })

  it("recovers from network failures and rate limits without disclosing account state", async () => {
    requestPasswordReset.mockRejectedValueOnce(new Error("offline"))
    requestPasswordReset.mockResolvedValueOnce({ error: { status: 429 } })
    render(<I18nProvider><ForgotPage /></I18nProvider>)
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "user@example.com" } })
    fireEvent.click(screen.getByRole("button", { name: "Send reset link" }))
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Please try again"))
    fireEvent.click(screen.getByRole("button", { name: "Send reset link" }))
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Wait a minute"))
  })

  it("checks password policy and confirmation before sending the token", async () => {
    render(<I18nProvider><ResetPage /></I18nProvider>)
    fillPasswords("short")
    expect(screen.getByRole("alert").textContent).toContain("between 8 and 128")
    fillPasswords("new-password", "different-password")
    expect(screen.getByRole("alert").textContent).toContain("do not match")
    expect(resetPassword).not.toHaveBeenCalled()
  })

  it("clears password fields and removes the token after successful reset", async () => {
    resetPassword.mockResolvedValue({ data: { status: true } })
    const replace = vi.spyOn(window.history, "replaceState").mockImplementation(() => {})
    render(<I18nProvider><ResetPage /></I18nProvider>)
    fillPasswords("new-password")
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("has been reset"))
    expect(resetPassword).toHaveBeenCalledWith({ token: "valid-token", newPassword: "new-password" })
    expect(replace).toHaveBeenCalledWith(window.history.state, "", "/reset-password")
    expect(screen.queryByLabelText("New password")).toBeNull()
  })

  it.each([{}, { error: "INVALID_TOKEN" }])("offers a new link when token search is invalid (%j)", (value) => {
    search.value = value
    render(<I18nProvider><ResetPage /></I18nProvider>)
    expect(screen.getByRole("alert").textContent).toContain("invalid or has expired")
    expect(screen.getByRole("link", { name: "Request a new reset link" }).getAttribute("href")).toBe("/forgot-password")
    expect(screen.queryByLabelText("New password")).toBeNull()
  })

  it("handles a token that expires after the page opened", async () => {
    resetPassword.mockResolvedValue({ error: { code: "INVALID_TOKEN" } })
    render(<I18nProvider><ResetPage /></I18nProvider>)
    fillPasswords("new-password")
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("invalid or has expired"))
    expect(screen.getByRole("link", { name: "Request a new reset link" })).toBeTruthy()
  })
})
