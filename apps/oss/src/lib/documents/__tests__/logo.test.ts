import { describe, expect, it } from "vitest"
import { canRenderLogo } from "../logo"

describe("canRenderLogo", () => {
  it.each([
    "data:image/png;base64,iVBORw0KGgo=",
    "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
    "https://acme.example/logo.png",
    "http://acme.example/logo.png",
  ])("accepts %s", (logo) => {
    expect(canRenderLogo(logo)).toBe(true)
  })

  it.each([
    null,
    undefined,
    "",
    "javascript:alert(1)",
    "data:text/html;base64,PHNjcmlwdD48L3NjcmlwdD4=",
    "ftp://acme.example/logo.png",
    "/relative/logo.png",
    "https://",
  ])("rejects %s", (logo) => {
    expect(canRenderLogo(logo)).toBe(false)
  })
})
