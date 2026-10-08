import { canRenderLogo } from "./logo"

/**
 * How a seller's logo reaches a page opened from a link.
 *
 * Settings accept an uploaded image as a `data:` URL of up to 2,000,000 characters. Putting that
 * into the page would send it twice to every visitor (server HTML and hydration data, and again
 * in each decision response), so the page carries a small address on the token-checked logo route
 * of its own document instead, and the route answers with the decoded image.
 *
 * An http(s) logo is passed through as it is: the page's `<img>` fetches it, never the server,
 * which must not request addresses a user has typed in.
 */

export type PublicLogoKind = "pay" | "q" | "a"

const PUBLIC_LOGO_DATA_URL =
  /^data:(image\/(?:png|jpeg|webp|gif|svg\+xml))((?:;[a-z0-9-]+=[^;,]*)*)(;base64)?,/i

/** The address of the logo route for a document link. */
export function publicLogoPath(kind: PublicLogoKind, token: string) {
  return `/${kind}/${encodeURIComponent(token)}/logo`
}

/**
 * The `src` for the logo of a document opened from a link, or null when there is nothing safe to
 * show. `logoPath` is the logo route of that document's own link.
 */
export function publicLogoSource(logo: string | null | undefined, logoPath: string): string | null {
  const trimmed = logo?.trim()
  if (!canRenderLogo(trimmed)) return null
  if (!trimmed.startsWith("data:")) return trimmed
  // Only the head is checked here; the route decodes the image and answers 404 for a broken one.
  return PUBLIC_LOGO_DATA_URL.test(trimmed) ? logoPath : null
}

function decodePayload(payload: string, base64: boolean): Uint8Array | null {
  try {
    if (base64) {
      const binary = atob(payload)
      const bytes = new Uint8Array(binary.length)
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
      return bytes
    }
    return new TextEncoder().encode(decodeURIComponent(payload))
  } catch {
    return null
  }
}

/** The image inside a stored `data:` logo, or null when it is not one of the allowed image types. */
export function decodeLogoDataUrl(logo: string): { contentType: string; bytes: Uint8Array } | null {
  const head = PUBLIC_LOGO_DATA_URL.exec(logo)
  if (!head) return null
  const bytes = decodePayload(logo.slice(head[0].length), Boolean(head[3]))
  if (!bytes || bytes.length === 0) return null
  return { contentType: head[1]!.toLowerCase(), bytes }
}

/** What a logo route answers for an invalid link, an organization without a logo, or a bad image. */
export function logoNotFound() {
  return new Response("Not found", { status: 404 })
}

/** The response of a logo route for the logo stored in the seller's settings. */
export function logoResponse(logo: string | null | undefined): Response {
  const image = logo ? decodeLogoDataUrl(logo.trim()) : null
  if (!image) return logoNotFound()

  const headers = new Headers({
    "Content-Type": image.contentType,
    "Cache-Control": "private, max-age=300",
    "X-Content-Type-Options": "nosniff",
  })
  if (image.contentType === "image/svg+xml") {
    // An SVG opened on its own address is a document that can run script: shut that off.
    headers.set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'")
  }
  return new Response(new Uint8Array(image.bytes), { headers })
}
