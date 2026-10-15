// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({ locale: "en-US" }))

vi.mock("../../../lib/i18n/react", async () => {
  const { translate } = await import("../../../lib/i18n/translate")
  return {
    useI18n: () => ({
      locale: state.locale,
      t: (key: Parameters<typeof translate>[0]) => translate(key, state.locale),
    }),
  }
})

import { EmailSendFailureNotice } from "../email-send-failure-notice"

afterEach(() => {
  cleanup()
  state.locale = "en-US"
})

describe("EmailSendFailureNotice", () => {
  it.each([
    ["en-US", "Invoice not sent", "We couldn't send the email just now. Your invoice is saved, so you can try again in a moment.", "Try again"],
    ["da-DK", "Fakturaen blev ikke sendt", "Vi kunne ikke sende e-mailen lige nu. Fakturaen er gemt, så du kan prøve igen om lidt.", "Prøv igen"],
  ])("says what happened and what to do next in %s", (locale, title, body, retry) => {
    state.locale = locale
    const onRetry = vi.fn()
    render(<EmailSendFailureNotice onRetry={onRetry} />)

    expect(screen.getByRole("alert").textContent).toContain(title)
    expect(screen.getByText(body)).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: retry }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it("cannot be retried while another attempt runs", () => {
    render(<EmailSendFailureNotice onRetry={vi.fn()} disabled />)
    expect((screen.getByRole("button", { name: "Try again" }) as HTMLButtonElement).disabled).toBe(true)
  })
})
