import { normalizeLocale } from "./i18n/locale"
import { translate } from "./i18n/translate"

type DownloadKind = "invoice" | "creditNote" | "quote"

/**
 * The name a downloaded PDF is saved under: its number, like `2026-0001.pdf`. A draft has no number
 * yet, so it is named for what it is and whom it is for, like `kladde-faktura-havbrise-logistik-a-s.pdf`.
 */
export function documentPdfFileName(kind: DownloadKind, number: string | null, draft?: { customer?: string | null; locale?: string | null }) {
  if (number?.trim()) return `${number.trim()}.pdf`
  const locale = draft?.locale
  const customer = (draft?.customer ?? "").toLocaleLowerCase(normalizeLocale(locale)).replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "")
  const name = translate(kind === "quote" ? "pdf.draftFileName.quote" : "pdf.draftFileName.invoice", locale)
  return `${customer ? `${name}-${customer}` : name}.pdf`
}

/** Browser downloads use the authorized server route, including for live drafts. */
export async function downloadDocumentPdf(kind: DownloadKind, id: string, number: string | null, draft?: { customer?: string | null; locale?: string | null }) {
  const response = await fetch(`/api/documents/${kind}/${encodeURIComponent(id)}/pdf`)
  if (!response.ok) throw new Error(await response.text())
  const url = URL.createObjectURL(await response.blob())
  const a = document.createElement("a")
  a.href = url
  a.download = documentPdfFileName(kind, number, draft)
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}
