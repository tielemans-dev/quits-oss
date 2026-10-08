import { canRenderLogo } from "./logo"

/**
 * How a document opened from a link is presented to the person who received it.
 *
 * The language, number and date formats come from the document itself, the same `locale` and
 * `timezone` its PDF is rendered with, so the page matches what the customer already holds. Only a
 * document without a usable value falls back to the seller organization's setting. The visitor's
 * browser language never decides: it differs between the server render and the hydrated page, and
 * says nothing about the language of the document.
 */

export const DEFAULT_PUBLIC_LOCALE = "en-US"
export const DEFAULT_PUBLIC_TIMEZONE = "UTC"

export type PublicSeller = {
  /** The company name frozen on the document, or the organization's current one. Never a product name. */
  name: string | null
  /** A logo that can be shown in an `<img>`: an inline image or an http(s) URL. */
  logo: string | null
}

export type PublicPresentation = {
  locale: string
  timezone: string
  seller: PublicSeller
}

/** The organization settings the presentation reads. Nothing else of the row is exposed. */
export type PublicPresentationSettings = {
  locale?: string | null
  timezone?: string | null
  companyName?: string | null
  companyLogo?: string | null
}

/** The columns to select when loading an organization's settings for a public page. */
export const publicPresentationSettingsSelect = {
  locale: true,
  timezone: true,
  companyName: true,
  companyLogo: true,
} as const

function usableLocale(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  if (!trimmed) return null
  try {
    return Intl.getCanonicalLocales(trimmed)[0] ?? null
  } catch {
    // A malformed tag would make every Intl formatter throw.
    return null
  }
}

function usableTimeZone(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  if (!trimmed) return null
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: trimmed })
    return trimmed
  } catch {
    return null
  }
}

export function resolvePublicPresentation(input: {
  /** The document's own values. */
  document: {
    locale?: string | null
    timezone?: string | null
    sellerSnapshot?: { companyName?: string | null } | null
  }
  /** The seller organization's current settings. */
  settings?: PublicPresentationSettings | null
}): PublicPresentation {
  const { document, settings } = input
  const name = document.sellerSnapshot?.companyName?.trim() || settings?.companyName?.trim() || null
  const logo = settings?.companyLogo?.trim()

  return {
    locale: usableLocale(document.locale) ?? usableLocale(settings?.locale) ?? DEFAULT_PUBLIC_LOCALE,
    timezone:
      usableTimeZone(document.timezone) ??
      usableTimeZone(settings?.timezone) ??
      DEFAULT_PUBLIC_TIMEZONE,
    seller: { name, logo: canRenderLogo(logo) ? logo : null },
  }
}
