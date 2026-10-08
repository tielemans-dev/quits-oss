// @vitest-environment jsdom

import { act } from "@testing-library/react"
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
