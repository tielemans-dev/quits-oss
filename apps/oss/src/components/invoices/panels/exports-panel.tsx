import { Link } from "@tanstack/react-router"
import type { EinvoiceMissingField } from "@quits/contracts/exports"
import { AlertTriangle, Download } from "lucide-react"
import { useEffect, useState } from "react"
import { downloadTextFile } from "../../../lib/exports/download"
import { useI18n } from "../../../lib/i18n/react"
import { trpc } from "../../../trpc/client"
import { Button } from "../../ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../ui/card"
import type { InvoicePanelProps } from "./types"

/** E-invoice (Peppol BIS Billing 3.0 UBL) download for an issued invoice. */
export function InvoiceExportsPanel({ invoice }: InvoicePanelProps) {
  const { t } = useI18n()
  const [busy, setBusy] = useState(false)
  const [missing, setMissing] = useState<EinvoiceMissingField[]>([])
  const [issued, setIssued] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [unavailable, setUnavailable] = useState(false)
  const draft = invoice.status === "draft"

  // An issued invoice either carries its stored e-invoice or never will, so say which before anyone clicks.
  useEffect(() => {
    if (draft) return
    let current = true
    trpc.exports.einvoiceStatus.query({ kind: "invoice", id: invoice.id }).then((status) => {
      if (!current || !status || status.stored) return
      setMissing(status.missing)
      setIssued(true)
      setUnavailable(status.missing.length === 0)
    }, () => {})
    return () => { current = false }
  }, [draft, invoice.id])

  if (draft) {
    return null
  }

  async function handleDownload() {
    setBusy(true)
    setError(null)
    setMissing([])
    try {
      const result = await trpc.exports.einvoice.query({ kind: "invoice", id: invoice.id })
      if (result.ok) {
        downloadTextFile(result.filename, result.xml, "application/xml")
      } else {
        setMissing(result.missing)
        setIssued(result.issued === true)
      }
    } catch (err) {
      const unavailable = (err as { data?: { code?: string } } | null)?.data?.code === "PRECONDITION_FAILED"
      setError(t(unavailable ? "exports.einvoice.unavailable" : "exports.einvoice.error"))
    } finally {
      setBusy(false)
    }
  }

  const buyerMissing = missing.some((field) => field.startsWith("buyer."))
  const sellerMissing = missing.some((field) => field.startsWith("seller."))

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("exports.einvoice.title")}</CardTitle>
        <CardDescription>{t("exports.einvoice.description")}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {issued ? null : (
          <div>
            <Button type="button" variant="outline" onClick={handleDownload} disabled={busy}>
              <Download className="size-4" />
              {busy ? t("exports.einvoice.preparing") : t("exports.einvoice.download")}
            </Button>
          </div>
        )}
        {unavailable ? <p className="text-sm text-muted-foreground">{t("exports.einvoice.unavailable")}</p> : null}
        {error ? (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}
        {missing.length > 0 ? (
          <div className="rounded-md border border-tone-warning/30 bg-tone-warning/14 p-3 text-sm text-foreground" role="alert">
            <p className="flex items-start gap-2 font-medium">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-tone-warning" aria-hidden="true" />
              {t(issued ? "exports.einvoice.missing.issuedTitle" : "exports.einvoice.missing.title")}
            </p>
            <ul className="mt-2 list-disc pl-5 grid gap-1">
              {missing.map((field) => (
                <li key={field}>{t(`exports.einvoice.missing.${field}`)}</li>
              ))}
            </ul>
            <div className="mt-3 flex flex-wrap gap-2">
              {buyerMissing ? (
                <Button asChild size="sm" variant="outline">
                  <Link to="/contacts/$contactId" params={{ contactId: invoice.contact.id }} search={{ edit: true }}>
                    {t("exports.einvoice.editContact")}
                  </Link>
                </Button>
              ) : null}
              {sellerMissing ? (
                <Button asChild size="sm" variant="outline">
                  <Link to="/settings">{t("nav.settings")}</Link>
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  )
}
