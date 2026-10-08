// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { useState } from "react"
import { EmailDeliveryPanel } from "../email-delivery-panel"

afterEach(() => {
  cleanup()
})

describe("EmailDeliveryPanel", () => {
  it("renders send and resend action labels", () => {
    const { unmount } = render(
      <EmailDeliveryPanel
        title="Email delivery"
        description="Send or resend the customer email for this document."
        action={{
          label: "Send email",
          pendingLabel: "Sending...",
          pending: false,
          onClick: () => undefined,
        }}
      />
    )
    expect(screen.getByRole("button", { name: "Send email" })).toBeTruthy()

    unmount()

    render(
      <EmailDeliveryPanel
        title="Email delivery"
        description="Send or resend the customer email for this document."
        action={{
          label: "Resend email",
          pendingLabel: "Sending...",
          pending: false,
          onClick: () => undefined,
        }}
      />
    )

    expect(screen.getByRole("button", { name: "Resend email" })).toBeTruthy()
  })

  it("renders delivery status details", () => {
    render(
      <EmailDeliveryPanel
        title="Email delivery"
        description="Send or resend the customer email for this document."
        status={{
          outcome: "failed",
          label: "Failed",
          detail: "Last attempt: Failed on March 6, 2026",
          message: "Email delivery failed.",
        }}
      />
    )

    expect(screen.getByText("Failed")).toBeTruthy()
    expect(screen.getByText("Last attempt: Failed on March 6, 2026")).toBeTruthy()
    expect(screen.getByText("Email delivery failed.")).toBeTruthy()
  })

  it("renders degraded-path confirmation copy", () => {
    function Harness() {
      const [open, setOpen] = useState(false)

      return (
        <EmailDeliveryPanel
          title="Email delivery"
          description="Send or resend the customer email for this document."
          degradedAction={{
            open,
            triggerLabel: "Send without email",
            title: "Email delivery is unavailable",
            description:
              "This will mark the document as sent without delivering an email.",
            confirmLabel: "Continue without email",
            cancelLabel: "Cancel",
            pending: false,
            onConfirm: () => undefined,
            onOpenChange: setOpen,
          }}
        />
      )
    }

    render(
      <Harness />
    )

    fireEvent.click(screen.getByRole("button", { name: "Send without email" }))

    expect(screen.getByText("Email delivery is unavailable")).toBeTruthy()
    expect(
      screen.getByText("This will mark the document as sent without delivering an email.")
    ).toBeTruthy()
    expect(screen.getByRole("button", { name: "Continue without email" })).toBeTruthy()
  })

  it("renders invalid-recipient manual-share fallback", () => {
    render(
      <EmailDeliveryPanel
        title="Email delivery"
        description="Send or resend the customer email for this document."
        fallback={{
          title: "Customer email is missing",
          description: "Add a valid email address or share the public link manually.",
          copyLabel: "Copy link",
          onCopy: () => undefined,
          fixAction: <a href="/contacts/contact-1">Fix contact</a>,
        }}
        publicLink={{
          title: "Public document link",
          description: "Share this hosted link with the customer.",
          url: "https://example.test/q/token",
          copyLabel: "Copy link",
        }}
      />
    )

    expect(screen.getByText("Customer email is missing")).toBeTruthy()
    expect(screen.getByText("Fix contact")).toBeTruthy()
    expect(screen.getAllByRole("button", { name: "Copy link" }).length).toBeGreaterThan(0)
    expect(screen.getByDisplayValue("https://example.test/q/token")).toBeTruthy()
  })
})
