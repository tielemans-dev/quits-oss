import { useState } from "react"
import type { ClientActionRequest } from "@quits/contracts/client-actions"
import type { ClientActionDetail } from "../../lib/client-actions/page"
import type { PublicSeller } from "../../lib/documents/public-presentation"
import { formatDate } from "../../lib/i18n/format"
import { useI18n } from "../../lib/i18n/react"
import { PublicAgreementPage } from "../agreements/public-agreement-page"
import { PublicInvoicePaymentPage } from "../invoices/public-invoice-payment-page"
import { Badge } from "../ui/badge"
import { Button } from "../ui/button"
import { Label } from "../ui/label"
import { Textarea } from "../ui/textarea"

/** Sends one action; resolves true when it was carried out. */
export type PerformAction = (request: ClientActionRequest) => Promise<boolean>

/**
 * One record opened from the client action page. The agreement and the invoice are the pages the
 * customer already knows, embedded; every action goes through the page's own grant check.
 */
export function AgreementDetail({
  detail,
  seller,
  token,
  verified,
  perform,
  pdfHref,
  error,
}: {
  detail: Extract<ClientActionDetail, { kind: "agreement" }>
  seller: PublicSeller
  token: string
  verified: boolean
  perform: PerformAction
  pdfHref: string
  error: string | null
}) {
  const [name, setName] = useState("")
  const [confirmed, setConfirmed] = useState(false)
  const [reason, setReason] = useState("")
  const [busy, setBusy] = useState(false)
  // A signature waits for a verified recipient: the terms stay readable, the controls stay away.
  const scope = detail.canDecide && verified ? "decide" : "read"
  return (
    <PublicAgreementPage
      embedded
      seller={seller}
      document={detail.document}
      scope={scope}
      token={token}
      pdfHref={detail.download ? pdfHref : undefined}
      name={name}
      onNameChange={setName}
      confirmed={confirmed}
      onConfirmedChange={setConfirmed}
      reason={reason}
      onReasonChange={setReason}
      busy={busy}
      error={error}
      onDecision={(verb) => {
        setBusy(true)
        const revision = detail.document.offerRevision
        const request: ClientActionRequest =
          verb === "accept"
            ? { type: "agreement.accept", agreementId: detail.recordId, offerRevision: revision, acceptedByName: name, confirmed: true }
            : { type: "agreement.decline", agreementId: detail.recordId, offerRevision: revision, reason: reason || undefined }
        void perform(request).finally(() => setBusy(false))
      }}
    />
  )
}

export function DeliverableDetail({
  detail,
  perform,
  error,
  verified,
  approvalsNeedVerification,
  sellerName,
}: {
  detail: Extract<ClientActionDetail, { kind: "deliverable" }>
  perform: PerformAction
  error: string | null
  verified: boolean
  approvalsNeedVerification: boolean
  sellerName: string | null
}) {
  const { t, locale } = useI18n()
  const line = detail.deliverable
  const [note, setNote] = useState("")
  const [confirmed, setConfirmed] = useState(false)
  const [busy, setBusy] = useState(false)
  // Agreed and expected dates are calendar dates: shown as stored, not shifted by a timezone.
  const calendarDate = (value: string) => formatDate(value, locale, "UTC")
  const canAct = detail.canDecide && line.status === "delivered" && (verified || !approvalsNeedVerification)
  async function submit(request: ClientActionRequest) {
    setBusy(true)
    try {
      await perform(request)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="grid gap-6 [overflow-wrap:anywhere]">
      <header className="grid gap-2">
        <p>
          {t("agreements.document")} {line.agreementNumber}: {line.agreementTitle}
        </p>
        <h2 className="text-3xl font-semibold">{line.title}</h2>
        <Badge variant="outline" className="w-fit">
          {t(`clientActions.state.deliverable.${detail.state}`)}
        </Badge>
      </header>
      <p className="whitespace-pre-wrap">{line.description}</p>
      <p>
        {t("agreements.deliveryRevision")}: {line.deliveryRevision}
      </p>
      {line.agreedDate && <p>{t("agreements.agreedDate")}: {calendarDate(line.agreedDate)}</p>}
      {line.expectedDate && <p>{t("agreements.expectedDate")}: {calendarDate(line.expectedDate)}</p>}
      {line.acceptedAt && <p>{t("agreements.acceptedRevision")}: {line.acceptedRevision}</p>}
      {line.changeRequestNote && (
        <section>
          <h3 className="font-medium">{t("agreements.changeRequestNote")}</h3>
          <p className="whitespace-pre-wrap">{line.changeRequestNote}</p>
        </section>
      )}
      {detail.state === "expired" || detail.state === "unavailable" ? (
        <p className="text-sm text-muted-foreground">
          {t(detail.state === "expired" ? "clientActions.deliverable.expired" : "clientActions.deliverable.unavailable", { seller: sellerName ?? t("clientActions.theSender") })}
        </p>
      ) : null}
      {error && <p role="alert" className="text-destructive">{error}</p>}
      {detail.canDecide && line.status === "delivered" && !canAct ? (
        <p className="text-sm text-muted-foreground">{t("clientActions.gate.required")}</p>
      ) : null}
      {canAct ? (
        <>
          <form
            className="grid gap-3"
            onSubmit={(event) => {
              event.preventDefault()
              void submit({ type: "deliverable.accept", deliverableId: detail.recordId, deliveryRevision: line.deliveryRevision, confirmed: true })
            }}
          >
            <label className="flex items-start gap-2">
              <input type="checkbox" checked={confirmed} disabled={busy} onChange={(event) => setConfirmed(event.target.checked)} />
              {t("agreements.confirmDelivery")}
            </label>
            <Button disabled={busy || !confirmed} className="w-full sm:w-auto">{t("agreements.acceptDelivery")}</Button>
          </form>
          <form
            className="grid gap-3"
            onSubmit={(event) => {
              event.preventDefault()
              void submit({ type: "deliverable.request_changes", deliverableId: detail.recordId, deliveryRevision: line.deliveryRevision, note })
            }}
          >
            <Label htmlFor="change-request-note">{t("agreements.changeRequestNote")}</Label>
            <Textarea id="change-request-note" value={note} maxLength={5000} required disabled={busy} onChange={(event) => setNote(event.target.value)} />
            <Button variant="outline" disabled={busy || !note.trim()} className="w-full sm:w-auto">{t("agreements.requestChanges")}</Button>
          </form>
        </>
      ) : null}
    </div>
  )
}

export function InvoiceDetail({
  detail,
  token,
  paying,
  onPay,
  error,
  downloadHref,
}: {
  detail: Extract<ClientActionDetail, { kind: "invoice" }>
  token: string
  paying: boolean
  onPay: () => void
  error: string | null
  downloadHref: string
}) {
  const { t } = useI18n()
  return (
    <div className="grid gap-4">
      <PublicInvoicePaymentPage
        embedded
        token={token}
        state={{ kind: "ready", ...detail.session }}
        onPay={onPay}
        submitting={paying}
        error={error}
      />
      {detail.download ? (
        <a className="text-sm underline underline-offset-4" href={downloadHref} target="_blank" rel="noreferrer">
          {t("clientActions.action.downloadInvoice")}
        </a>
      ) : null}
    </div>
  )
}
