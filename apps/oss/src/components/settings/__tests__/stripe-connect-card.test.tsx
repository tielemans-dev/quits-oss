// @vitest-environment jsdom

import type { OrgStripeAccount, StripeAccountStatus } from "@quits/contracts/payments"
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"

vi.mock("../../../lib/i18n/react", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

import { StripeConnectCard } from "../stripe-connect-card"

function account(
  status: StripeAccountStatus,
  accountId: string | null = status === "none" ? null : "acct_test"
): Pick<OrgStripeAccount, "accountId" | "status"> {
  return { status, accountId }
}

const button = (name: string) => screen.queryByRole("button", { name })

afterEach(() => {
  cleanup()
})

describe("StripeConnectCard", () => {
  it("shows not connected with a connect action and no disconnect", () => {
    const onConnect = vi.fn()
    render(<StripeConnectCard account={account("none")} onConnect={onConnect} />)

    expect(screen.getByTestId("stripe-connect-card").getAttribute("data-stripe-connect-status")).toBe("none")
    expect(screen.getByText("settings.payments.connect.status.none")).toBeTruthy()
    expect(screen.getByText("settings.payments.connect.help.none")).toBeTruthy()
    expect(screen.queryByText("settings.payments.connect.account.label")).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "settings.payments.connect.action.connect" }))
    expect(onConnect).toHaveBeenCalledOnce()
    expect(button("settings.payments.connect.action.resume")).toBeNull()
    expect(button("settings.payments.connect.action.fix")).toBeNull()
    expect(button("settings.payments.connect.action.disconnect")).toBeNull()
  })

  it("shows incomplete onboarding with resume and disconnect", () => {
    const onResume = vi.fn()
    render(<StripeConnectCard account={account("pending")} onResume={onResume} />)

    expect(screen.getByText("settings.payments.connect.status.pending")).toBeTruthy()
    expect(screen.getByText("settings.payments.connect.help.pending")).toBeTruthy()
    expect(screen.getByText("acct_test")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "settings.payments.connect.action.resume" }))
    expect(onResume).toHaveBeenCalledOnce()
    expect(button("settings.payments.connect.action.connect")).toBeNull()
    expect(button("settings.payments.connect.action.fix")).toBeNull()
    expect(button("settings.payments.connect.action.disconnect")).toBeTruthy()
  })

  it("shows an active account with disconnect and no setup actions", () => {
    render(<StripeConnectCard account={account("active", "acct_live")} />)

    expect(screen.getByText("settings.payments.connect.status.active")).toBeTruthy()
    expect(screen.getByText("settings.payments.connect.help.active")).toBeTruthy()
    expect(screen.getByText("acct_live")).toBeTruthy()
    expect(button("settings.payments.connect.action.connect")).toBeNull()
    expect(button("settings.payments.connect.action.resume")).toBeNull()
    expect(button("settings.payments.connect.action.fix")).toBeNull()
    expect(button("settings.payments.connect.action.disconnect")).toBeTruthy()
  })

  it("shows a restricted account with fix in Stripe", () => {
    const onFixInStripe = vi.fn()
    render(<StripeConnectCard account={account("restricted")} onFixInStripe={onFixInStripe} />)

    expect(screen.getByText("settings.payments.connect.status.restricted")).toBeTruthy()
    expect(screen.getByText("settings.payments.connect.help.restricted")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "settings.payments.connect.action.fix" }))
    expect(onFixInStripe).toHaveBeenCalledOnce()
    expect(button("settings.payments.connect.action.connect")).toBeNull()
    expect(button("settings.payments.connect.action.resume")).toBeNull()
    expect(button("settings.payments.connect.action.disconnect")).toBeTruthy()
  })

  it("asks before disconnecting and leaves the account linked when cancelled", () => {
    const onDisconnect = vi.fn()
    render(<StripeConnectCard account={account("active")} onDisconnect={onDisconnect} />)

    fireEvent.click(screen.getByRole("button", { name: "settings.payments.connect.action.disconnect" }))
    expect(screen.getByText("settings.payments.connect.disconnect.description")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "settings.payments.connect.disconnect.cancel" }))
    expect(onDisconnect).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole("button", { name: "settings.payments.connect.action.disconnect" }))
    fireEvent.click(screen.getByRole("button", { name: "settings.payments.connect.disconnect.confirm" }))
    expect(onDisconnect).toHaveBeenCalledOnce()
  })
})
