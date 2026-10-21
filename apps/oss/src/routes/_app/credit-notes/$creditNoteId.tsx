import { useQueryRevision } from "../../../hooks/use-query-refresh"
import { QueryError, QuerySkeleton } from "../../../components/query-state"
import { sellerVatLineLabel, sellerVatPresentationStatus } from "../../../lib/documents/seller-vat"
import { nonVatStatement } from "../../../lib/documents/non-vat-note"
import { withoutNonVatStatement } from "../../../lib/documents/non-vat-presentation"
import { createFileRoute, Link } from "@tanstack/react-router"
import { useCallback, useEffect, useRef, useState } from "react"
import { ArrowLeft, Download, Mail } from "lucide-react"
import { parseBuyerSnapshot, parseSellerSnapshot } from "@quits/contracts/documents"
import { handledMutationError } from "../../../lib/query-refresh"
import { trpc } from "../../../trpc/client"
import { usePollWhile } from "../../../hooks/use-poll-while"
import { useDocumentResponseGuard } from "../../../hooks/use-document-response-guard"
import { ReloadRequiredNotice } from "../../../components/documents/reload-required-notice"
import { useActiveOrganizationId } from "../../../lib/active-organization"
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
import { StatusBadge } from "../../../components/status-badge"
import { DocumentTotals } from "../../../components/documents/document-totals"
import { InvoiceSellerDetails } from "../../../components/invoices/invoice-payment-instructions"
import { detailBuyerAddress } from "../../../lib/documents/buyer-address"
import { distinctCompany } from "../../../lib/documents/tax-ids"
import { lineColumnKeys } from "../../../lib/documents/line-amounts"
import { localizeInvoiceQuantity } from "../../../lib/invoice-quantity"

/** Owned by the credit notes feature. */
export const Route = createFileRoute("/_app/credit-notes/$creditNoteId")({
  component: CreditNoteDetailPage,
})

type OrgContext = OrgSettingsForPdf & { emailAvailable: boolean }

function isValidEmailAddress(email: string | null | undefined) {
  return Boolean(email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()))
}

async function downloadPdf(creditNote: CreditNoteDetail, _org: OrgSettingsForPdf) {
  const { downloadDocumentPdf } = await import("../../../lib/documents-download")
  await downloadDocumentPdf("creditNote", creditNote.id, creditNote.number)
}

function CreditNoteDetailPage() {
  const { t, locale } = useI18n()
  const { creditNoteId } = Route.useParams()
  const query = useQueryRevision(["creditNotes", "settings"])
  const [loadError, setLoadError] = useState<unknown>(null)
  const [creditNote, setCreditNote] = useState<CreditNoteDetail | null>(null)
  const [org, setOrg] = useState<OrgContext>({ emailAvailable: false })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ kind: "info" | "warning"; text: string } | null>(null)
  const [sending, setSending] = useState(false)
  const [issuing, setIssuing] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [canCreate, setCanCreate] = useState(false)
  const [canSend, setCanSend] = useState(false)
  // Keyed on the active organization so capabilities refresh after switching organization.
  const organizationId = useActiveOrganizationId()
  const latestLoad = useRef(0)
  // The page stays mounted when navigating to another credit note; drop answers for the previous one.
  const beginRequest = useDocumentResponseGuard(creditNoteId)

  /**
   * Loads the credit note with what the user may do. Commits nothing once the page shows another
   * credit note (it stays mounted when navigating between them) or a newer load started.
   */
  const load = useCallback(async () => {
    const request = ++latestLoad.current
    const isCurrent = beginRequest(creditNoteId)
    const [data, context] = await Promise.all([
      trpc.creditNotes.get.query({ id: creditNoteId }),
      Promise.allSettled([
        trpc.settings.get.query(),
        trpc.creditNotes.capabilities.query(),
      ]),
    ])
    // A late answer for another credit note, or from before an organization switch, must not
    // replace what is on screen or restore old rights.
    if (request !== latestLoad.current || !isCurrent()) return
    setCreditNote(data)
    const [settingsResult, capabilitiesResult] = context
    setCanCreate(capabilitiesResult.status === "fulfilled" && capabilitiesResult.value.canCreate)
    setCanSend(capabilitiesResult.status === "fulfilled" && capabilitiesResult.value.canSend)
    if (settingsResult.status === "fulfilled") {
      const settings = settingsResult.value
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
    } else {
      setOrg({ emailAvailable: false })
    }
    if (context.some(result => result.status === "rejected")) setError(t("creditNotes.error.generic"))
  }, [beginRequest, creditNoteId, t])

  /** Reloads only the credit note; a full load started meanwhile wins. */
  const refreshCreditNote = useCallback(async () => {
    const request = latestLoad.current
    const isCurrent = beginRequest(creditNoteId)
    const data = await trpc.creditNotes.get.query({ id: creditNoteId })
    if (request !== latestLoad.current || !isCurrent()) return
    setCreditNote(data)
  }, [beginRequest, creditNoteId])

  // While the outbox is still delivering the email, follow it until it settles.
  const emailSending = creditNote?.lastEmailAttemptOutcome === "sending"
  const pollFailure = usePollWhile(emailSending, refreshCreditNote)

  // Another credit note (or organization) keeps the page mounted, so start over with nothing
  // allowed and nothing reported about the previous one.
  useEffect(() => {
    setLoadError(null)
    setCanCreate(false)
    setCanSend(false)
    setError(null)
    if (organizationId === undefined) return
    const isCurrent = beginRequest(creditNoteId)
    load()
      .catch((err: unknown) => {
        if (!isCurrent()) return
        const code = (err as { data?: { code?: string } } | null)?.data?.code
        if (code === "NOT_FOUND") { setCreditNote(null); setError(t("creditNotes.detail.notFound")) } else setLoadError(err)
      })
      .finally(() => {
        if (isCurrent()) setLoading(false)
      })
  }, [beginRequest, creditNoteId, load, t, organizationId, query.revision])

  useEffect(() => { setNotice(null); setSending(false); setIssuing(false) }, [creditNoteId, organizationId])

  async function handleSend() {
    if (!creditNote) return
    // The answer is only reported while this credit note is still on screen.
    const isCurrent = beginRequest(creditNote.id)
    setSending(true)
    setError(null)
    setNotice(null)
    try {
      const result = await trpc.creditNotes.send.mutate({ id: creditNote.id }, handledMutationError)
      if (!isCurrent()) return
      if (result.delivery === "pending") {
        setNotice({ kind: "info", text: t("creditNotes.detail.email.pending", { email: result.recipient }) })
      } else if (result.delivery === "unconfirmed") {
        setNotice({
          kind: "warning",
          text: t("creditNotes.detail.email.unconfirmed", {
            date: formatDate(result.attemptedAt ?? new Date(), locale, creditNote.timezone),
          }),
        })
      } else {
        setNotice({ kind: "info", text: t("creditNotes.detail.email.success", { email: result.recipient }) })
      }
    } catch (err) {
      if (!isCurrent()) return
      setError(err instanceof Error ? err.message : t("creditNotes.error.generic"))
    } finally {
      if (isCurrent()) {
        setSending(false)
        await load().catch(() => undefined)
      }
    }
  }

  async function handleDraft(action: "issueDraft" | "discardDraft") {
    if (!creditNote || sending) return
    const isCurrent = beginRequest(creditNote.id)
    setSending(true); setIssuing(action === "issueDraft"); setError(null)
    try {
      await trpc.creditNotes[action].mutate({ id: creditNote.id }, handledMutationError)
    } catch (err) { if (isCurrent()) setError(err instanceof Error ? err.message : t("creditNotes.error.generic")) }
    finally {
      // Issuance can commit before the answer is lost, so show what was stored either way.
      if (isCurrent()) {
        await load().catch(() => undefined)
        setSending(false); setIssuing(false)
      }
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

  if (loadError) return <QueryError error={loadError} retry={query.refresh} />

  if (loading) {
    return (
      <div>
        <QuerySkeleton />
      </div>
    )
  }

  if (!creditNote) {
    return (
      <div className="grid gap-4 justify-items-start">
        {backLink}
        <p className="text-sm text-destructive" role="alert">
          {error ?? t("creditNotes.detail.notFound")}
        </p>
      </div>
    )
  }

  const timezone = creditNote.timezone
  const money = (value: number) => formatCurrency(value, creditNote.currency, locale)
  const momsRegistered = sellerVatPresentationStatus(parseSellerSnapshot(creditNote.sellerSnapshot)?.momsRegistered, creditNote.taxRegime)
  const buyer = parseBuyerSnapshot(creditNote.buyerSnapshot)
  const contact = { ...creditNote.contact, ...buyer, name: buyer?.name ?? creditNote.contact.name }
  const recipientValid = isValidEmailAddress(creditNote.contact.email)
  const lastAttemptAt = creditNote.lastEmailAttemptAt
  const lastOutcome = creditNote.lastEmailAttemptOutcome
  const emailStatus = !lastAttemptAt
    ? t("creditNotes.detail.email.never")
    : lastOutcome === "sent"
      ? t("creditNotes.detail.email.sent", { date: formatDate(lastAttemptAt, locale, timezone) })
      : lastOutcome === "sending"
        ? t("creditNotes.detail.email.sending")
        : lastOutcome === "unconfirmed"
          ? t("creditNotes.detail.email.unconfirmed", { date: formatDate(lastAttemptAt, locale, timezone) })
          : t("creditNotes.detail.email.failed", { date: formatDate(lastAttemptAt, locale, timezone) })

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-6">
      <div className="flex items-center justify-between">
        {backLink}
        <Button variant="outline" size="sm" disabled={downloading || creditNote.status !== "issued"} onClick={() => void handleDownload()}>
          <Download className="size-4" />
          {downloading ? t("creditNotes.action.downloading") : t("creditNotes.action.downloadPdf")}
        </Button>
      </div>

      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
      <ReloadRequiredNotice failure={pollFailure} />
      {notice && (
        <p
          className={
            notice.kind === "warning" ? "text-sm text-tone-warning" : "text-sm text-muted-foreground"
          }
          role="status"
        >
          {notice.text}
        </p>
      )}

      {creditNote.status === "draft" && <div className="grid gap-3">
        <p>{t("creditNotes.request.draftHint")}</p>
        {canCreate && <div className="flex gap-2">
          <Button disabled={sending} onClick={() => void handleDraft("issueDraft")}>{issuing ? t("creditNotes.action.issuing") : t("creditNotes.action.issue")}</Button>
          <Button variant="outline" disabled={sending} onClick={() => void handleDraft("discardDraft")}>{t("creditNotes.action.cancel")}</Button>
        </div>}
      </div>}
      <Card>
        <CardContent className="p-6 grid grid-cols-[minmax(0,1fr)] gap-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="grid gap-1">
              <h1 className="text-2xl font-bold">
                {t("creditNotes.detail.title", { number: creditNote.number })}
              </h1>
              <StatusBadge domain="creditNote" status={creditNote.status} />
              <Link
                to="/invoices/$invoiceId"
                params={{ invoiceId: creditNote.invoice.id }}
                search={{ emailWarning: undefined }}
                className="text-sm text-muted-foreground underline-offset-4 hover:underline"
              >
                {t("creditNotes.detail.reference", { number: creditNote.invoice.number ?? "" })}
              </Link>
            </div>
            <div className="text-left text-sm sm:text-right text-muted-foreground">
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

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
            <InvoiceSellerDetails status={creditNote.status} sellerSnapshot={creditNote.sellerSnapshot} />
            <div>
              <h3 className="text-sm font-medium text-muted-foreground mb-1">{t("pdf.billTo")}</h3>
              <p className="font-semibold">{contact.name}</p>
              {distinctCompany(contact) && <p className="text-sm">{distinctCompany(contact)}</p>}
              {contact.email && <p className="text-sm text-muted-foreground">{contact.email}</p>}
              {detailBuyerAddress(contact, creditNote.countryCode, locale).map((line, index) => <p key={index} className="text-sm">{line}</p>)}
            </div>
          </div>

          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("pdf.description")}</TableHead>
                  <TableHead className="hidden w-[80px] text-right sm:table-cell">{t("pdf.qty")}</TableHead>
                  <TableHead className="hidden w-[140px] text-right sm:table-cell">{t(lineColumnKeys(creditNote.priceBasis).unitPrice)}</TableHead>
                  <TableHead className="text-right w-[140px]">{t(lineColumnKeys(creditNote.priceBasis).amount)}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {creditNote.items.map((item) => (
                  <TableRow key={item.id}>
                    <TableCell className="whitespace-normal">
                      {item.description}
                      <p className="num mt-1 text-xs text-muted-foreground sm:hidden">
                        {t("public.document.lineQuantity", { quantity: localizeInvoiceQuantity(String(item.quantity), locale), price: money(item.displayUnitPrice ?? item.unitPrice) })}
                      </p>
                      {sellerVatLineLabel(momsRegistered, item.taxRate, locale) && <p className="mt-1 text-xs text-muted-foreground">{sellerVatLineLabel(momsRegistered, item.taxRate, locale)}</p>}
                    </TableCell>
                    <TableCell className="hidden text-right num sm:table-cell">{item.quantity}</TableCell>
                    <TableCell className="hidden text-right num sm:table-cell">{money(item.displayUnitPrice ?? item.unitPrice)}</TableCell>
                    <TableCell className="text-right num">{money(item.displayAmount ?? item.total)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          <div className="flex justify-end">
            <div className="w-full sm:w-80 grid gap-2 text-sm">
              <DocumentTotals priceBasis={creditNote.priceBasis} subtotal={creditNote.subtotal} taxAmount={creditNote.taxAmount} total={creditNote.total} vatRows={creditNote.vatRows} rounding={creditNote.rounding} currency={creditNote.currency} taxRegime={creditNote.taxRegime} />
            </div>
          </div>

          <div>
            <h3 className="text-sm font-medium text-muted-foreground mb-1">{t("creditNotes.detail.reason")}</h3>
            {momsRegistered === false && <p className="mb-4 text-sm text-muted-foreground">{nonVatStatement(locale)}</p>}
            <p className="text-sm whitespace-pre-wrap">{withoutNonVatStatement(creditNote.reason, momsRegistered, creditNote.taxRegime)}</p>
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
          {creditNote.status === "issued" && canSend && org.emailAvailable && recipientValid && (
            // A queued email settles on its own; sending again is refused meanwhile.
            <Button size="sm" disabled={sending || emailSending} onClick={() => void handleSend()}>
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
