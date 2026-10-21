// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { useState } from "react"
import { I18nProvider } from "../../../lib/i18n/react"
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
      <I18nProvider locale="en-US"><EmailDeliveryPanel
        title="Email delivery"
        description="Send or resend the customer email for this document."
        fallback={{
          title: "Customer email is missing",
          description: "Add a valid email address or share the public link manually.",
          copyLabel: "Copy link",
          onCopy: async () => undefined,
          fixAction: <a href="/contacts/contact-1">Fix contact</a>,
        }}
        publicLink={{
          title: "Public document link",
          description: "Share this hosted link with the customer.",
          url: "https://example.test/q/token",
          copyLabel: "Copy link",
        }}
      /></I18nProvider>
    )

    expect(screen.getByText("Customer email is missing")).toBeTruthy()
    expect(screen.getByText("Fix contact")).toBeTruthy()
    expect(screen.getAllByRole("button", { name: "Copy link" }).length).toBeGreaterThan(0)
    expect(screen.getByRole("textbox", { name: "Public document link" })).toBe(
      screen.getByDisplayValue("https://example.test/q/token")
    )
  })

  it.each([["da-DK", "Kopiér link", "Kopieret"], ["en-US", "Copy link", "Copied"]])("confirms in %s once the link is copied", async (locale, label, copied) => {
    let copy: (() => void) | undefined
    render(<I18nProvider locale={locale}><EmailDeliveryPanel title="Email" description="" publicLink={{
      title: "Link", description: "", url: "https://example.test/q/token", copyLabel: label,
      onCopy: () => new Promise<void>(resolve => { copy = resolve }),
    }} /></I18nProvider>)
    fireEvent.click(screen.getByRole("button", { name: label }))
    // Not before the clipboard has the link.
    expect(screen.queryByRole("button", { name: copied })).toBeNull()
    await act(async () => copy!())
    expect(screen.getByRole("button", { name: copied })).toBeTruthy()
  })

  it("keeps the label when the clipboard refuses the link", async () => {
    render(<I18nProvider locale="da-DK"><EmailDeliveryPanel title="Email" description="" publicLink={{
      title: "Link", description: "", url: "https://example.test/q/token", copyLabel: "Kopiér link",
      onCopy: () => Promise.reject(new Error("denied")),
    }} /></I18nProvider>)
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Kopiér link" })))
    expect(screen.getByRole("button", { name: "Kopiér link" })).toBeTruthy()
  })
})
