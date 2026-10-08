import { describe, expect, it } from "vitest"
import {
  decodeLogoDataUrl,
  logoResponse,
  publicLogoPath,
  publicLogoSource,
} from "../public-logo"

// A 1x1 transparent PNG.
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
const PNG_DATA_URL = `data:image/png;base64,${PNG_BASE64}`
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4"/></svg>'

describe("publicLogoPath", () => {
  it("addresses the logo route of the document link", () => {
    expect(publicLogoPath("pay", "abc.def")).toBe("/pay/abc.def/logo")
    expect(publicLogoPath("q", "a/b")).toBe("/q/a%2Fb/logo")
    expect(publicLogoPath("a", "tok")).toBe("/a/tok/logo")
  })
})

describe("publicLogoSource", () => {
  it("keeps an http(s) URL as stored", () => {
    expect(publicLogoSource("https://acme.example/logo.png", "/pay/t/logo")).toBe(
      "https://acme.example/logo.png"
    )
  })

  it("points allowed uploaded image types at the logo route", () => {
    for (const type of ["png", "jpeg", "webp", "gif", "svg+xml"]) {
      expect(publicLogoSource(`data:image/${type};base64,AAAA`, "/pay/t/logo")).toBe("/pay/t/logo")
    }
  })

  it.each([
    "data:image/bmp;base64,AAAA",
    "data:image/x-icon;base64,AAAA",
    "data:text/html;base64,AAAA",
    "javascript:alert(1)",
    "",
    null,
  ])("shows nothing for %s", (logo) => {
    expect(publicLogoSource(logo, "/pay/t/logo")).toBeNull()
  })
})

describe("decodeLogoDataUrl", () => {
  it("decodes a base64 image", () => {
    const image = decodeLogoDataUrl(PNG_DATA_URL)
    expect(image?.contentType).toBe("image/png")
    expect(Array.from(image!.bytes.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47])
  })

  it("decodes a percent-encoded image", () => {
    const image = decodeLogoDataUrl(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(SVG)}`)
    expect(image?.contentType).toBe("image/svg+xml")
    expect(new TextDecoder().decode(image!.bytes)).toBe(SVG)
  })

  it("rejects types other than png, jpeg, webp, gif and svg", () => {
    expect(decodeLogoDataUrl("data:image/bmp;base64,AAAA")).toBeNull()
    expect(decodeLogoDataUrl("data:text/html;base64,PHNjcmlwdD48L3NjcmlwdD4=")).toBeNull()
    expect(decodeLogoDataUrl("data:application/pdf;base64,AAAA")).toBeNull()
  })

  it("rejects an empty or undecodable payload", () => {
    expect(decodeLogoDataUrl("data:image/png;base64,")).toBeNull()
    expect(decodeLogoDataUrl("data:image/png;base64,***not base64***")).toBeNull()
    expect(decodeLogoDataUrl("data:image/svg+xml,%E0%A4%A")).toBeNull()
  })
})

describe("logoResponse", () => {
  it("returns the image bytes with its type and the protective headers", async () => {
    const response = logoResponse(PNG_DATA_URL)

    expect(response.status).toBe(200)
    expect(response.headers.get("Content-Type")).toBe("image/png")
    expect(response.headers.get("Cache-Control")).toBe("private, max-age=300")
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff")
    expect(response.headers.get("Content-Security-Policy")).toBeNull()
    expect(Buffer.from(await response.arrayBuffer()).toString("base64")).toBe(PNG_BASE64)
  })

  it("locks an SVG down so it cannot run script when opened directly", async () => {
    const response = logoResponse(`data:image/svg+xml;base64,${Buffer.from(SVG).toString("base64")}`)

    expect(response.status).toBe(200)
    expect(response.headers.get("Content-Type")).toBe("image/svg+xml")
    expect(response.headers.get("Content-Security-Policy")).toBe(
      "default-src 'none'; style-src 'unsafe-inline'"
    )
    expect(await response.text()).toBe(SVG)
  })

  it.each([
    null,
    undefined,
    "",
    "https://acme.example/logo.png",
    "data:text/html;base64,PHNjcmlwdD48L3NjcmlwdD4=",
    "data:image/bmp;base64,AAAA",
  ])("answers 404 for %s", (logo) => {
    expect(logoResponse(logo).status).toBe(404)
  })
})
