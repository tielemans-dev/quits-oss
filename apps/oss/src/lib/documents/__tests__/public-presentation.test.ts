import { describe, expect, it } from "vitest"
import { resolvePublicPresentation } from "../public-presentation"

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

  it("only passes on a logo that can be shown in an image", () => {
    const logo = (companyLogo: string | null) =>
      resolvePublicPresentation({ document: {}, settings: { companyLogo } }).seller.logo

    expect(logo("data:image/png;base64,AAAA")).toBe("data:image/png;base64,AAAA")
    expect(logo("https://acme.example/logo.svg")).toBe("https://acme.example/logo.svg")
    expect(logo("javascript:alert(1)")).toBeNull()
    expect(logo("data:text/html;base64,AAAA")).toBeNull()
    expect(logo("")).toBeNull()
    expect(logo(null)).toBeNull()
  })
})
