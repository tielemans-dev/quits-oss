/**
 * Whether a stored company logo can be shown on a document.
 *
 * Settings accept an uploaded image (`data:image/…`) or an http(s) image URL. Anything else, such
 * as a `javascript:` URL, is never rendered. The PDFs and the public document pages share this rule.
 */
export function canRenderLogo(logo: string | null | undefined): logo is string {
  if (!logo) return false
  return logo.startsWith("data:image/") || /^https?:\/\/.+/i.test(logo)
}
