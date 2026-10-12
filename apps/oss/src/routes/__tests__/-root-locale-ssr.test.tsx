// @vitest-environment jsdom

import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { ReactNode } from "react"

const { routerState } = vi.hoisted(() => ({
  routerState: { matches: [] as Array<{ routeId: string; context: { locale?: string } }> },
}))

vi.mock("@tanstack/react-router", () => ({
  createRootRoute: (options: unknown) => options,
  useRouterState: ({ select }: { select: (state: typeof routerState) => unknown }) => select(routerState),
  HeadContent: () => null,
  Scripts: () => null,
  Link: () => null,
  redirect: vi.fn(),
}))
vi.mock("../../lib/installation", () => ({ getInstallationStatus: vi.fn(), normalizeInstallationStatus: vi.fn() }))
vi.mock("../../components/theme-provider", () => ({ ThemeProvider: ({ children }: { children: ReactNode }) => children }))
vi.mock("../../components/ui/tooltip", () => ({ TooltipProvider: ({ children }: { children: ReactNode }) => children }))

import { Route } from "../__root"
import { I18nProvider, useI18n } from "../../lib/i18n/react"
import { LocalizedDocument } from "../../components/documents/localized-document"

const Shell = (Route as unknown as { shellComponent: (props: { children: ReactNode }) => ReactNode }).shellComponent

function Navigation() {
  const { t } = useI18n()
  return <nav>{t("nav.invoices")}</nav>
}

// MOCK: route context only. The real document shell and locale providers render without effects.
function response(locale?: string, children: ReactNode = <I18nProvider initialLocale={locale}><Navigation /></I18nProvider>) {
  routerState.matches = [{ routeId: "__root__", context: {} }, { routeId: "/_app", context: { locale } }]
  return renderToStaticMarkup(<Shell>{children}</Shell>)
}

afterEach(() => vi.restoreAllMocks())

describe("root document SSR language", () => {
  it.each([
    ["da-DK", "en-US", "da", "Fakturaer"],
    ["en-US", "da-DK", "en", "Invoices"],
    ["de-DE", "da-DK", "en", "Invoices"],
  ])("declares the rendered organization language for %s before hydration", (locale, browser, language, navigation) => {
    vi.spyOn(window.navigator, "language", "get").mockReturnValue(browser)
    const html = response(locale)
    expect(html).toContain(`<html lang="${language}">`)
    expect(html).toContain(`<nav>${navigation}</nav>`)
  })

  it.each(["en-US", "da-DK"])("keeps the no-organization response English in a %s browser", browser => {
    vi.spyOn(window.navigator, "language", "get").mockReturnValue(browser)
    const html = response()
    expect(html).toContain('<html lang="en">')
    expect(html).toContain("<nav>Invoices</nav>")
  })

  it("does not adopt a fixed public document's locale as the editable shell language", () => {
    routerState.matches = [{ routeId: "__root__", context: {} }, { routeId: "/q/$token", context: { locale: "da-DK" } }]
    const html = renderToStaticMarkup(<Shell><LocalizedDocument locale="da-DK"><Navigation /></LocalizedDocument></Shell>)
    expect(html).toContain('<html lang="en">')
    expect(html).toContain('lang="da-DK"')
    expect(html).toContain("<nav>Fakturaer</nav>")
  })
})
