import { describe, expect, it } from "vitest"
import { resolvePublicPresentation as resolve } from "../public-presentation"

const logoPath = "/pay/tok/logo"
const resolvePublicPresentation = (input: Omit<Parameters<typeof resolve>[0], "logoPath">) =>
  resolve({ ...input, logoPath })

describe("resolvePublicPresentation", () => {
  it("takes the language and timezone from the document, not the organization", () => {
    const presentation = resolvePublicPresentation({
      document: { locale: "da-DK", timezone: "Europe/Copenhagen" },
      settings: { locale: "en-US", timezone: "UTC" },
    })

    expect(presentation.locale).toBe("da-DK")
    expect(presentation.timezone).toBe("Europe/Copenhagen")
  })

  it("falls back to the organization's settings when the document has none", () => {
    expect(
      resolvePublicPresentation({
        document: { locale: "  ", timezone: null },
        settings: { locale: "da-DK", timezone: "Europe/Copenhagen" },
      })
    ).toMatchObject({ locale: "da-DK", timezone: "Europe/Copenhagen" })
  })

  it("falls back to US English and UTC when nothing usable is stored", () => {
    expect(resolvePublicPresentation({ document: {}, settings: null })).toMatchObject({
      locale: "en-US",
      timezone: "UTC",
    })
  })

  it("skips a locale or timezone Intl would reject instead of failing to render", () => {
    expect(
      resolvePublicPresentation({
        document: { locale: "not a locale", timezone: "Not/AZone" },
        settings: { locale: "da-DK", timezone: "Europe/Copenhagen" },
      })
    ).toMatchObject({ locale: "da-DK", timezone: "Europe/Copenhagen" })
  })

  it("names the seller from the document's frozen snapshot before the current settings", () => {
    expect(
      resolvePublicPresentation({
        document: { sellerSnapshot: { companyName: " Frozen ApS " } },
        settings: { companyName: "Renamed ApS" },
      }).seller.name
    ).toBe("Frozen ApS")
    expect(
      resolvePublicPresentation({
        document: { sellerSnapshot: { companyName: null } },
        settings: { companyName: "Renamed ApS" },
      }).seller.name
    ).toBe("Renamed ApS")
  })

  it("has no seller name rather than a product name when none is recorded", () => {
    const { seller } = resolvePublicPresentation({
      document: { sellerSnapshot: { companyName: " " } },
      settings: { companyName: null },
    })

    expect(seller.name).toBeNull()
  })

  it("passes an http(s) logo on as stored and points an uploaded one at the logo route", () => {
    const logo = (companyLogo: string | null) =>
      resolvePublicPresentation({ document: {}, settings: { companyLogo } }).seller.logo

    expect(logo("data:image/png;base64,AAAA")).toBe(logoPath)
    expect(logo("data:image/svg+xml;base64,AAAA")).toBe(logoPath)
    expect(logo("https://acme.example/logo.svg")).toBe("https://acme.example/logo.svg")
  })

  it("never puts an uploaded logo into the presentation", () => {
    const upload = `data:image/png;base64,${"A".repeat(5000)}`
    const presentation = resolvePublicPresentation({ document: {}, settings: { companyLogo: upload } })

    expect(JSON.stringify(presentation)).not.toContain("data:image")
  })

  it("drops a logo that cannot be shown in an image", () => {
    const logo = (companyLogo: string | null) =>
      resolvePublicPresentation({ document: {}, settings: { companyLogo } }).seller.logo

    expect(logo("javascript:alert(1)")).toBeNull()
    expect(logo("data:text/html;base64,AAAA")).toBeNull()
    expect(logo("data:image/bmp;base64,AAAA")).toBeNull()
    expect(logo("")).toBeNull()
    expect(logo(null)).toBeNull()
  })
})
