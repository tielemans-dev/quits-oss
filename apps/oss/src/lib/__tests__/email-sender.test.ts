import { describe, expect, it } from "vitest"
import { formatSenderAddress, parseSenderAddress } from "../email-sender"

describe("sender mailboxes", () => {
  it.each([
    "noreply@tielemans.dev",
    "Quits <noreply@tielemans.dev>",
    '"Quits" <noreply@tielemans.dev>',
    '"Quits <billing>, \\"team\\"" <noreply@tielemans.dev>',
    " <noreply@tielemans.dev> ",
    "Æble & Øl <noreply@tielemans.dev>",
  ])("extracts one address from %s", value => {
    expect(parseSenderAddress(value)).toBe("noreply@tielemans.dev")
    expect(formatSenderAddress("QA Test Co via quits", value))
      .toBe('"QA Test Co via quits" <noreply@tielemans.dev>')
  })

  it("keeps plus addressing and quoted local parts", () => {
    expect(parseSenderAddress("Quits <billing+invoices@example.com>"))
      .toBe("billing+invoices@example.com")
    expect(parseSenderAddress('Quits <"billing@team"@example.com>'))
      .toBe('"billing@team"@example.com')
  })

  it.each([
    ["Sales@EXAMPLE.COM", "Sales@example.com"],
    ["Faktúra@EXAMPLE.COM", "Faktúra@example.com"],
    ['Quits <"Billing@Team"@EXAMPLE.COM>', '"Billing@Team"@example.com'],
    ["Quits <NOREPLY@TIELEMANS.DEV>", "NOREPLY@tielemans.dev"],
    ["quits@[127.0.0.1]", "quits@[127.0.0.1]"],
    ["quits@[IPv6:::1]", "quits@[IPv6:::1]"],
    ["quits@[IPv6:2001:DB8::1]", "quits@[IPv6:2001:DB8::1]"],
  ])("preserves mailbox identity for %s", (value, expected) => {
    expect(parseSenderAddress(value)).toBe(expected)
    expect(formatSenderAddress("quits", value)).toBe(`"quits" <${expected}>`)
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
    "quits@[999.0.0.1]",
    "quits@[IPv6:bad]",
    "quits@[IPv6:fe80::1%lo0]",
    "broken\ud800@example.com",
    "noreply@example.com\x00",
    "Quits <noreply@example.com>\r\nBcc: other@example.com",
  ])("rejects malformed or multiple mailboxes: %s", value => {
    expect(() => parseSenderAddress(value)).toThrow("FROM_EMAIL must contain a single")
  })
})

describe("sender display names", () => {
  it("quotes ASCII names and escapes quotes and backslashes", () => {
    expect(formatSenderAddress('QA "Test" \\ Co, Inc. via quits', "noreply@example.com"))
      .toBe('"QA \\"Test\\" \\\\ Co, Inc. via quits" <noreply@example.com>')
    expect(formatSenderAddress("Acme <ApS> (billing) via quits", "noreply@example.com"))
      .toBe('"Acme <ApS> (billing) via quits" <noreply@example.com>')
  })

  it("keeps Danish characters and escapes quotes for the transport", () => {
    const name = 'Æble "Øl" Århus via quits'
    expect(formatSenderAddress(name, "noreply@example.com"))
      .toBe('"Æble \\"Øl\\" Århus via quits" <noreply@example.com>')
  })

  it("preserves long Unicode names for transport serialization", () => {
    const name = `${"ÆØÅ🍎".repeat(30)} via quits`
    const header = formatSenderAddress(name, "noreply@example.com")
    expect(header).toBe(`"${name}" <noreply@example.com>`)
  })

  it.each([null, undefined, "", "  "])("falls back to quits for an empty name", name => {
    expect(formatSenderAddress(name, "noreply@example.com"))
      .toBe('"quits" <noreply@example.com>')
  })

  it("removes header controls from organization names", () => {
    expect(formatSenderAddress("Acme\r\nBcc: attacker@example.com\x00", "noreply@example.com"))
      .toBe('"Acme  Bcc: attacker@example.com" <noreply@example.com>')
  })
})
