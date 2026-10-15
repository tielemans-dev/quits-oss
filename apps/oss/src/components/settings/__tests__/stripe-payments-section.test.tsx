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

function renderSection(account?: OrgStripeAccount, stripeByokConfigured = false, stripePaymentsEnabled = false) {
  return render(
    <StripePaymentsSection
      account={account}
      stripeByokConfigured={stripeByokConfigured}
      stripePaymentsEnabled={stripePaymentsEnabled}
      stripeCheckoutKind={stripePaymentsEnabled ? (stripeByokConfigured ? "byok" : "connect") : null}
      clearStripeSecretKey={false}
      clearStripeWebhookSecret={false}
      onClearStripeSecretKeyChange={noop}
      onClearStripeWebhookSecretChange={noop}
    ><div data-testid="byok-content" /></StripePaymentsSection>
  )
}

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
  const [paymentsEnabled, setPaymentsEnabled] = useState(true)
  const [checkoutKind, setCheckoutKind] = useState<"connect" | "byok" | null>("connect")
  return (
    <StripePaymentsSection
      account={account}
      connectActions={enabled}
      stripeByokConfigured={false}
      stripePaymentsEnabled={paymentsEnabled}
      stripeCheckoutKind={checkoutKind}
      clearStripeSecretKey={false}
      clearStripeWebhookSecret={false}
      onClearStripeSecretKeyChange={noop}
      onClearStripeWebhookSecretChange={noop}
      onConnectSettings={(next) => {
        setAccount(next.stripeAccount)
        setEnabled(next.stripeConnectActions)
        setPaymentsEnabled(next.stripePaymentsEnabled)
        setCheckoutKind(next.stripeCheckoutKind)
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
  it("passes checkout readiness to the Connect card independently of BYOK keys", () => {
    renderSection(connectAccount("active"), false, true)
    expect(screen.getByText("settings.payments.connect.payments.enabled")).toBeTruthy()
  })

  it.each([byokAccount, undefined])("preserves the route's BYOK form for %s", (account) => {
    renderSection(account, true)
    expect(screen.getByTestId("byok-content")).toBeTruthy()
    expect(screen.queryByTestId("stripe-connect-card")).toBeNull()
  })

  it.each(["none", "pending", "active", "restricted"] as const)(
    "explains legacy keys and the charged account in Connect mode (%s)",
    (status) => {
      renderSection(connectAccount(status), true, true)
      expect(screen.queryByTestId("byok-content")).toBeNull()
      expect(screen.getByText("settings.payments.connect.legacy.active")).toBeTruthy()
      expect(screen.getByText("settings.payments.connect.payments.byok")).toBeTruthy()
      expect(screen.queryByText("settings.payments.connect.payments.connect")).toBeNull()
      expect(screen.getByRole("button", { name: "settings.payments.connect.legacy.remove" })).toBeTruthy()
    }
  )

  it("queues removal for the Settings save and allows undo", () => {
    function RemovalSection() {
      const [secret, setSecret] = useState(false)
      const [webhook, setWebhook] = useState(false)
      return <>
        <StripePaymentsSection account={connectAccount("pending")} stripeByokConfigured
          clearStripeSecretKey={secret} clearStripeWebhookSecret={webhook}
          onClearStripeSecretKeyChange={setSecret} onClearStripeWebhookSecretChange={setWebhook} />
        <output>{JSON.stringify(stripeByokUpdate({ mode: "connect", stripePublishableKey: "", stripeSecretKey: "", stripeWebhookSecret: "", clearStripeSecretKey: secret, clearStripeWebhookSecret: webhook }))}</output>
      </>
    }
    render(<RemovalSection />)
    fireEvent.click(screen.getByRole("button", { name: "settings.payments.connect.legacy.remove" }))
    expect(screen.getByText("settings.payments.connect.legacy.removing")).toBeTruthy()
    expect(document.querySelector("output")?.textContent).toContain('"clearStripeSecretKey":true')
    expect(document.querySelector("output")?.textContent).toContain('"clearStripeWebhookSecret":true')
    fireEvent.click(screen.getByRole("button", { name: "settings.payments.undo" }))
    expect(screen.getByText("settings.payments.connect.legacy.active")).toBeTruthy()
    expect(document.querySelector("output")?.textContent).toContain('"clearStripeSecretKey":false')
    expect(document.querySelector("output")?.textContent).toContain('"clearStripeWebhookSecret":false')
  })

  it("keeps Connect, Resume, Fix, and Disconnect unavailable without settings update", () => {
    for (const status of ["none", "pending", "active", "restricted"] as const) {
      const { unmount } = render(
        <StripePaymentsSection
          account={connectAccount(status)}
          connectActions={false}
          stripeByokConfigured={false}
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
      stripePaymentsEnabled: false,
      stripeCheckoutKind: null,
    })
    render(<LiveSection initial={connectAccount("active")} connectActions />)

    expect(screen.getByText("settings.payments.connect.status.active")).toBeTruthy()
    expect(screen.getByText("settings.payments.connect.payments.enabled")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: actionFor.active }))
    fireEvent.click(screen.getByRole("button", { name: "settings.payments.connect.disconnect.confirm" }))

    await waitFor(() => {
      expect(screen.getByText("settings.payments.connect.status.none")).toBeTruthy()
    })
    expect(screen.queryByText("settings.payments.connect.status.active")).toBeNull()
    expect(screen.queryByText("acct_test")).toBeNull()
    expect(screen.getByText("settings.payments.connect.payments.unavailable")).toBeTruthy()
    expect(screen.queryByText("settings.payments.connect.payments.enabled")).toBeNull()
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
  it("omits raw keys but preserves removal when the organization uses Connect", () => {
    expect(
      stripeByokUpdate({
        mode: "connect",
        stripePublishableKey: "pk_test_123456789",
        stripeSecretKey: "sk_test_123456789012",
        stripeWebhookSecret: "whsec_1234567890123456",
        clearStripeSecretKey: true,
        clearStripeWebhookSecret: true,
      })
    ).toEqual({ clearStripeSecretKey: true, clearStripeWebhookSecret: true })
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
