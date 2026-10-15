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

import { StripePaymentsSection, stripeByokUpdate } from "../stripe-payments-section"

const noop = () => {}

function connectAccount(status: StripeAccountStatus): OrgStripeAccount {
  return {
    mode: "connect",
    accountId: status === "none" ? null : "acct_test",
    businessName: status === "none" ? null : "Acme ApS",
    status,
    statusAt: "2026-10-12T12:00:00.000Z",
  }
}

const byokAccount: OrgStripeAccount = {
  mode: "byok",
  accountId: null,
  businessName: null,
  status: "none",
  statusAt: null,
}

function renderSection(account?: OrgStripeAccount, stripeByokConfigured = false) {
  return render(
    <StripePaymentsSection
      account={account}
      stripeByokConfigured={stripeByokConfigured}
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
  onDone,
}: {
  initial: OrgStripeAccount
  connectActions: boolean
  onDone?: (action: string) => void
}) {
  const [account, setAccount] = useState(initial)
  const [enabled, setEnabled] = useState(connectActions)
  return (
    <StripePaymentsSection
      account={account}
      connectActions={enabled}
      stripeByokConfigured={false}
      clearStripeSecretKey={false}
      clearStripeWebhookSecret={false}
      onClearStripeSecretKeyChange={noop}
      onClearStripeWebhookSecretChange={noop}
      onConnectDone={onDone}
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
  it.each([byokAccount, undefined])("preserves the route's BYOK form for %s", (account) => {
    renderSection(account, true)
    expect(screen.getByTestId("byok-content")).toBeTruthy()
    expect(screen.queryByTestId("stripe-connect-card")).toBeNull()
  })

  it.each(["none", "pending", "active", "restricted"] as const)(
    "never offers BYOK checkout in Connect mode (%s)",
    (status) => {
      renderSection(connectAccount(status), true)
      expect(screen.queryByTestId("byok-content")).toBeNull()
      expect(screen.getByText("settings.payments.connect.legacy.active")).toBeTruthy()
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
    const done = vi.fn()
    render(<LiveSection initial={connectAccount("active")} connectActions onDone={done} />)

    expect(screen.getByText("settings.payments.connect.status.active")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: actionFor.active }))
    fireEvent.click(screen.getByRole("button", { name: "settings.payments.connect.disconnect.confirm" }))

    await waitFor(() => {
      expect(screen.getByText("settings.payments.connect.status.none")).toBeTruthy()
    })
    expect(screen.queryByText("settings.payments.connect.status.active")).toBeNull()
    expect(screen.queryByText("acct_test")).toBeNull()
    expect(api.run).toHaveBeenCalledWith({ action: "disconnect" })
    expect(done).toHaveBeenCalledWith("disconnect")
    expect(api.get).toHaveBeenCalledOnce()
    expect((screen.getByRole("button", { name: actionFor.none }) as HTMLButtonElement).disabled).toBe(false)
  })

  it("opens the Stripe dashboard from an active account", async () => {
    const follow = vi.spyOn(connectSettings, "followStripeConnectUrl").mockImplementation(() => {})
    api.run.mockResolvedValue({ url: "https://dashboard.stripe.com/" })
    render(<LiveSection initial={connectAccount("active")} connectActions />)

    fireEvent.click(screen.getByRole("button", { name: "settings.payments.connect.action.open" }))

    await waitFor(() => expect(follow).toHaveBeenCalledWith("https://dashboard.stripe.com/"))
    expect(api.run).toHaveBeenCalledWith({ action: "dashboard" })
    follow.mockRestore()
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
