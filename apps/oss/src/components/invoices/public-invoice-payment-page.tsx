import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "../ui/card"
import { Button } from "../ui/button"

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
  if (state.kind === "invalid") {
    return (
      <div className="mx-auto flex min-h-screen max-w-3xl items-center justify-center px-4 py-12">
        <Card className="w-full max-w-lg">
          <CardHeader>
            <CardTitle>Invoice unavailable</CardTitle>
            <CardDescription>
              This invoice payment link is invalid or has expired.
            </CardDescription>
          </CardHeader>
        </Card>
      </div>
    )
  }

  const { invoice, paymentState } = state
  const sellerName = invoice.sellerSnapshot?.companyName ?? "Quits"
  const total = toNumber(invoice.totalGross)
  const amountPaid = invoice.amountPaid ?? 0
  const amountCredited = invoice.amountCredited ?? 0
  const balanceDue = paymentState === "paid" ? 0 : (invoice.balanceDue ?? total)
  const partiallySettled = paymentState === "unpaid" && (amountPaid > 0 || amountCredited > 0)
  // Credited in full: nothing is owed, so the page says so instead of "Payment received".
  const credited = invoice.status === "credited"
  const statusLabel = credited
    ? "Credited"
    : paymentState === "paid"
      ? "Paid"
      : amountPaid > 0
        ? "Partially paid"
        : "Open"

  return (
    <div className="mx-auto flex min-h-screen max-w-5xl items-center px-4 py-12">
      <div className="grid w-full gap-6 lg:grid-cols-[1.35fr_0.9fr]">
        <Card>
          <CardHeader>
            <CardTitle>{invoice.number}</CardTitle>
            <CardDescription>Invoice from {sellerName}</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-6">
            <div className="grid gap-4 sm:grid-cols-3">
              <InfoBlock label="Status" value={statusLabel} />
              <InfoBlock label="Issued" value={formatDate(invoice.issueDate)} />
              <InfoBlock label="Due" value={formatDate(invoice.dueDate)} />
            </div>

            <div className="grid gap-3">
              <h2 className="text-sm font-medium text-muted-foreground">Invoice summary</h2>
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
                          {toNumber(item.quantity)} x{" "}
                          {formatCurrency(toNumber(item.unitPriceGross), invoice.currency)}
                        </p>
                      </div>
                      <p className="font-medium">
                        {formatCurrency(toNumber(item.lineGross), invoice.currency)}
                      </p>
                    </div>
                  ))}
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>
              {credited ? "Invoice credited" : paymentState === "paid" ? "Payment received" : "Pay this invoice"}
            </CardTitle>
            <CardDescription>
              {credited
                ? "This invoice has been credited in full. Nothing is due."
                : paymentState === "paid"
                  ? "This invoice has already been settled."
                  : "Review the balance due and continue to secure checkout."}
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-6">
            {error ? (
              <p className="text-sm text-destructive" role="alert">
                {error}
              </p>
            ) : null}

            <div className="grid gap-4 rounded-lg border p-4">
              <InfoBlock label="Customer" value={invoice.contact.name} />
              <InfoBlock
                label="Company"
                value={invoice.contact.company ?? invoice.buyerSnapshot?.company ?? "Not provided"}
              />
              <InfoBlock label="Total" value={formatCurrency(total, invoice.currency)} />
              {credited ? (
                <InfoBlock label="Credited" value={formatCurrency(amountCredited, invoice.currency)} />
              ) : null}
              {partiallySettled && amountPaid > 0 ? (
                <InfoBlock label="Paid" value={formatCurrency(amountPaid, invoice.currency)} />
              ) : null}
              {partiallySettled && amountCredited > 0 ? (
                <InfoBlock label="Credited" value={formatCurrency(amountCredited, invoice.currency)} />
              ) : null}
              {paymentState === "unpaid" ? (
                <InfoBlock label="Balance due" value={formatCurrency(balanceDue, invoice.currency)} />
              ) : null}
            </div>

            {paymentState === "unpaid" ? (
              state.stripeEnabled ? (
                <Button type="button" disabled={submitting} onClick={onPay}>
                  Pay now
                </Button>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Online payment is not available for this invoice.
                </p>
              )
            ) : null}
          </CardContent>
          <CardFooter className="justify-between text-sm text-muted-foreground">
            <span>{sellerName}</span>
            <span>
              {formatCurrency(paymentState === "paid" && !credited ? total : balanceDue, invoice.currency)}
            </span>
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

function formatCurrency(amount: number, currency: string) {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      maximumFractionDigits: 2,
    }).format(amount)
  } catch {
    return `${amount.toFixed(2)} ${currency}`
  }
}

function formatDate(value: Date | string) {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) {
    return "Unknown"
  }

  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(date)
}
