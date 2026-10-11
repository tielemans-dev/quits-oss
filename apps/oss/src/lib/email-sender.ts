import ipaddr from "ipaddr.js"

const DEFAULT_FROM_EMAIL = "noreply@yaip.app"
const MAILBOX = /^(?:"(?:[^"\\]|\\.)*"|[^<>"\r\n,;:@])*<([^<>]+)>$/
const ADDRESS = /^(?:[a-z0-9!#$%&'*+/=?^_`{|}~\u0080-\ud7ff\ue000-\u{10ffff}-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~\u0080-\ud7ff\ue000-\u{10ffff}-]+)*|"(?:[^"\\\p{Cc}]|\\[^\p{Cc}])+")@(.+)$/iu
const DNS_DOMAIN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/i

function isSenderDomain(domain: string): boolean {
  if (DNS_DOMAIN.test(domain)) return true
  if (!domain.startsWith("[") || !domain.endsWith("]")) return false
  const literal = domain.slice(1, -1)
  if (/^IPv6:/i.test(literal)) {
    const address = literal.slice(5)
    return !address.includes("%") && ipaddr.IPv6.isValid(address)
  }
  return ipaddr.IPv4.isValidFourPartDecimal(literal)
}

/** FROM_EMAIL accepts one bare address or one display-name mailbox. */
export function parseSenderAddress(value: string): string {
  const mailbox = value.trim()
  if (!mailbox) return DEFAULT_FROM_EMAIL
  const address = (MAILBOX.exec(mailbox)?.[1] ?? mailbox).trim()
  const domain = ADDRESS.exec(address)?.[1]
  if (/\p{Cc}/u.test(mailbox) || !domain || !isSenderDomain(domain)) {
    throw new Error("FROM_EMAIL must contain a single email address or Name <address>")
  }
  // SMTP local parts may be case-sensitive. Domain literals retain their syntax.
  return `${address.slice(0, address.lastIndexOf("@") + 1)}${domain.startsWith("[") ? domain : domain.toLowerCase()}`
}

/** Configuration previews use null for an invalid sender; delivery still throws. */
export function tryParseSenderAddress(value: string): string | null {
  try {
    return parseSenderAddress(value)
  } catch {
    return null
  }
}

export function normalizeSenderName(value: string | null | undefined): string {
  return value?.replace(/\p{Cc}/gu, " ").trim() || "quits"
}

/** Application-level mailbox; the provider serializes Unicode names for the wire. */
export function formatSenderAddress(name: string | null | undefined, email: string): string {
  const displayName = normalizeSenderName(name)
  const address = parseSenderAddress(email)
  const quoted = displayName.replace(/["\\]/g, "\\$&")
  return `"${quoted}" <${address}>`
}
