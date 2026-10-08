import type { z } from "zod"
import { agreementStatusSchema } from "@quits/contracts/agreements"
import { agreementOfferTotals } from "../../lib/agreements/offer-totals"
import type { PublicAgreementDto } from "../../lib/agreements/public"
import type { PublicSeller } from "../../lib/documents/public-presentation"
import type { TranslationKey } from "../../lib/i18n/messages"
import { useI18n } from "../../lib/i18n/react"
import { formatCurrency, formatDate, formatNumber } from "../../lib/i18n/format"
import { PublicSellerHeader } from "../documents/public-seller-header"
import { Button } from "../ui/button"
import { Input } from "../ui/input"
import { Label } from "../ui/label"
import { Textarea } from "../ui/textarea"
import { AcceptanceRecord } from "./acceptance-record"

export function PublicAgreementPage({
  seller,
  document,
  scope,
  token,
  name,
  onNameChange,
  confirmed,
  onConfirmedChange,
  reason,
  onReasonChange,
  onDecision,
  busy,
  error,
}: {
  seller: PublicSeller
  document: PublicAgreementDto
  scope: "read" | "decide"
  token: string
  name: string
  onNameChange: (value: string) => void
  confirmed: boolean
  onConfirmedChange: (value: boolean) => void
  reason: string
  onReasonChange: (value: string) => void
  onDecision: (verb: "accept" | "decline") => void
  busy: boolean
  error: string | null
}) {
  const { t, locale } = useI18n()
  const { snapshot } = document
  const v2 = "offerFormatVersion" in snapshot ? snapshot : null
  const totals = agreementOfferTotals(snapshot)
  // Money and dates follow the language the page is shown in, which is the offer's own locale.
  const money = (amount: string) => formatCurrency(Number(amount), snapshot.currency, locale)
  // Validity, agreed and expected dates are calendar dates: shown as stored, not shifted by a timezone.
  const calendarDate = (value: string) => formatDate(value, locale, "UTC")
  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-12 grid min-w-0 gap-6 [overflow-wrap:anywhere]">
      <PublicSellerHeader seller={seller} />
      <header>
        <p className="text-sm text-muted-foreground">
          {t("agreements.document")} {document.number}
        </p>
        <h1 className="text-3xl font-semibold">{snapshot.title}</h1>
        <p>{agreementStatusLabel(document.status, t)}</p>
      </header>
      <section className="grid gap-2">
        <p>{snapshot.sellerSnapshot?.companyName}</p>
        <p>{snapshot.sellerSnapshot?.companyAddress}</p>
        <p>
          {t("agreements.customer")}: {snapshot.buyerSnapshot?.name}{" "}
          {snapshot.buyerSnapshot?.company}
        </p>
        <p className="whitespace-pre-wrap">{snapshot.summary}</p>
        <p>
          {t("agreements.validUntil")}: {calendarDate(snapshot.validUntil)} ({snapshot.timezone})
        </p>
      </section>
      <section className="grid gap-4">
        <h2 className="text-xl font-semibold">{t("agreements.deliverables")}</h2>
        {snapshot.deliverables.map((line, i) => v2 && line.isDeposit ? null : (
          <div key={i} className="border-b pb-3">
            <h3 className="font-medium">{line.title}</h3>
            <p className="whitespace-pre-wrap">{line.description}</p>
            <p>
              {t("public.document.lineQuantity", {
                quantity: formatNumber(Number(line.quantity), locale),
                price: money(line.unitPriceGross),
              })}{" "}
              = {money(line.lineGross)}
            </p>
            {line.agreedDate && (
              <p>
                {t("agreements.agreedDate")}: {calendarDate(line.agreedDate)}
              </p>
            )}
            {document.expectedDates[i] && (
              <p>
                {t("agreements.expectedDate")}: {calendarDate(document.expectedDates[i]!)}
              </p>
            )}
            {line.isDeposit && <p>{t("agreements.deposit")}</p>}
          </div>
        ))}
        <p>
          {t("agreements.subtotal")}:{" "}
          {money(totals.net)}
        </p>
        <p>
          {t("agreements.tax")}:{" "}
          {money(totals.tax)}
        </p>
        {totals.payableRounding && <p>{t("agreements.payableRounding")}: {money(totals.payableRounding)}</p>}
        <p>
          {t(totals.isV2 ? "agreements.serviceTotal" : "agreements.total")}:{" "}
          {money(totals.gross)}
        </p>
        {v2 && <section className="grid gap-3">
          <h2 className="text-xl font-semibold">{t("agreements.paymentSchedule")}</h2>
          {v2.paymentSchedule.map(line => <div key={line.sortOrder} className="border-b pb-3">
            <h3 className="font-medium">{line.title}</h3>
            <p>{money(line.amount)} {t(line.vatBasis === "gross" ? "agreements.vatBasis.gross" : "agreements.vatBasis.net")}</p>
            <p>{t("agreements.scheduleTrigger")}</p>
          </div>)}
        </section>}
        <p>{t("agreements.paymentDue", { days: snapshot.dueInDays })}</p>
        <p>
          {t("agreements.billingTrigger")}:{" "}
          {t(
            snapshot.billingTrigger === "on_acceptance"
              ? "agreements.onAcceptance"
              : "agreements.onDelivery",
          )}
        </p>
      </section>
      <section className="grid gap-3">
        <h2 className="text-xl font-semibold">{t("agreements.publicTerms")}</h2>
        <div
          className="space-y-3 min-w-0 break-words [&_pre]:whitespace-pre-wrap [&_table]:block [&_table]:overflow-x-auto"
          dangerouslySetInnerHTML={{ __html: snapshot.termsHtml }}
        />
      </section>
      <AcceptanceRecord record={document.acceptance} />
      <a
        href={`/a/${encodeURIComponent(token)}/pdf`}
        target="_blank"
        rel="noreferrer"
        className="underline"
      >
        {t("agreements.pdf")}
      </a>
      {scope === "decide" && document.status === "sent" && (
        <section className="grid gap-4 rounded-md border p-4">
          <Label htmlFor="accepted-name">{t("agreements.signerName")}</Label>
          <Input
            id="accepted-name"
            value={name}
            onChange={(event) => onNameChange(event.target.value)}
            maxLength={200}
            required
          />
          <Label className="flex items-start gap-3">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(event) => onConfirmedChange(event.target.checked)}
            />
            {t("agreements.confirmTerms")}
          </Label>
          <Button
            disabled={busy || !name.trim() || !confirmed}
            onClick={() => onDecision("accept")}
          >
            {t("agreements.accept")}
          </Button>
          <Label htmlFor="decline-reason">{t("agreements.declineReason")}</Label>
          <Textarea
            id="decline-reason"
            value={reason}
            maxLength={5000}
            onChange={(event) => onReasonChange(event.target.value)}
          />
          <Button variant="outline" disabled={busy} onClick={() => onDecision("decline")}>
            {t("agreements.decline")}
          </Button>
        </section>
      )}
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
    </main>
  )
}

/**
 * Typed against the contract's status enum: a new status without a label fails typecheck here
 * instead of reaching the page as a raw stored value.
 */
const AGREEMENT_STATUS_LABELS = {
  draft: "public.agreement.status.draft",
  sent: "public.agreement.status.sent",
  accepted: "public.agreement.status.accepted",
  declined: "public.agreement.status.declined",
  expired: "public.agreement.status.expired",
  completed: "public.agreement.status.completed",
  cancelled: "public.agreement.status.cancelled",
} as const satisfies Record<z.infer<typeof agreementStatusSchema>, TranslationKey>

function agreementStatusLabel(status: string, t: ReturnType<typeof useI18n>["t"]) {
  const known = agreementStatusSchema.safeParse(status)
  // A stored value the contract does not know (a newer row read by an older page) stays visible.
  return known.success ? t(AGREEMENT_STATUS_LABELS[known.data]) : status
}
