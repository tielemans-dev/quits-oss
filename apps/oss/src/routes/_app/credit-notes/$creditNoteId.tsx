import { createFileRoute, Link } from "@tanstack/react-router"
import { useCallback, useEffect, useRef, useState } from "react"
import { ArrowLeft, Download, Mail } from "lucide-react"
import { parseBuyerSnapshot } from "@yaip/contracts/documents"
import { trpc } from "../../../trpc/client"
import { useSession } from "../../../lib/auth-client"
import { formatCurrency, formatDate } from "../../../lib/i18n/format"
import { useI18n } from "../../../lib/i18n/react"
import type { OrgSettingsForPdf } from "../../../lib/invoice-pdf"
import { Button } from "../../../components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../../components/ui/card"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../../components/ui/table"
import type { CreditNoteDetail } from "../../../components/credit-notes/types"

/** Owned by the credit notes feature. */
export const Route = createFileRoute("/_app/credit-notes/$creditNoteId")({
  component: CreditNoteDetailPage,
})

type OrgContext = OrgSettingsForPdf & { emailAvailable: boolean }

function isValidEmailAddress(email: string | null | undefined) {
  return Boolean(email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()))
}

async function downloadPdf(creditNote: CreditNoteDetail, org: OrgSettingsForPdf) {
  const { downloadCreditNotePdf } = await import("../../../lib/credit-note-pdf")
  const buyer = parseBuyerSnapshot(creditNote.buyerSnapshot)
  await downloadCreditNotePdf(
    {
      ...creditNote,
      contact: { ...creditNote.contact, ...buyer, name: buyer?.name ?? creditNote.contact.name },
    },
    org
  )
}

function CreditNoteDetailPage() {
  const { t, locale } = useI18n()
  const { creditNoteId } = Route.useParams()
  const [creditNote, setCreditNote] = useState<CreditNoteDetail | null>(null)
  const [org, setOrg] = useState<OrgContext>({ emailAvailable: false })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [canSend, setCanSend] = useState(false)
  // Capabilities belong to the active organization; `undefined` while the session loads.
  const { data: session, isPending: sessionPending } = useSession()
  const organizationId = sessionPending ? undefined : (session?.session.activeOrganizationId ?? null)
  const latestLoad = useRef(0)

  const load = useCallback(async () => {
    const request = ++latestLoad.current
    const [data, settings, capabilities] = await Promise.all([
      trpc.creditNotes.get.query({ id: creditNoteId }),
      trpc.settings.get.query(),
      trpc.creditNotes.capabilities.query(),
    ])
    // A late answer from before an organization switch must not restore old rights.
    if (request !== latestLoad.current) return
    setCreditNote(data)
    setCanSend(capabilities.canSend)
    setOrg({
      companyName: settings.companyName,
      companyEmail: settings.companyEmail,
      companyPhone: settings.companyPhone,
      companyAddress: settings.companyAddress,
      companyLogo: settings.companyLogo,
      locale: settings.locale,
      timezone: settings.timezone,
      emailAvailable: settings.emailDelivery.available,
    })
  }, [creditNoteId])

  // Switching organization keeps the page mounted, so start over with nothing allowed.
  useEffect(() => {
    setCanSend(false)
    if (organizationId === undefined) return
    load()
      .catch(() => setError(t("creditNotes.detail.notFound")))
      .finally(() => setLoading(false))
  }, [load, t, organizationId])

  async function handleSend() {
    if (!creditNote) return
    setSending(true)
    setError(null)
    setNotice(null)
    try {
      const result = await trpc.creditNotes.send.mutate({ id: creditNote.id })
      setNotice(t("creditNotes.detail.email.success", { email: result.recipient }))
    } catch (err) {
      setError(err instanceof Error ? err.message : t("creditNotes.error.generic"))
    } finally {
      setSending(false)
      await load().catch(() => undefined)
    }
  }

  async function handleDownload() {
    if (!creditNote) return
    setDownloading(true)
    try {
      await downloadPdf(creditNote, org)
    } catch {
      setError(t("creditNotes.error.pdfFailed"))
    } finally {
      setDownloading(false)
    }
  }

  const backLink = (
    <Button variant="ghost" size="sm" asChild>
      <Link to="/credit-notes">
        <ArrowLeft className="size-4" />
        {t("creditNotes.action.back")}
      </Link>
    </Button>
  )

  if (loading) {
    return (
      <div className="p-6">
        <p className="text-muted-foreground">{t("creditNotes.loading")}</p>
      </div>
    )
  }

  if (!creditNote) {
    return (
      <div className="p-6 grid gap-4 justify-items-start">
        {backLink}
        <p className="text-sm text-destructive" role="alert">
          {error ?? t("creditNotes.detail.notFound")}
        </p>
      </div>
    )
  }

  const timezone = creditNote.timezone
  const money = (value: number) => formatCurrency(value, creditNote.currency, locale)
  const buyer = parseBuyerSnapshot(creditNote.buyerSnapshot)
  const contact = { ...creditNote.contact, ...buyer, name: buyer?.name ?? creditNote.contact.name }
  const recipientValid = isValidEmailAddress(creditNote.contact.email)
  const lastAttemptAt = creditNote.lastEmailAttemptAt
  const emailStatus = !lastAttemptAt
    ? t("creditNotes.detail.email.never")
    : creditNote.lastEmailAttemptOutcome === "sent"
      ? t("creditNotes.detail.email.sent", { date: formatDate(lastAttemptAt, locale, timezone) })
      : t("creditNotes.detail.email.failed", { date: formatDate(lastAttemptAt, locale, timezone) })

  return (
    <div className="p-6 max-w-3xl grid gap-6">
      <div className="flex items-center justify-between">
        {backLink}
        <Button variant="outline" size="sm" disabled={downloading} onClick={() => void handleDownload()}>
          <Download className="size-4" />
          {downloading ? t("creditNotes.action.downloading") : t("creditNotes.action.downloadPdf")}
        </Button>
      </div>

      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="text-sm text-muted-foreground" role="status">
          {notice}
        </p>
      )}

      <Card>
        <CardContent className="p-6 grid gap-6">
          <div className="flex items-start justify-between gap-4">
            <div className="grid gap-1">
              <h1 className="text-2xl font-bold">
                {t("creditNotes.detail.title", { number: creditNote.number })}
              </h1>
              <Link
                to="/invoices/$invoiceId"
                params={{ invoiceId: creditNote.invoice.id }}
                search={{ emailWarning: undefined }}
                className="text-sm text-muted-foreground underline-offset-4 hover:underline"
              >
                {t("creditNotes.detail.reference", { number: creditNote.invoice.number })}
              </Link>
            </div>
            <div className="text-right text-sm text-muted-foreground">
              <p>
                <span className="font-medium text-foreground">{t("pdf.issueDate")}:</span>{" "}
                {formatDate(creditNote.issueDate, locale, timezone)}
              </p>
              <p>
                <span className="font-medium text-foreground">{t("creditNotes.pdf.invoiceDate")}:</span>{" "}
                {formatDate(creditNote.invoice.issueDate, locale, timezone)}
              </p>
            </div>
          </div>

          <div>
            <h3 className="text-sm font-medium text-muted-foreground mb-1">{t("pdf.billTo")}</h3>
            <p className="font-semibold">{contact.name}</p>
            {contact.company && <p className="text-sm">{contact.company}</p>}
            {contact.email && <p className="text-sm text-muted-foreground">{contact.email}</p>}
            {contact.address && <p className="text-sm">{contact.address}</p>}
            {(contact.city || contact.state || contact.zip) && (
              <p className="text-sm">{[contact.city, contact.state, contact.zip].filter(Boolean).join(", ")}</p>
            )}
            {contact.country && <p className="text-sm">{contact.country}</p>}
          </div>

          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("pdf.description")}</TableHead>
                  <TableHead className="text-right w-[80px]">{t("pdf.qty")}</TableHead>
                  <TableHead className="text-right w-[120px]">{t("pdf.unitPrice")}</TableHead>
                  <TableHead className="text-right w-[120px]">{t("pdf.total")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {creditNote.items.map((item) => (
                  <TableRow key={item.id}>
                    <TableCell>{item.description}</TableCell>
                    <TableCell className="text-right">{item.quantity}</TableCell>
                    <TableCell className="text-right">{money(item.unitPrice)}</TableCell>
                    <TableCell className="text-right">{money(item.total)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          <div className="flex justify-end">
            <div className="w-64 grid gap-2 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">{t("pdf.subtotal")}</span>
                <span>{money(creditNote.subtotal)}</span>
              </div>
              {creditNote.taxAmount > 0 && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">{t("pdf.tax")}</span>
                  <span>{money(creditNote.taxAmount)}</span>
                </div>
              )}
              <div className="flex justify-between font-semibold text-base border-t pt-2">
                <span>{t("pdf.total")}</span>
                <span>{money(creditNote.total)}</span>
              </div>
            </div>
          </div>

          <div>
            <h3 className="text-sm font-medium text-muted-foreground mb-1">{t("creditNotes.detail.reason")}</h3>
            <p className="text-sm whitespace-pre-wrap">{creditNote.reason}</p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-4">
          <div className="grid gap-1.5">
            <CardTitle>{t("creditNotes.detail.email.title")}</CardTitle>
            <CardDescription>
              {!org.emailAvailable
                ? t("creditNotes.detail.email.unavailable")
                : !recipientValid
                  ? t("creditNotes.detail.email.noRecipient")
                  : emailStatus}
            </CardDescription>
          </div>
          {canSend && org.emailAvailable && recipientValid && (
            <Button size="sm" disabled={sending} onClick={() => void handleSend()}>
              <Mail className="size-4" />
              {sending
                ? t("creditNotes.action.sending")
                : lastAttemptAt
                  ? t("creditNotes.action.resend")
                  : t("creditNotes.action.send")}
            </Button>
          )}
        </CardHeader>
      </Card>
    </div>
  )
}
