import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "../ui/card"
import { Button } from "../ui/button"
import { Textarea } from "../ui/textarea"
import { PublicSellerHeader } from "../documents/public-seller-header"
import { useDocumentFormat } from "../documents/use-document-format"
import type { PublicSeller } from "../../lib/documents/public-presentation"
import { useI18n } from "../../lib/i18n/react"

type Decimalish = number | { toNumber(): number }

type PublicQuoteContact = {
  name: string
  email: string | null
  company: string | null
}

type PublicQuoteItem = {
  id: string
  description: string
  quantity: Decimalish
  unitPriceGross: Decimalish
  lineGross: Decimalish
  sortOrder: number
}

type PublicQuote = {
  id: string
  number: string
  status: string
  issueDate: Date | string
  expiryDate: Date | string
  totalGross: Decimalish
  totalTax: Decimalish
  subtotalNet: Decimalish
  currency: string
  /** The timezone the document's dates are shown in, as its PDF and email do. */
  timezone: string
  notes: string | null
  sellerSnapshot: {
    companyName?: string | null
    companyEmail?: string | null
    companyAddress?: string | null
  } | null
  buyerSnapshot: {
    name?: string | null
    email?: string | null
    company?: string | null
  } | null
  publicDecisionAt: Date | string | null
  publicRejectionReason: string | null
  contact: PublicQuoteContact
  items: PublicQuoteItem[]
  invoices: Array<{ id: string; number: string; status: string }>
}

export type PublicQuotePageState =
  | { kind: "invalid" }
  | {
      kind: "ready"
      decisionState: "pending" | "accepted" | "rejected"
      /** Who the quote is from: shown at the top of the page. */
      seller: PublicSeller
      quote: PublicQuote
    }

export function PublicQuotePage({
  state,
  rejectionReason = "",
  onRejectionReasonChange,
  onAccept,
  onReject,
  submitting = false,
  error,
}: {
  token: string
  state: PublicQuotePageState
  rejectionReason?: string
  onRejectionReasonChange?: (value: string) => void
  onAccept?: () => void
  onReject?: () => void
  submitting?: boolean
  error?: string | null
}) {
  const { t } = useI18n()

  if (state.kind === "invalid") {
    return (
      <div className="mx-auto flex min-h-screen max-w-3xl items-center justify-center px-4 py-12">
        <Card className="w-full max-w-lg">
          <CardHeader>
            <CardTitle>{t("public.quote.unavailable.title")}</CardTitle>
            <CardDescription>{t("public.quote.unavailable.description")}</CardDescription>
          </CardHeader>
        </Card>
      </div>
    )
  }

  return (
    <PublicQuoteDocument
      state={state}
      rejectionReason={rejectionReason}
      onRejectionReasonChange={onRejectionReasonChange}
      onAccept={onAccept}
      onReject={onReject}
      submitting={submitting}
      error={error}
    />
  )
}

function PublicQuoteDocument({
  state,
  rejectionReason,
  onRejectionReasonChange,
  onAccept,
  onReject,
  submitting,
  error,
}: {
  state: Extract<PublicQuotePageState, { kind: "ready" }>
  rejectionReason: string
  onRejectionReasonChange?: (value: string) => void
  onAccept?: () => void
  onReject?: () => void
  submitting: boolean
  error?: string | null
}) {
  const { t } = useI18n()
  const { quote, decisionState, seller } = state
  const format = useDocumentFormat(quote.timezone)
  const money = (amount: number) => format.money(amount, quote.currency)
  const decisionAt = quote.publicDecisionAt ? format.date(quote.publicDecisionAt) : null

  return (
    <div className="mx-auto flex min-h-screen max-w-5xl flex-col justify-center gap-6 px-4 py-12">
      <PublicSellerHeader seller={seller} />
      <div className="grid w-full gap-6 lg:grid-cols-[1.35fr_0.9fr]">
        <Card>
          <CardHeader>
            <CardTitle>{quote.number}</CardTitle>
            <CardDescription>
              {seller.name
                ? t("public.quote.from", { seller: seller.name })
                : t("public.quote.label")}
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-6">
            <div className="grid gap-4 sm:grid-cols-3">
              <InfoBlock
                label={t("public.document.status")}
                value={t(`public.quote.status.${decisionState}`)}
              />
              <InfoBlock label={t("public.quote.issued")} value={format.date(quote.issueDate)} />
              <InfoBlock
                label={t("public.quote.validUntil")}
                value={format.calendarDate(quote.expiryDate)}
              />
            </div>

            <div className="grid gap-3">
              <h2 className="text-sm font-medium text-muted-foreground">
                {t("public.quote.summary")}
              </h2>
              <div className="rounded-lg border">
                {quote.items
                  .slice()
                  .sort((left, right) => left.sortOrder - right.sortOrder)
                  .map((item) => (
                    <div
                      key={item.id}
                      className="grid grid-cols-[1fr_auto] gap-4 border-b px-4 py-3 last:border-b-0"
                    >
                      <div>
                        <p className="font-medium">{item.description}</p>
                        <p className="text-sm text-muted-foreground">
                          {t("public.document.lineQuantity", {
                            quantity: format.number(toNumber(item.quantity)),
                            price: money(toNumber(item.unitPriceGross)),
                          })}
                        </p>
                      </div>
                      <p className="font-medium">{money(toNumber(item.lineGross))}</p>
                    </div>
                  ))}
              </div>
            </div>

            {quote.notes ? (
              <div className="grid gap-2">
                <h2 className="text-sm font-medium text-muted-foreground">{t("public.document.notes")}</h2>
                <p className="whitespace-pre-wrap text-sm">{quote.notes}</p>
              </div>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t(`public.quote.decision.${decisionState}.title`)}</CardTitle>
            <CardDescription>
              {decisionState === "pending"
                ? t("public.quote.decision.pending.description")
                : decisionAt
                  ? t("public.quote.decision.recorded", { date: decisionAt })
                  : t("public.quote.decision.closed")}
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-6">
            {error ? (
              <p className="text-sm text-destructive" role="alert">
                {error}
              </p>
            ) : null}

            <div className="grid gap-4 rounded-lg border p-4">
              <InfoBlock label={t("public.document.customer")} value={quote.contact.name} />
              <InfoBlock
                label={t("public.document.company")}
                value={
                  quote.contact.company ??
                  quote.buyerSnapshot?.company ??
                  t("public.document.notProvided")
                }
              />
              <InfoBlock label={t("public.document.total")} value={money(toNumber(quote.totalGross))} />
            </div>

            {decisionState === "pending" ? (
              <div className="grid gap-4">
                <div className="grid gap-2">
                  <label className="text-sm font-medium" htmlFor="publicQuoteRejectionReason">
                    {t("public.quote.rejectionReason.label")}
                  </label>
                  <Textarea
                    id="publicQuoteRejectionReason"
                    value={rejectionReason}
                    onChange={(event) => onRejectionReasonChange?.(event.target.value)}
                    placeholder={t("public.quote.rejectionReason.placeholder")}
                    rows={4}
                  />
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Button type="button" disabled={submitting} onClick={onAccept}>
                    {t("public.quote.action.accept")}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={submitting}
                    onClick={onReject}
                  >
                    {t("public.quote.action.reject")}
                  </Button>
                </div>
              </div>
            ) : null}

            {decisionState === "rejected" && quote.publicRejectionReason ? (
              <div className="grid gap-2 rounded-lg border border-dashed p-4">
                <p className="text-sm font-medium">{t("public.quote.rejectionReason.recorded")}</p>
                <p className="text-sm text-muted-foreground">{quote.publicRejectionReason}</p>
              </div>
            ) : null}
          </CardContent>
          <CardFooter className="justify-between text-sm text-muted-foreground">
            <span>{seller.name}</span>
            <span>{money(toNumber(quote.totalGross))}</span>
          </CardFooter>
        </Card>
      </div>
    </div>
  )
}

function InfoBlock({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-1">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <p className="text-sm font-medium">{value}</p>
    </div>
  )
}

function toNumber(value: Decimalish) {
  return typeof value === "number" ? value : value.toNumber()
}
