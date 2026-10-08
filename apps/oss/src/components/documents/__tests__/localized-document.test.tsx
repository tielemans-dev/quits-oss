// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { renderToString } from "react-dom/server"
import { I18nProvider, useI18n } from "../../../lib/i18n/react"
import { LocalizedDocument } from "../localized-document"
import { PublicSellerHeader } from "../public-seller-header"

function Probe() {
  const { t, locale } = useI18n()
  return (
    <p>
      {locale}: {t("public.invoice.pay.action")}
    </p>
  )
}

function browserLanguage(language: string) {
  vi.spyOn(window.navigator, "language", "get").mockReturnValue(language)
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  document.documentElement.lang = ""
})

describe("LocalizedDocument", () => {
  it("speaks the document's language whatever the visitor's browser prefers", () => {
    browserLanguage("en-GB")
    render(
      <I18nProvider>
        <LocalizedDocument locale="da-DK">
          <Probe />
        </LocalizedDocument>
      </I18nProvider>
    )

    expect(screen.getByText("da-DK: Betal nu")).toBeTruthy()

    cleanup()
    browserLanguage("da-DK")
    render(
      <I18nProvider>
        <LocalizedDocument locale="en-US">
          <Probe />
        </LocalizedDocument>
      </I18nProvider>
    )

    expect(screen.getByText("en-US: Pay now")).toBeTruthy()
  })

  it("renders the same markup for every visitor, so the page hydrates without a mismatch", () => {
    const markup = (language: string) => {
      browserLanguage(language)
      const html = renderToString(
        <I18nProvider>
          <LocalizedDocument locale="da-DK">
            <Probe />
          </LocalizedDocument>
        </I18nProvider>
      )
      vi.restoreAllMocks()
      return html
    }

    const english = markup("en-US")
    expect(english).toContain("Betal nu")
    expect(markup("da-DK")).toBe(english)
    expect(markup("fr-FR")).toBe(english)
  })

  it("marks the language of the content and leaves the page's own language alone", () => {
    document.documentElement.lang = "en"
    const { container } = render(
      <I18nProvider>
        <LocalizedDocument locale="da-DK">
          <Probe />
        </LocalizedDocument>
      </I18nProvider>
    )

    expect(container.querySelector("[lang]")?.getAttribute("lang")).toBe("da")
    expect(document.documentElement.lang).toBe("en")
  })

  it("marks an unsupported document language by the one its text is written in", () => {
    const { container } = render(
      <I18nProvider>
        <LocalizedDocument locale="nl-NL">
          <Probe />
        </LocalizedDocument>
      </I18nProvider>
    )

    expect(container.querySelector("[lang]")?.getAttribute("lang")).toBe("en")
    expect(screen.getByText("nl-NL: Pay now")).toBeTruthy()
  })
})

describe("PublicSellerHeader", () => {
  const logo = "data:image/png;base64,AAAA"

  function renderHeader(seller: { name: string | null; logo: string | null }) {
    return render(
      <I18nProvider>
        <PublicSellerHeader seller={seller} />
      </I18nProvider>
    )
  }

  it("shows the logo beside the company name", () => {
    const { container } = renderHeader({ name: "Acme Studio", logo })

    expect(container.querySelector("img")?.getAttribute("src")).toBe(logo)
    expect(screen.getByText("Acme Studio")).toBeTruthy()
  })

  it("keeps the company name when the logo cannot be loaded", () => {
    const { container } = renderHeader({ name: "Acme Studio", logo })

    fireEvent.error(container.querySelector("img")!)

    expect(container.querySelector("img")).toBeNull()
    expect(screen.getByText("Acme Studio")).toBeTruthy()
  })

  it("renders nothing for a seller with neither a name nor a logo", () => {
    const { container } = renderHeader({ name: null, logo: null })

    expect(container.innerHTML).toBe("")
  })

  it("renders nothing once a nameless seller's logo cannot be loaded", () => {
    const { container } = renderHeader({ name: null, logo })

    fireEvent.error(container.querySelector("img")!)

    expect(container.innerHTML).toBe("")
  })
})
