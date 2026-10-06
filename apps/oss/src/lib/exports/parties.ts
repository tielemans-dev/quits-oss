/**
 * Normalizes the loosely typed party data YAIP stores (free-text countries, addresses and tax
 * IDs) into what an EN 16931 / Peppol document needs.
 */

export type TaxIdLike = { scheme?: string | null; value: string; countryCode?: string | null }

export type ElectronicAddress = { scheme: string; id: string }

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
let regionNames: Map<string, string> | null = null
let englishRegions: Intl.DisplayNames | null = null

function normalizeName(value: string) {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z]/g, "")
}

function regionDisplayNames() {
  if (regionNames) return regionNames
  const names = new Map<string, string>()
  const displays = ["en", "da", "de", "fr", "nl"].map(
    (language) => new Intl.DisplayNames([language], { type: "region", fallback: "none" })
  )
  for (const first of LETTERS) {
    for (const second of LETTERS) {
      const code = `${first}${second}`
      for (const display of displays) {
        const name = isKnownRegion(code) ? display.of(code) : undefined
        if (name && name !== code) names.set(normalizeName(name), code)
      }
    }
  }
  // Common aliases Intl does not produce.
  for (const [alias, code] of [
    ["usa", "US"],
    ["unitedstatesofamerica", "US"],
    ["uk", "GB"],
    ["greatbritain", "GB"],
    ["england", "GB"],
    ["holland", "NL"],
  ] as const) {
    names.set(alias, code)
  }
  regionNames = names
  return names
}

/** User-assigned and grouping codes that are not countries (ZZ, EU, UN, QO, XA...). */
const NON_COUNTRY_CODES = /^(AA|Q[M-Z]|X[A-JL-Z]|ZZ|EU|EZ|UN)$/

function isKnownRegion(code: string) {
  if (NON_COUNTRY_CODES.test(code)) return false
  englishRegions ??= new Intl.DisplayNames(["en"], { type: "region", fallback: "none" })
  const name = englishRegions.of(code)
  return Boolean(name && name !== code)
}

/** ISO 3166-1 alpha-2 code for a stored country (a code or a name in a common language). */
export function toCountryCode(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  if (!trimmed) return null
  if (/^[A-Za-z]{2}$/.test(trimmed)) {
    const code = trimmed.toUpperCase()
    return isKnownRegion(code) ? code : null
  }
  return regionDisplayNames().get(normalizeName(trimmed)) ?? null
}

export type PostalAddress = {
  street: string | null
  additionalStreet: string | null
  city: string | null
  postalZone: string | null
  region: string | null
}

const POSTAL_LINE = /^(?:[A-Z]{1,2}-)?(\d{4}\s?[A-Z]{2}|\d{3,6}(?:-\d{3,4})?)\s+(.+)$/

/**
 * Splits a free-text organization address ("Street 1\n2100 København Ø") into parts. Lines that
 * look like "postcode city" fill the postal zone and city; the first other lines are streets.
 */
export function parseFreeTextAddress(value: string | null | undefined, countryCode?: string | null) {
  const address: PostalAddress = {
    street: null,
    additionalStreet: null,
    city: null,
    postalZone: null,
    region: null,
  }
  const lines = (value ?? "")
    .split(/\r?\n|,/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !countryCode || toCountryCode(line) !== countryCode)

  const streets: string[] = []
  for (const line of lines) {
    const match = address.postalZone === null ? POSTAL_LINE.exec(line) : null
    if (match) {
      address.postalZone = match[1]!
      address.city = match[2]!.trim()
    } else {
      streets.push(line)
    }
  }
  address.street = streets[0] ?? null
  address.additionalStreet = streets.length > 1 ? streets.slice(1).join(", ") : null
  return address
}

const VAT_SCHEMES = new Set(["vat", "eu_vat", "vat_id", "vatin", "moms", "ust", "tva", "btw"])

/** VAT prefixes that differ from the ISO country code. */
const VAT_PREFIX: Record<string, string> = { GR: "EL" }

function compact(value: string) {
  return value.replace(/[\s.\-/]/g, "").toUpperCase()
}

/**
 * The party's VAT identifier with its country prefix (BR-CO-09), when one of its tax IDs is a
 * VAT number. A Danish CVR number doubles as the VAT number, so it is accepted for DK.
 */
export function vatIdentifier(taxIds: readonly TaxIdLike[], countryCode: string | null): string | null {
  for (const taxId of taxIds) {
    const scheme = taxId.scheme?.trim().toLowerCase() ?? ""
    const value = compact(taxId.value)
    if (!value) continue
    const country = (taxId.countryCode?.trim().toUpperCase() || countryCode) ?? null
    const prefix = country ? (VAT_PREFIX[country] ?? country) : null
    const hasPrefix = /^[A-Z]{2}[0-9A-Z]{2,13}$/.test(value)

    if (VAT_SCHEMES.has(scheme) || (scheme === "cvr" && country === "DK")) {
      if (hasPrefix) return value
      return prefix ? `${prefix}${value}` : null
    }
    if (!scheme && hasPrefix && prefix && value.startsWith(prefix)) {
      return value
    }
  }
  return null
}

/** A registration number that is not the VAT number (e.g. CVR, organisation number). */
export function companyIdentifier(taxIds: readonly TaxIdLike[]): string | null {
  for (const taxId of taxIds) {
    const scheme = taxId.scheme?.trim().toLowerCase() ?? ""
    if (scheme && !VAT_SCHEMES.has(scheme) && scheme !== "ein") {
      const value = taxId.value.trim()
      if (value) return value
    }
  }
  return null
}

/**
 * Peppol electronic address scheme (EAS) per VAT country. Most use the "99xx" VAT schemes that
 * take the full prefixed VAT number; a few national registers take only the digits.
 */
const VAT_EAS: Record<string, { scheme: string; value: (vat: string) => string | null }> = {
  AT: { scheme: "9914", value: (vat) => vat },
  BE: { scheme: "0208", value: (vat) => vat.slice(2).replace(/\D/g, "").padStart(10, "0") },
  BG: { scheme: "9926", value: (vat) => vat },
  CY: { scheme: "9928", value: (vat) => vat },
  CZ: { scheme: "9929", value: (vat) => vat },
  DE: { scheme: "9930", value: (vat) => vat },
  DK: { scheme: "0184", value: (vat) => vat.slice(2) },
  EE: { scheme: "9931", value: (vat) => vat },
  EL: { scheme: "9933", value: (vat) => vat },
  ES: { scheme: "9920", value: (vat) => vat },
  FR: { scheme: "9957", value: (vat) => vat },
  GB: { scheme: "9932", value: (vat) => vat },
  HR: { scheme: "9934", value: (vat) => vat },
  HU: { scheme: "9910", value: (vat) => vat },
  IE: { scheme: "9935", value: (vat) => vat },
  IT: { scheme: "0211", value: (vat) => vat },
  LT: { scheme: "9937", value: (vat) => vat },
  LU: { scheme: "9938", value: (vat) => vat },
  LV: { scheme: "9939", value: (vat) => vat },
  MT: { scheme: "9943", value: (vat) => vat },
  NL: { scheme: "9944", value: (vat) => vat },
  NO: { scheme: "0192", value: (vat) => vat.replace(/\D/g, "") || null },
  PL: { scheme: "9945", value: (vat) => vat },
  PT: { scheme: "9946", value: (vat) => vat },
  RO: { scheme: "9947", value: (vat) => vat },
  SE: { scheme: "0007", value: (vat) => vat.replace(/\D/g, "").slice(0, 10) || null },
  SI: { scheme: "9949", value: (vat) => vat },
  SK: { scheme: "9950", value: (vat) => vat },
}

/** Derives a Peppol electronic address from a prefixed VAT identifier when the country is known. */
export function electronicAddressFromVat(vatId: string | null): ElectronicAddress | null {
  if (!vatId) return null
  const rule = VAT_EAS[vatId.slice(0, 2)]
  const id = rule?.value(vatId)
  return rule && id ? { scheme: rule.scheme, id } : null
}

/** An explicit electronic address when both parts are present and the scheme is a 4-digit EAS code. */
export function explicitElectronicAddress(
  id: string | null | undefined,
  scheme: string | null | undefined
): ElectronicAddress | null {
  const cleanId = id?.trim()
  const cleanScheme = scheme?.trim()
  if (!cleanId || !cleanScheme || !/^\d{4}$/.test(cleanScheme)) return null
  return { scheme: cleanScheme, id: cleanId }
}
