import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useEffect, useMemo, useState } from "react"
import { trpc } from "../../../trpc/client"
import { Button } from "../../../components/ui/button"
import { Badge } from "../../../components/ui/badge"
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
  const [error, setError] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  useEffect(() => {
    let cancelled = false
    trpc.agreements.get
      .query({ id: agreementId })
      .then((data) => {
        if (!cancelled) setAgreement(data)
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
    const seller = agreement.sellerSnapshot as { companyName?: string | null } | null
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
      return { html: "", error: err instanceof Error ? err.message : t("agreements.error") }
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
          <Badge variant="secondary">
            {agreement.status === "draft" ? t("agreements.draft") : agreement.status}
          </Badge>
        </div>
        <div className="flex gap-2 flex-wrap">
          {agreement.status === "draft" && (
            <>
              <Button asChild variant="outline">
                <Link to="/agreements/$agreementId/edit" params={{ agreementId }}>
                  {t("agreements.edit")}
                </Link>
              </Button>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="destructive" disabled={deleting}>
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
          <div className="grid gap-1">
            <Button disabled aria-describedby="sending-later">
              {t("agreements.send")}
            </Button>
            <p id="sending-later" className="text-xs text-muted-foreground">
              {t("agreements.sendingLater")}
            </p>
          </div>
        </div>
      </div>
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
            {t("agreements.total")}: {formatCurrency(agreement.total, agreement.currency, locale)}
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
          {agreement.deliverables.length === 0 && <p>{t("agreements.noLines")}</p>}
          {agreement.deliverables.map((line) => (
            <div key={line.id} className="border-b pb-3 last:border-0">
              <h3 className="font-medium">{line.title}</h3>
              <p className="whitespace-pre-wrap text-sm text-muted-foreground">
                {line.description}
              </p>
              <p>{formatCurrency(line.lineGross, agreement.currency, locale)}</p>
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
              {line.isDeposit && <Badge variant="outline">{t("agreements.deposit")}</Badge>}
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
