import type { PublicAgreementDto } from "../../lib/agreements/public"
import { useI18n } from "../../lib/i18n/react"
import { formatCurrency } from "../../lib/i18n/format"
import { Button } from "../ui/button"
import { Input } from "../ui/input"
import { Label } from "../ui/label"
import { Textarea } from "../ui/textarea"
import { AcceptanceRecord } from "./acceptance-record"

export function PublicAgreementPage({
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
  const { t } = useI18n()
  const { snapshot } = document
  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-12 grid min-w-0 gap-6 [overflow-wrap:anywhere]">
      <header>
        <p className="text-sm text-muted-foreground">
          {t("agreements.document")} {document.number}
        </p>
        <h1 className="text-3xl font-semibold">{snapshot.title}</h1>
        <p>{document.status}</p>
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
          {t("agreements.validUntil")}: {snapshot.validUntil.slice(0, 10)} ({snapshot.timezone})
        </p>
      </section>
      <section className="grid gap-4">
        <h2 className="text-xl font-semibold">{t("agreements.deliverables")}</h2>
        {snapshot.deliverables.map((line, i) => (
          <div key={i} className="border-b pb-3">
            <h3 className="font-medium">{line.title}</h3>
            <p className="whitespace-pre-wrap">{line.description}</p>
            <p>
              {line.quantity} x {line.unitPriceGross} ={" "}
              {formatCurrency(Number(line.lineGross), snapshot.currency, snapshot.locale)}
            </p>
            {line.agreedDate && (
              <p>
                {t("agreements.agreedDate")}: {line.agreedDate.slice(0, 10)}
              </p>
            )}
            {document.expectedDates[i] && (
              <p>
                {t("agreements.expectedDate")}: {document.expectedDates[i]!.slice(0, 10)}
              </p>
            )}
            {line.isDeposit && <p>{t("agreements.deposit")}</p>}
          </div>
        ))}
        <p>
          {t("agreements.subtotal")}:{" "}
          {formatCurrency(Number(snapshot.subtotalNet), snapshot.currency, snapshot.locale)}
        </p>
        <p>
          {t("agreements.tax")}:{" "}
          {formatCurrency(Number(snapshot.totalTax), snapshot.currency, snapshot.locale)}
        </p>
        <p>
          {t("agreements.total")}:{" "}
          {formatCurrency(Number(snapshot.totalGross), snapshot.currency, snapshot.locale)}
        </p>
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
