// @vitest-environment jsdom

import type { OrgStripeAccount, StripeAccountStatus } from "@quits/contracts/payments"
import { useState } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import * as connectSettings from "../../../lib/runtime/stripe-connect-settings"

const api = vi.hoisted(() => ({
  run: vi.fn(),
  get: vi.fn(),
}))

vi.mock("../../../trpc/client", () => ({
  trpc: {
    settings: {
      runStripeConnectAction: { mutate: api.run },
      get: { query: api.get },
    },
  },
}))

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

const actionFor = {
  none: "settings.payments.connect.action.connect",
  pending: "settings.payments.connect.action.resume",
  restricted: "settings.payments.connect.action.fix",
  active: "settings.payments.connect.action.disconnect",
} as const

function LiveSection({
  initial,
  connectActions,
}: {
  initial: OrgStripeAccount
  connectActions: boolean
}) {
  const [account, setAccount] = useState(initial)
  const [enabled, setEnabled] = useState(connectActions)
  return (
    <StripePaymentsSection
      account={account}
      connectActions={enabled}
      stripeByokConfigured={false}
      stripePublishableKey={null}
      clearStripeSecretKey={false}
      clearStripeWebhookSecret={false}
      onClearStripeSecretKeyChange={noop}
      onClearStripeWebhookSecretChange={noop}
      onConnectSettings={(next) => {
        setAccount(next.stripeAccount)
        setEnabled(next.stripeConnectActions)
      }}
    />
  )
}

afterEach(() => {
  cleanup()
  api.run.mockReset()
  api.get.mockReset()
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

  it("keeps Connect, Resume, Fix, and Disconnect unavailable without settings update", () => {
    for (const status of ["none", "pending", "active", "restricted"] as const) {
      const { unmount } = render(
        <StripePaymentsSection
          account={connectAccount(status)}
          connectActions={false}
          stripeByokConfigured={false}
          stripePublishableKey={null}
          clearStripeSecretKey={false}
          clearStripeWebhookSecret={false}
          onClearStripeSecretKeyChange={noop}
          onClearStripeWebhookSecretChange={noop}
        />
      )
      const control = screen.getByRole("button", { name: actionFor[status] }) as HTMLButtonElement
      expect(control.disabled).toBe(true)
      fireEvent.click(control)
      unmount()
    }
    expect(api.run).not.toHaveBeenCalled()
  })

  it("replaces the account after a disconnect that returns no URL", async () => {
    api.run.mockResolvedValue({ url: null })
    api.get.mockResolvedValue({
      stripeAccount: connectAccount("none"),
      stripeConnectActions: true,
    })
    render(<LiveSection initial={connectAccount("active")} connectActions />)

    expect(screen.getByText("settings.payments.connect.status.active")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: actionFor.active }))
    fireEvent.click(screen.getByRole("button", { name: "settings.payments.connect.disconnect.confirm" }))

    await waitFor(() => {
      expect(screen.getByText("settings.payments.connect.status.none")).toBeTruthy()
    })
    expect(screen.queryByText("settings.payments.connect.status.active")).toBeNull()
    expect(screen.queryByText("acct_test")).toBeNull()
    expect(api.run).toHaveBeenCalledWith({ action: "disconnect" })
    expect(api.get).toHaveBeenCalledOnce()
    expect((screen.getByRole("button", { name: actionFor.none }) as HTMLButtonElement).disabled).toBe(false)
  })

  it("leaves the account in place when the action opens a URL", async () => {
    const follow = vi.spyOn(connectSettings, "followStripeConnectUrl").mockImplementation(() => {})
    api.run.mockResolvedValue({ url: "https://connect.stripe.com/setup/s/test" })
    render(<LiveSection initial={connectAccount("pending")} connectActions />)

    fireEvent.click(screen.getByRole("button", { name: actionFor.pending }))

    await waitFor(() => {
      expect(follow).toHaveBeenCalledWith("https://connect.stripe.com/setup/s/test")
    })
    expect(api.get).not.toHaveBeenCalled()
    expect(screen.getByText("settings.payments.connect.status.pending")).toBeTruthy()
    follow.mockRestore()
  })
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
