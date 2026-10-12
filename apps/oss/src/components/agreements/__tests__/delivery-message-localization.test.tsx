// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import type { ComponentProps } from "react"
import { AgreementActions } from "../agreement-actions"
import { I18nProvider } from "../../../lib/i18n/react"
afterEach(cleanup)
// MOCK: archived synthetic delivery evidence; rendering must not mutate it.
const archived = { id: "saved", status: "cancelled", lastEmailAttemptOutcome: "sent", lastEmailAttemptCode: "sent", lastEmailAttemptMessage: "Agreement email sent." }
function show(locale: string, agreement = archived) {
  render(<I18nProvider locale={locale}><AgreementActions agreement={agreement as ComponentProps<typeof AgreementActions>["agreement"]} capabilities={{ depositsEnabled: true } as ComponentProps<typeof AgreementActions>["capabilities"]} onChanged={async () => {}} onError={() => {}} /></I18nProvider>)
}
describe("historical agreement email presentation", () => {
  it.each([["da-DK", "Aftalen er sendt via e-mail."], ["en-US", "Agreement email sent."]])("presents stored successful delivery in %s without rewriting evidence", (locale, expected) => {
    show(locale)
    expect(screen.getByText(expected)).toBeTruthy()
    expect(archived.lastEmailAttemptMessage).toBe("Agreement email sent.")
  })
  it("keeps provider failure details", () => {
    show("da-DK", { ...archived, lastEmailAttemptCode: "provider_rejected", lastEmailAttemptMessage: "Synthetic delivery refused" })
    expect(screen.getByText("Synthetic delivery refused")).toBeTruthy()
  })
})
