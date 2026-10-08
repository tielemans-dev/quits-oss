import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "../ui/card"
import { Button } from "../ui/button"
import { PublicSellerHeader } from "../documents/public-seller-header"
import { useDocumentFormat } from "../documents/use-document-format"
import type { PublicSeller } from "../../lib/documents/public-presentation"
import { useI18n } from "../../lib/i18n/react"

type Decimalish = number | { toNumber(): number }

type PublicInvoiceContact = {
  name: string
  email: string | null
  company: string | null
}

type PublicInvoiceItem = {
  id: string
  description: string
  quantity: Decimalish
  unitPriceGross: Decimalish
  lineGross: Decimalish
  sortOrder: number
}

type PublicInvoice = {
  id: string
  number: string
  status: string
  paymentStatus: string
  issueDate: Date | string
  dueDate: Date | string
  totalGross: Decimalish
  /** Payments received so far. Defaults to nothing paid. */
  amountPaid?: number
  /** Credit notes issued against the invoice. Defaults to none. */
  amountCredited?: number
  /** What the customer still owes. Defaults to the invoice total. */
  balanceDue?: number
  totalTax: Decimalish
  subtotalNet: Decimalish
  currency: string
  /** The timezone the document's dates are shown in, as its PDF does. */
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
  contact: PublicInvoiceContact
  items: PublicInvoiceItem[]
}

export type PublicInvoicePaymentPageState =
  | { kind: "invalid" }
  | {
      kind: "ready"
      paymentState: "unpaid" | "paid"
      stripeEnabled: boolean
      /** Who the invoice is from: shown at the top of the page. */
      seller: PublicSeller
      invoice: PublicInvoice
    }

export function PublicInvoicePaymentPage({
  state,
  onPay,
  submitting = false,
  error,
}: {
  token: string
  state: PublicInvoicePaymentPageState
  onPay?: () => void
  submitting?: boolean
  error?: string | null
}) {
  const { t } = useI18n()

  if (state.kind === "invalid") {
    return (
      <div className="mx-auto flex min-h-screen max-w-3xl items-center justify-center px-4 py-12">
        <Card className="w-full max-w-lg">
          <CardHeader>
            <CardTitle>{t("public.invoice.unavailable.title")}</CardTitle>
            <CardDescription>{t("public.invoice.unavailable.description")}</CardDescription>
          </CardHeader>
        </Card>
      </div>
    )
  }

  return <PublicInvoiceDocument state={state} onPay={onPay} submitting={submitting} error={error} />
}

function PublicInvoiceDocument({
  state,
  onPay,
  submitting,
  error,
}: {
  state: Extract<PublicInvoicePaymentPageState, { kind: "ready" }>
  onPay?: () => void
  submitting: boolean
  error?: string | null
}) {
  const { t } = useI18n()
  const { invoice, paymentState, seller } = state
  const format = useDocumentFormat(invoice.timezone)
  const money = (amount: number) => format.money(amount, invoice.currency)
  const total = toNumber(invoice.totalGross)
  const amountPaid = invoice.amountPaid ?? 0
  const amountCredited = invoice.amountCredited ?? 0
  const balanceDue = paymentState === "paid" ? 0 : (invoice.balanceDue ?? total)
  const partiallySettled = paymentState === "unpaid" && (amountPaid > 0 || amountCredited > 0)
  // Credited in full: nothing is owed, so the page says so instead of "Payment received".
  const credited = invoice.status === "credited"
  const statusLabel = credited
    ? t("status.credited")
    : paymentState === "paid"
      ? t("status.paid")
      : amountPaid > 0
        ? t("status.partially_paid")
        : t("public.invoice.status.open")

  return (
    <div className="mx-auto flex min-h-screen max-w-5xl flex-col justify-center gap-6 px-4 py-12">
      <PublicSellerHeader seller={seller} />
      <div className="grid w-full gap-6 lg:grid-cols-[1.35fr_0.9fr]">
        <Card>
          <CardHeader>
            <CardTitle>{invoice.number}</CardTitle>
            <CardDescription>
              {seller.name
                ? t("public.invoice.from", { seller: seller.name })
                : t("public.invoice.label")}
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-6">
            <div className="grid gap-4 sm:grid-cols-3">
              <InfoBlock label={t("public.document.status")} value={statusLabel} />
              <InfoBlock label={t("public.invoice.issued")} value={format.date(invoice.issueDate)} />
              <InfoBlock label={t("public.invoice.due")} value={format.date(invoice.dueDate)} />
            </div>

            <div className="grid gap-3">
              <h2 className="text-sm font-medium text-muted-foreground">
                {t("public.invoice.summary")}
              </h2>
              <div className="rounded-lg border">
                {invoice.items
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
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>
              {credited
                ? t("public.invoice.credited.title")
                : paymentState === "paid"
                  ? t("public.invoice.paid.title")
                  : t("public.invoice.pay.title")}
            </CardTitle>
            <CardDescription>
              {credited
                ? t("public.invoice.credited.description")
                : paymentState === "paid"
                  ? t("public.invoice.paid.description")
                  : t("public.invoice.pay.description")}
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-6">
            {error ? (
              <p className="text-sm text-destructive" role="alert">
                {error}
              </p>
            ) : null}

            <div className="grid gap-4 rounded-lg border p-4">
              <InfoBlock label={t("public.document.customer")} value={invoice.contact.name} />
              <InfoBlock
                label={t("public.document.company")}
                value={
                  invoice.contact.company ??
                  invoice.buyerSnapshot?.company ??
                  t("public.document.notProvided")
                }
              />
              <InfoBlock label={t("pdf.total")} value={money(total)} />
              {credited ? (
                <InfoBlock label={t("public.invoice.credited")} value={money(amountCredited)} />
              ) : null}
              {partiallySettled && amountPaid > 0 ? (
                <InfoBlock label={t("public.invoice.paid")} value={money(amountPaid)} />
              ) : null}
              {partiallySettled && amountCredited > 0 ? (
                <InfoBlock label={t("public.invoice.credited")} value={money(amountCredited)} />
              ) : null}
              {paymentState === "unpaid" ? (
                <InfoBlock label={t("public.invoice.balanceDue")} value={money(balanceDue)} />
              ) : null}
            </div>

            {paymentState === "unpaid" ? (
              state.stripeEnabled ? (
                <Button type="button" disabled={submitting} onClick={onPay}>
                  {t("public.invoice.pay.action")}
                </Button>
              ) : (
                <p className="text-sm text-muted-foreground">
                  {t("public.invoice.pay.unavailable")}
                </p>
              )
            ) : null}
          </CardContent>
          <CardFooter className="justify-between text-sm text-muted-foreground">
            <span>{seller.name}</span>
            <span>{money(paymentState === "paid" && !credited ? total : balanceDue)}</span>
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
