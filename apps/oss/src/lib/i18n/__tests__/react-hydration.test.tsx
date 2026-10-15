// @vitest-environment jsdom

import { act, fireEvent, render, cleanup } from "@testing-library/react"
import { hydrateRoot } from "react-dom/client"
import { renderToString } from "react-dom/server"
import { afterEach, describe, expect, it, vi } from "vitest"

// MOCK: session and settings I/O only; locale detection and providers use real code.
const sessionState = vi.hoisted(() => ({ getSession: vi.fn(), findUnique: vi.fn() }))
vi.mock("@tanstack/react-start", () => ({ createServerFn: () => ({ handler: (handler: unknown) => handler }) }))
vi.mock("@tanstack/react-start/server", () => ({ getRequestHeaders: () => new Headers() }))
vi.mock("../../auth", () => ({ auth: { api: { getSession: sessionState.getSession } } }))
vi.mock("../../db", () => ({ prisma: { orgSettings: { findUnique: sessionState.findUnique } } }))
vi.mock("../../runtime-distribution", () => ({ readRuntimeDistribution: () => ({ distribution: "selfhost" }) }))
vi.mock("../../cloud-onboarding-session", () => ({ loadCloudOnboardingState: vi.fn() }))

import { getAppLayoutSession } from "../../auth-session"
import { I18nProvider, useI18n } from "../react"

function Probe() {
  const { t } = useI18n()
  return <p>{t("nav.invoices")}</p>
}

function browserLanguage(language: string) {
  vi.spyOn(window.navigator, "language", "get").mockReturnValue(language)
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.resetAllMocks()
  cleanup()
  document.body.innerHTML = ""
})

describe("I18nProvider hydration", () => {
  it("hydrates a non-English browser against the server's HTML without a mismatch, then speaks its language", async () => {
    // The server has no browser language to read and renders in English.
    browserLanguage("en-US")
    const html = renderToString(
      <I18nProvider>
        <Probe />
      </I18nProvider>
    )
    expect(html).toContain("Invoices")

    // The browser that hydrates it prefers Danish.
    browserLanguage("da-DK")
    const container = document.createElement("div")
    container.innerHTML = html
    document.body.appendChild(container)
    const errors: unknown[] = []

    await act(async () => {
      hydrateRoot(
        container,
        <I18nProvider>
          <Probe />
        </I18nProvider>,
        { onRecoverableError: (error) => errors.push(error) }
      )
    })

    expect(errors).toEqual([])
    expect(container.textContent).toBe("Fakturaer")
    expect(document.documentElement.lang).toBe("da")
  })
})


describe("nested editable organization locale", () => {
  it("returns to browser language when the onboarding override is removed", () => {
    browserLanguage("en-GB")
    const shell = (locale?: string) => <I18nProvider initialLocale={locale}><Probe /></I18nProvider>
    const view = render(shell("da"))
    expect(view.container.textContent).toBe("Fakturaer")
    view.rerender(shell())
    expect(view.container.textContent).toBe("Invoices")
    expect(document.documentElement.lang).toBe("en")
  })
  it("uses the browser language before organization selection", () => {
    browserLanguage("da-DK")
    const view = render(<I18nProvider><I18nProvider initialLocale={undefined}><Probe /></I18nProvider></I18nProvider>)
    expect(view.container.textContent).toBe("Fakturaer")
    expect(document.documentElement.lang).toBe("da")
  })
  it("detects Danish for an active organization whose settings do not exist yet", async () => {
    browserLanguage("da-DK")
    sessionState.getSession.mockResolvedValue({ user: { id: "MOCK-user" }, session: { activeOrganizationId: "MOCK-org" } })
    sessionState.findUnique.mockResolvedValue(null)
    const session = await getAppLayoutSession()
    expect(session.activeOrganizationId).toBe("MOCK-org")
    const view = render(<I18nProvider><I18nProvider initialLocale={session.locale}><Probe /></I18nProvider></I18nProvider>)
    expect(view.container.textContent).toBe("Fakturaer")
    expect(document.documentElement.lang).toBe("da")
  })
  it.each([
    [undefined, "en-US", "Invoices", "en"],
    ["da-DK", "en-US", "Invoices", "en"],
    ["en-US", "da-DK", "Fakturaer", "da"],
  ])("applies a changed route locale from %s to %s without remounting", (before, after, text, language) => {
    browserLanguage("da-DK")
    const shell = (locale?: string) => <I18nProvider><I18nProvider initialLocale={locale}><Probe /></I18nProvider></I18nProvider>
    const view = render(shell(before))
    view.rerender(shell(after))
    expect(view.container.textContent).toBe(text)
    expect(document.documentElement.lang).toBe(language)
  })

  it("keeps browser fallback when settings remain absent on navigation", () => {
    browserLanguage("da-DK")
    const shell = () => <I18nProvider><I18nProvider initialLocale={undefined}><Probe /></I18nProvider></I18nProvider>
    const view = render(shell())
    view.rerender(shell())
    expect(view.container.textContent).toBe("Fakturaer")
    expect(document.documentElement.lang).toBe("da")
  })

  it("keeps Danish html language in an English browser and follows edits", () => {
    browserLanguage("en-US")
    function Editor() {
      const { setLocale, t } = useI18n()
      return <button onClick={() => setLocale("en-US")}>{t("nav.invoices")}</button>
    }
    const shell = () => <I18nProvider><I18nProvider initialLocale="da-DK"><Editor /></I18nProvider></I18nProvider>
    const view = render(shell())
    expect(view.getByRole("button").textContent).toBe("Fakturaer")
    expect(document.documentElement.lang).toBe("da")
    fireEvent.click(view.getByRole("button"))
    view.rerender(shell())
    expect(document.documentElement.lang).toBe("en")
    expect(view.getByRole("button").textContent).toBe("Invoices")
  })
})
