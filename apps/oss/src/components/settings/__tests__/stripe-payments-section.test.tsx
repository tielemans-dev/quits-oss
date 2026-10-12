// @vitest-environment jsdom

import type { OrgStripeAccount, StripeAccountStatus } from "@quits/contracts/payments"
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"

vi.mock("../../../lib/i18n/react", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

import { StripePaymentsSection, stripeByokUpdate, stripeConnectActionHandlers } from "../stripe-payments-section"

const noop = () => {}

function connectAccount(status: StripeAccountStatus): OrgStripeAccount {
  return {
    mode: "connect",
    accountId: status === "none" ? null : "acct_test",
    status,
    statusAt: "2026-10-12T12:00:00.000Z",
  }
}

const byokAccount: OrgStripeAccount = {
  mode: "byok",
  accountId: null,
  status: "none",
  statusAt: null,
}

function renderSection(account?: OrgStripeAccount, stripeByokConfigured = false) {
  return render(
    <StripePaymentsSection
      account={account}
      stripeByokConfigured={stripeByokConfigured}
      stripePublishableKey={stripeByokConfigured ? "pk_test_123456789" : null}
      clearStripeSecretKey={false}
      clearStripeWebhookSecret={false}
      onClearStripeSecretKeyChange={noop}
      onClearStripeWebhookSecretChange={noop}
    />
  )
}

const keyInput = (name: string) => document.querySelector(`input[name="${name}"]`)

afterEach(() => {
  cleanup()
})

describe("StripePaymentsSection", () => {
  it("keeps the raw key form for self-hosted installs", () => {
    renderSection(byokAccount, true)

    expect(screen.getByTestId("stripe-byok-form")).toBeTruthy()
    expect(screen.queryByTestId("stripe-connect-card")).toBeNull()
    expect(screen.getByLabelText("settings.payments.stripePublishableKey.label")).toBeTruthy()
    expect(screen.getByLabelText("settings.payments.stripeSecretKey.label")).toBeTruthy()
    expect(screen.getByLabelText("settings.payments.stripeWebhookSecret.label")).toBeTruthy()
    expect(keyInput("stripePublishableKey")).toBeTruthy()
    expect(keyInput("stripeSecretKey")).toBeTruthy()
    expect(keyInput("stripeWebhookSecret")).toBeTruthy()
    expect(screen.getByRole("button", { name: "settings.payments.removeSecret" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "settings.payments.removeWebhook" })).toBeTruthy()
    expect(screen.queryByRole("button", { name: "settings.payments.connect.action.connect" })).toBeNull()
  })

  it("shows the key form when Connect status is absent", () => {
    renderSection(undefined, false)

    expect(screen.getByTestId("stripe-byok-form")).toBeTruthy()
    expect(keyInput("stripePublishableKey")).toBeTruthy()
    expect(screen.queryByTestId("stripe-connect-card")).toBeNull()
  })

  it.each(["none", "pending", "active", "restricted"] as const)(
    "hides raw key inputs when payments are managed (%s)",
    (status) => {
      renderSection(connectAccount(status))

      expect(screen.getByTestId("stripe-connect-card")).toBeTruthy()
      expect(screen.queryByTestId("stripe-byok-form")).toBeNull()
      expect(screen.queryByLabelText("settings.payments.stripePublishableKey.label")).toBeNull()
      expect(screen.queryByLabelText("settings.payments.stripeSecretKey.label")).toBeNull()
      expect(screen.queryByLabelText("settings.payments.stripeWebhookSecret.label")).toBeNull()
      expect(keyInput("stripePublishableKey")).toBeNull()
      expect(keyInput("stripeSecretKey")).toBeNull()
      expect(keyInput("stripeWebhookSecret")).toBeNull()
      expect(screen.queryByRole("button", { name: "settings.payments.removeSecret" })).toBeNull()
      expect(screen.queryByRole("button", { name: "settings.payments.removeWebhook" })).toBeNull()
      cleanup()
    }
  )
})

describe("stripeConnectActionHandlers", () => {
  it("passes nothing until a runtime handler is registered, then forwards each action", () => {
    const run = vi.fn()
    expect(stripeConnectActionHandlers(false, run)).toEqual({})
    expect(stripeConnectActionHandlers(undefined, run)).toEqual({})

    const handlers = stripeConnectActionHandlers(true, run)
    handlers.onConnect?.()
    handlers.onResume?.()
    handlers.onFixInStripe?.()
    handlers.onDisconnect?.()
    expect(run.mock.calls).toEqual([["connect"], ["resume"], ["fix"], ["disconnect"]])
  })
})

describe("stripeByokUpdate", () => {
  it("omits raw keys when the organization uses Connect", () => {
    expect(
      stripeByokUpdate({
        mode: "connect",
        stripePublishableKey: "pk_test_123456789",
        stripeSecretKey: "sk_test_123456789012",
        stripeWebhookSecret: "whsec_1234567890123456",
        clearStripeSecretKey: true,
        clearStripeWebhookSecret: true,
      })
    ).toEqual({})
  })

  it("keeps raw key updates for self-hosted installs", () => {
    expect(
      stripeByokUpdate({
        mode: "byok",
        stripePublishableKey: "pk_test_123456789",
        stripeSecretKey: "",
        stripeWebhookSecret: "",
        clearStripeSecretKey: false,
        clearStripeWebhookSecret: true,
      })
    ).toEqual({
      stripePublishableKey: "pk_test_123456789",
      stripeSecretKey: undefined,
      stripeWebhookSecret: undefined,
      clearStripeSecretKey: false,
      clearStripeWebhookSecret: true,
    })
  })
})
