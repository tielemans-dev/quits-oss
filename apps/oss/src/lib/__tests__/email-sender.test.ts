import { describe, expect, it } from "vitest"
import { formatSenderAddress, parseSenderAddress } from "../email-sender"

describe("sender mailboxes", () => {
  it.each([
    "noreply@tielemans.dev",
    "Quits <noreply@tielemans.dev>",
    '"Quits" <noreply@tielemans.dev>',
    '"Quits <billing>, \\"team\\"" <noreply@tielemans.dev>',
    " <noreply@tielemans.dev> ",
    "  Quits < NOREPLY@TIELEMANS.DEV >  ",
    "Æble & Øl <noreply@tielemans.dev>",
  ])("extracts one address from %s", value => {
    expect(parseSenderAddress(value)).toBe("noreply@tielemans.dev")
    expect(formatSenderAddress("QA Test Co via Quits", value))
      .toBe('"QA Test Co via Quits" <noreply@tielemans.dev>')
  })

  it("keeps plus addressing and quoted local parts", () => {
    expect(parseSenderAddress("Quits <billing+invoices@example.com>"))
      .toBe("billing+invoices@example.com")
    expect(parseSenderAddress('Quits <"billing@team"@example.com>'))
      .toBe('"billing@team"@example.com')
  })

  it.each(["", "  "])("uses the existing default for an empty FROM_EMAIL", value => {
    expect(parseSenderAddress(value)).toBe("noreply@yaip.app")
  })

  it.each([
    "Quits <quits <noreply@example.com>>",
    "one@example.com, two@example.com",
    "Quits <one@example.com>, Other <two@example.com>",
    "one@example.com, Other <two@example.com>",
    "Quits <noreply@example.com",
    "not an address",
    "noreply@example..com",
    "noreply@-example.com",
    "noreply@example.com\x00",
    "Quits <noreply@example.com>\r\nBcc: other@example.com",
  ])("rejects malformed or multiple mailboxes: %s", value => {
    expect(() => parseSenderAddress(value)).toThrow("FROM_EMAIL must contain a single")
  })
})

describe("sender display names", () => {
  it("quotes ASCII names and escapes quotes and backslashes", () => {
    expect(formatSenderAddress('QA "Test" \\ Co, Inc. via Quits', "noreply@example.com"))
      .toBe('"QA \\"Test\\" \\\\ Co, Inc. via Quits" <noreply@example.com>')
    expect(formatSenderAddress("Acme <ApS> (billing) via Quits", "noreply@example.com"))
      .toBe('"Acme <ApS> (billing) via Quits" <noreply@example.com>')
  })

  it("encodes Danish characters and quotes as RFC 2047 UTF-8 encoded-words", () => {
    const name = 'Æble "Øl" Århus via Quits'
    expect(formatSenderAddress(name, "noreply@example.com"))
      .toBe(`=?UTF-8?B?${Buffer.from(name).toString("base64")}?= <noreply@example.com>`)
  })

  it("splits long UTF-8 names into bounded encoded-words without breaking characters", () => {
    const name = `${"ÆØÅ🍎".repeat(30)} via Quits`
    const header = formatSenderAddress(name, "noreply@example.com")
    const words = header.slice(0, header.indexOf(" <")).split(" ")
    expect(words.length).toBeGreaterThan(1)
    const decoded = words.map(word => {
      expect(word.length).toBeLessThanOrEqual(75)
      expect(word).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/)
      return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(word.slice(10, -2), "base64"))
    }).join("")
    expect(decoded).toBe(name)
  })

  it.each([null, undefined, "", "  "])("falls back to Quits for an empty name", name => {
    expect(formatSenderAddress(name, "noreply@example.com"))
      .toBe('"Quits" <noreply@example.com>')
  })

  it("removes header controls from organization names", () => {
    expect(formatSenderAddress("Acme\r\nBcc: attacker@example.com\x00", "noreply@example.com"))
      .toBe('"Acme  Bcc: attacker@example.com" <noreply@example.com>')
  })
})
