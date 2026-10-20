// @vitest-environment jsdom

import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { ReactNode } from "react"
import type { UiLanguage } from "../../lib/i18n/ui-language"

const { routerState } = vi.hoisted(() => ({
  routerState: {
    matches: [] as Array<{ routeId: string; context: { locale?: string; language?: UiLanguage }; loaderData?: { locale?: string } }>,
    location: { pathname: "/", search: {} as Record<string, unknown> },
  },
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
function response(locale?: string, children: ReactNode = <I18nProvider initialLocale={locale}><Navigation /></I18nProvider>, language?: UiLanguage) {
  routerState.matches = [{ routeId: "__root__", context: { language } }, { routeId: "/_app", context: { locale } }]
  return renderToStaticMarkup(<Shell>{children}</Shell>)
}

afterEach(() => {
  vi.restoreAllMocks()
  routerState.location = { pathname: "/", search: {} }
})

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

  it.each(["en-US", "da-DK"])("declares Danish for the server-rendered setup page in a %s browser", browser => {
    vi.spyOn(window.navigator, "language", "get").mockReturnValue(browser)
    routerState.matches = [{ routeId: "__root__", context: {} }, { routeId: "/setup", context: {} }]
    const html = renderToStaticMarkup(<Shell><I18nProvider initialLocale="da-DK"><Navigation /></I18nProvider></Shell>)
    expect(html).toContain('<html lang="da">')
  })

  it.each([["da", undefined, "da", "Fakturaer"], ["da", "en-US", "da", "Fakturaer"], ["en", "da-DK", "en", "Invoices"]] as const)("declares the chosen language %s over organization locale %s", (chosen, locale, language, navigation) => {
    const html = response(locale, <I18nProvider initialLocale={chosen}><Navigation /></I18nProvider>, { chosen, browser: "en-US" })
    expect(html).toContain(`<html lang="${language}">`)
    expect(html).toContain(`<nav>${navigation}</nav>`)
  })

  // Login and signup render outside the app layout: the server answers in the chosen or browser language.
  it.each([
    [undefined, "da-DK", "da", "Fakturaer"],
    [undefined, "en-US", "en", "Invoices"],
    ["en", "da-DK", "en", "Invoices"],
    ["da", "en-US", "da", "Fakturaer"],
  ] as const)("renders a signed-out page in chosen %s, browser %s", (chosen, browser, language, navigation) => {
    routerState.matches = [{ routeId: "__root__", context: { language: { chosen, browser } } }, { routeId: "/login", context: {} }]
    const html = renderToStaticMarkup(<Shell><Navigation /></Shell>)
    expect(html).toContain(`<html lang="${language}">`)
    expect(html).toContain(`<nav>${navigation}</nav>`)
  })

  it.each([
    ["/q/$token", "da-DK", "da"],
    ["/a/$token", "da-DK", "da"],
    ["/pay/$token", "da-DK", "da"],
    ["/reminders/unsubscribe", "da-DK", "da"],
    ["/q/$token", "en-US", "en"],
  ])("declares the language of the public document on %s (%s) over the organization's (QUI-215)", (routeId, locale, language) => {
    routerState.matches = [{ routeId: "__root__", context: {} }, { routeId, context: {}, loaderData: { locale } }]
    const html = renderToStaticMarkup(<Shell><LocalizedDocument locale={locale}><Navigation /></LocalizedDocument></Shell>)
    expect(html).toContain(`<html lang="${language}">`)
    expect(html).toContain(`lang="${locale}"`)
  })

  it("keeps English for a public document whose language has no catalog", () => {
    routerState.matches = [{ routeId: "__root__", context: {} }, { routeId: "/q/$token", context: {}, loaderData: { locale: "de-DE" } }]
    const html = renderToStaticMarkup(<Shell><LocalizedDocument locale="de-DE"><Navigation /></LocalizedDocument></Shell>)
    expect(html).toContain('<html lang="en">')
  })

  // The root's beforeLoad turns `?lang` into the chosen language; this mock skips beforeLoad.
  it.each([["/login", "da", "da"], ["/signup/", "da", "da"], ["/reset-password", "en", "en"], ["/login", undefined, "en"]] as const)("declares %s's lang=%s on the document", (pathname, lang, language) => {
    routerState.matches = [{ routeId: "__root__", context: { language: { chosen: lang, browser: "en-US" } } }]
    routerState.location = { pathname, search: lang ? { lang } : {} }
    const html = renderToStaticMarkup(<Shell><Navigation /></Shell>)
    expect(html).toContain(`<html lang="${language}">`)
  })
})
