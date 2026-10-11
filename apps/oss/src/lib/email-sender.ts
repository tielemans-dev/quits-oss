const DEFAULT_FROM_EMAIL = "noreply@yaip.app"
const MAILBOX = /^(?:"(?:[^"\\]|\\.)*"|[^<>"\r\n,;:@])*<([^<>]+)>$/
const ADDRESS = /^(?:[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*|"(?:[^"\\\p{Cc}]|\\[^\p{Cc}])+")@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/iu

/** FROM_EMAIL accepts one bare address or one display-name mailbox. */
export function parseSenderAddress(value: string): string {
  const mailbox = value.trim()
  if (!mailbox) return DEFAULT_FROM_EMAIL
  const address = (MAILBOX.exec(mailbox)?.[1] ?? mailbox).trim()
  if (/\p{Cc}/u.test(mailbox) || !ADDRESS.test(address)) {
    throw new Error("FROM_EMAIL must contain a single email address or Name <address>")
  }
  return address.toLowerCase()
}

export function normalizeSenderName(value: string | null | undefined): string {
  return value?.replace(/\p{Cc}/gu, " ").trim() || "quits"
}

/** RFC 5322 quoted strings for ASCII; RFC 2047 encoded-words for UTF-8 names. */
export function formatSenderAddress(name: string | null | undefined, email: string): string {
  const displayName = normalizeSenderName(name)
  const address = parseSenderAddress(email)
  if (/^[\x20-\x7e]*$/.test(displayName)) {
    const quoted = displayName.replace(/["\\]/g, "\\$&")
    return `"${quoted}" <${address}>`
  }

  // 45 UTF-8 bytes produce 60 base64 characters, keeping each encoded-word below
  // RFC 2047's 75-character limit. Split between code points, never within one.
  const words: string[] = []
  let bytes: number[] = []
  const encoder = new TextEncoder()
  const flush = () => {
    if (bytes.length) words.push(`=?UTF-8?B?${btoa(String.fromCharCode(...bytes))}?=`)
    bytes = []
  }
  for (const character of displayName) {
    const encoded = encoder.encode(character)
    if (bytes.length + encoded.length > 45) flush()
    bytes.push(...encoded)
  }
  flush()
  return `${words.join(" ")} <${address}>`
}
