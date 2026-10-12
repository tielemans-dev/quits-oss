// @vitest-environment jsdom

import { act, fireEvent, render, cleanup } from "@testing-library/react"
import { hydrateRoot } from "react-dom/client"
import { renderToString } from "react-dom/server"
import { afterEach, describe, expect, it, vi } from "vitest"

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
  it("uses the browser language before organization selection", () => {
    browserLanguage("da-DK")
    const view = render(<I18nProvider><I18nProvider initialLocale={undefined}><Probe /></I18nProvider></I18nProvider>)
    expect(view.container.textContent).toBe("Fakturaer")
    expect(document.documentElement.lang).toBe("da")
  })
  it("keeps Danish html language in an English browser and follows edits", () => {
    browserLanguage("en-US")
    function Editor() {
      const { setLocale, t } = useI18n()
      return <button onClick={() => setLocale("en-US")}>{t("nav.invoices")}</button>
    }
    const view = render(<I18nProvider><I18nProvider initialLocale="da-DK"><Editor /></I18nProvider></I18nProvider>)
    expect(view.getByRole("button").textContent).toBe("Fakturaer")
    expect(document.documentElement.lang).toBe("da")
    fireEvent.click(view.getByRole("button"))
    expect(document.documentElement.lang).toBe("en")
    expect(view.getByRole("button").textContent).toBe("Invoices")
  })
})
