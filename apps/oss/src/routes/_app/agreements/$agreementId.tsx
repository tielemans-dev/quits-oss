import { InvoiceDeliverables } from "../../../components/agreements/invoice-deliverables"
import { DeliverableControls } from "../../../components/agreements/deliverable-controls"
import { AgreementActions } from "../../../components/agreements/agreement-actions"
import { AcceptanceRecord } from "../../../components/agreements/acceptance-record"
import { ActivityList } from "../../../components/activity/activity-list"
import type { ActivityEntry } from "../../../lib/exports/activity"
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useEffect, useMemo, useState } from "react"
import { trpc } from "../../../trpc/client"
import { Button } from "../../../components/ui/button"
import { Badge } from "../../../components/ui/badge"
import { StatusBadge } from "../../../components/status-badge"
import { Card, CardContent, CardHeader, CardTitle } from "../../../components/ui/card"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "../../../components/ui/alert-dialog"
import { useI18n } from "../../../lib/i18n/react"
import { formatCurrency, formatDate } from "../../../lib/i18n/format"
import { renderAgreementMarkdown } from "../../../lib/agreements/markdown"

export const Route = createFileRoute("/_app/agreements/$agreementId")({
  component: AgreementDetail,
})
function AgreementDetail() {
  const { agreementId } = Route.useParams()
  const { t, locale } = useI18n()
  const navigate = useNavigate()
  const [agreement, setAgreement] = useState<Awaited<
    ReturnType<typeof trpc.agreements.get.query>
  > | null>(null)
  const [capabilities, setCapabilities] = useState<Awaited<
    ReturnType<typeof trpc.agreements.capabilities.query>
  > | null>(null)
  const [events, setEvents] = useState<ActivityEntry[]>([])
  const [publicLink, setPublicLink] = useState<string | null>(null)
  async function refresh() {
    const [data, activity, link] = await Promise.all([
      trpc.agreements.get.query({ id: agreementId }),
      trpc.activity.forDocument.query({
        aggregateType: "agreement",
        aggregateId: agreementId,
      }),
      trpc.agreements.publicLink.query({ id: agreementId }),
    ])
    setAgreement(data)
    setEvents(activity.events)
    setPublicLink(link?.url ?? null)
  }
  const [error, setError] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  useEffect(() => {
    let cancelled = false
    Promise.all([
      trpc.agreements.get.query({ id: agreementId }),
      trpc.agreements.capabilities.query(),
      trpc.activity.forDocument.query({
        aggregateType: "agreement",
        aggregateId: agreementId,
      }),
      trpc.agreements.publicLink.query({ id: agreementId }),
    ])
      .then(([data, access, activity, link]) => {
        if (cancelled) return
        setAgreement(data)
        setCapabilities(access)
        setEvents(activity.events)
        setPublicLink(link?.url ?? null)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : t("agreements.error"))
      })
    return () => {
      cancelled = true
    }
  }, [agreementId, t])
  const preview = useMemo(() => {
    if (!agreement) return { html: "", error: null }
    if (agreement.offerSnapshot)
      return {
        html: (agreement.offerSnapshot as { termsHtml: string }).termsHtml,
        error: null,
      }
    const seller = agreement.sellerSnapshot as {
      companyName?: string | null
    } | null
    const buyer = agreement.buyerSnapshot as { name?: string } | null
    try {
      return {
        html: renderAgreementMarkdown(agreement.termsMarkdown, {
          "seller.name": seller?.companyName ?? "",
          "buyer.name": buyer?.name ?? "",
          "agreement.title": agreement.title,
          "agreement.validUntil": agreement.validUntil.toISOString().slice(0, 10),
          "agreement.total": `${agreement.total.toFixed(2)} ${agreement.currency}`,
          deliverables: agreement.deliverables
            .map((line) => `${line.title}: ${line.description}`)
            .join("\n"),
        }),
        error: null,
      }
    } catch (err) {
      return {
        html: "",
        error: err instanceof Error ? err.message : t("agreements.error"),
      }
    }
  }, [agreement, t])
  async function remove() {
    setDeleting(true)
    try {
      await trpc.agreements.deleteDraft.mutate({ id: agreementId })
      await navigate({ to: "/agreements" })
    } catch (err) {
      setError(err instanceof Error ? err.message : t("agreements.error"))
      setDeleting(false)
    }
  }
  if (!agreement)
    return (
      <div className="p-6">{error ? <p role="alert">{error}</p> : t("agreements.loading")}</div>
    )
  return (
    <div className="p-6 max-w-4xl grid gap-6">
      <Link to="/agreements" className="text-sm underline">
        {t("agreements.back")}
      </Link>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      <div className="flex items-start justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-semibold">{agreement.title}</h1>
          <StatusBadge domain="agreement" status={agreement.status} />
        </div>
        <div className="flex gap-2 flex-wrap">
          {agreement.status === "draft" && capabilities?.update && (
            <>
              <Button asChild variant="outline">
                <Link to="/agreements/$agreementId/edit" params={{ agreementId }}>
                  {t("agreements.edit")}
                </Link>
              </Button>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    variant="destructive"
                    disabled={
                      deleting ||
                      !capabilities?.delete ||
                      agreement.lastEmailAttemptOutcome === "sending"
                    }
                  >
                    {t("agreements.delete")}
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>{t("agreements.delete")}</AlertDialogTitle>
                    <AlertDialogDescription>{t("agreements.deleteConfirm")}</AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>{t("agreements.cancel")}</AlertDialogCancel>
                    <AlertDialogAction onClick={remove}>{t("agreements.delete")}</AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </>
          )}
        </div>
      </div>
      {capabilities && (
        <AgreementActions
          agreement={agreement}
          capabilities={capabilities}
          onChanged={refresh}
          onError={setError}
        />
      )}
      {publicLink && (
        <p className="break-all">
          <a href={publicLink} target="_blank" rel="noreferrer" className="underline">
            {t("agreements.shareLink")}
          </a>
          {!agreement.issuedToEmail && (
            <span className="block text-sm text-muted-foreground">
              {t("agreements.shareManually")}
            </span>
          )}
        </p>
      )}
      {agreement.acceptedAt && (
        <AcceptanceRecord
          record={{
            name: agreement.acceptedByName,
            intendedRecipient: agreement.issuedToEmail,
            at: agreement.acceptedAt.toISOString(),
            method: agreement.acceptanceMethod,
            revision: agreement.acceptedOfferRevision,
            hash: agreement.offerSnapshotHash,
          }}
        />
      )}
      {agreement.acceptanceEvidenceNote && (
        <p>
          {t("agreements.evidenceNote")}: {agreement.acceptanceEvidenceNote}
        </p>
      )}
      {agreement.status === "accepted" && capabilities?.invoice && <InvoiceDeliverables key={agreement.id} agreement={agreement} onChanged={refresh} />}
      <Card>
        <CardContent className="pt-6 grid gap-3">
          <p>
            {t("agreements.customer")}: {agreement.contact.name}
          </p>
          <p>
            {t("agreements.validUntil")}: {formatDate(agreement.validUntil, locale, "UTC")}
          </p>
          <p className="whitespace-pre-wrap">{agreement.summary}</p>
          <p>
            {t(agreement.offerFormatVersion === 2 ? "agreements.serviceTotal" : "agreements.total")}: {formatCurrency(agreement.total, agreement.currency, locale)}
          </p>
          <p>
            {t("agreements.dueInDays")}: {agreement.dueInDays}
          </p>
          <p>
            {t("agreements.billingTrigger")}:{" "}
            {t(
              agreement.billingTrigger === "on_delivery"
                ? "agreements.onDelivery"
                : "agreements.onAcceptance",
            )}
          </p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{t("agreements.deliverables")}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4">
          <section aria-label={t("agreements.progress")} className="flex flex-wrap gap-3 text-sm">
            {(
              [
                "planned",
                "in_progress",
                "delivered",
                "accepted",
                "changes_requested",
                "cancelled",
              ] as const
            ).map((status) => (
              <p key={status}>
                {t(`agreements.fulfillment.${status}`)}: {agreement.progress[status]}
              </p>
            ))}
            <p>
              {t("agreements.deposits")}: {agreement.progress.deposits}
            </p>
          </section>
          {agreement.deliverables.length === 0 && <p>{t("agreements.noLines")}</p>}
          {agreement.deliverables.map((line) => (
            <div
              key={line.id}
              role="group"
              aria-label={line.title}
              className="border-b pb-3 last:border-0"
            >
              <h3 className="font-medium">{line.title}</h3>
              <p className="whitespace-pre-wrap text-sm text-muted-foreground">
                {line.description}
              </p>
              <p>{formatCurrency(line.lineGross, agreement.currency, locale)}</p>
              <StatusBadge domain="deliverableBilling" status={line.billingStatus} />
              {line.agreedDate && (
                <p className="text-sm">
                  {t("agreements.agreedDate")}: {formatDate(line.agreedDate, locale, "UTC")}
                </p>
              )}
              {line.expectedDate && (
                <p className="text-sm">
                  {t("agreements.expectedDate")}: {formatDate(line.expectedDate, locale, "UTC")}
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                {line.isDeposit && <Badge variant="outline">{t(agreement.offerFormatVersion === 2 ? "agreements.scheduleLine" : "agreements.deposit")}</Badge>}
                <StatusBadge domain="deliverable" status={line.status} />
              </div>
              {!line.isDeposit && (
                <p className="text-sm">
                  {t("agreements.deliveryRevision")}: {line.deliveryRevision}
                </p>
              )}
              {line.acceptedAt && (
                <div className="text-sm">
                  <p>
                    {t("agreements.acceptedAt")}: {line.acceptedAt.toLocaleString(locale)}
                  </p>
                  <p>
                    {t("agreements.acceptedRevision")}: {line.acceptedRevision}
                  </p>
                  <p>
                    {t("agreements.method")}:{" "}
                    {line.acceptedVia === "internal"
                      ? t("agreements.internalMethod")
                      : line.acceptedVia === "customer_link"
                        ? t("agreements.customerLinkMethod")
                        : t("agreements.unspecified")}
                  </p>
                  {line.acceptanceEvidenceNote && <p>
                    {t("agreements.evidenceNote")}: {line.acceptanceEvidenceNote}
                  </p>}
                </div>
              )}
              {capabilities && (
                <DeliverableControls
                  key={`${line.id}:${line.expectedDate?.toISOString() ?? ""}`}
                  agreement={agreement}
                  line={line}
                  capabilities={capabilities}
                  onChanged={refresh}
                  onError={setError}
                />
              )}
            </div>
          ))}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{t("agreements.terms")}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground mb-4">{t("agreements.legalNotice")}</p>
          {preview.error ? (
            <p role="alert">{preview.error}</p>
          ) : (
            <div
              className="space-y-3 break-words"
              dangerouslySetInnerHTML={{ __html: preview.html }}
            />
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{t("activity.panel.title")}</CardTitle>
        </CardHeader>
        <CardContent>
          <ActivityList events={events} />
        </CardContent>
      </Card>
      {agreement.notes && (
        <Card>
          <CardHeader>
            <CardTitle>{t("agreements.notes")}</CardTitle>
          </CardHeader>
          <CardContent className="whitespace-pre-wrap">{agreement.notes}</CardContent>
        </Card>
      )}
    </div>
  )
}
