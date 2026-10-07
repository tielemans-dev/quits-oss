// @vitest-environment jsdom
import { describe, expect, it } from "vitest"
import { renderAgreementMarkdown } from "../markdown"

describe("restricted agreement Markdown", () => {
  const hostile = [
    "<script>alert(1)</script><img src=x onerror=alert(1)>",
    '<svg onload=alert(1)><a href="javascript:alert(1)">x</a></svg>',
    "[x](javascript:alert%281%29)",
    "[x](JaVaScRiPt:alert%281%29)",
    "[x](data:text/html;base64,PHNjcmlwdD4=)",
    "[x](vbscript:evil)",
    "[x](//evil.example)",
    "[x](/relative)",
    "[x](file:///etc/passwd)",
    "[x](javascript&#58;alert%281%29)",
    "[x](java\u0000script:evil)",
    "[x](java\nscript:evil)",
    "![image](https://evil.example/pixel)",
    '<iframe src="https://evil.example"></iframe>',
    '<a href="https://example.test" onclick="evil()">link</a>',
    "<style>body{display:none}</style>",
    '<math><mtext><table><mglyph><style><!--</style><img title="--><img src=1 onerror=alert(1)>">',
  ]
  it.each(hostile)("sanitizes hostile input %j", (input) => {
    const html = renderAgreementMarkdown(input)
    const document = new DOMParser().parseFromString(html, "text/html")
    expect(document.querySelector("script,img,svg,iframe,style,math,object,embed")).toBeNull()
    for (const element of document.body.querySelectorAll("*")) {
      expect(
        element.getAttributeNames().some((name) => name.startsWith("on") || name === "style"),
      ).toBe(false)
    }
    for (const link of document.querySelectorAll("a"))
      expect(link.getAttribute("href")).toMatch(/^(https?:\/\/|mailto:)/i)
  })
  it("allows text formatting and only absolute HTTP, HTTPS and mail links", () => {
    const html = renderAgreementMarkdown(
      "**Scope**\n\n[x](https://example.test) [y](http://example.test) [z](mailto:hello@example.test)",
    )
    const document = new DOMParser().parseFromString(html, "text/html")
    expect(document.querySelector("strong")?.textContent).toBe("Scope")
    expect(document.querySelectorAll("a")).toHaveLength(3)
  })
  it("escapes placeholders including Markdown syntax before rendering", () => {
    const attack =
      "[x](https://evil.example) ![pixel](https://evil.example) <img src=x onerror=evil()> **bold**\n# heading"
    const document = new DOMParser().parseFromString(
      renderAgreementMarkdown("{{buyer.name}}", { "buyer.name": attack }),
      "text/html",
    )
    expect(document.querySelector("a,img,strong,h1")).toBeNull()
    expect(document.body.textContent?.trim()).toBe(attack)
  })
  it("bounds source and expanded terms to 50,000 characters", () => {
    expect(() => renderAgreementMarkdown("a".repeat(50_000))).not.toThrow()
    expect(() => renderAgreementMarkdown("a".repeat(50_001))).toThrow("50,000")
    expect(() =>
      renderAgreementMarkdown("{{buyer.name}}", { "buyer.name": "x".repeat(50_001) }),
    ).toThrow("50,000")
  })
})
