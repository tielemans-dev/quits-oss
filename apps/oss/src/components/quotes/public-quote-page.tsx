import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "../ui/card"
import { Button } from "../ui/button"
import { Textarea } from "../ui/textarea"

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
  locale?: string | null
}

export type PublicQuotePageState =
  | { kind: "invalid" }
  | {
      kind: "ready"
      decisionState: "pending" | "accepted" | "rejected"
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
  if (state.kind === "invalid") {
    return (
      <div className="mx-auto flex min-h-screen max-w-3xl items-center justify-center px-4 py-12">
        <Card className="w-full max-w-lg">
          <CardHeader>
            <CardTitle>Quote unavailable</CardTitle>
            <CardDescription>
              This quote link is invalid or has expired.
            </CardDescription>
          </CardHeader>
        </Card>
      </div>
    )
  }

  const { quote, decisionState } = state
  const sellerName = quote.sellerSnapshot?.companyName ?? "Quits"
  const decisionAt = quote.publicDecisionAt ? formatDate(quote.publicDecisionAt) : null

  return (
    <div className="mx-auto flex min-h-screen max-w-5xl items-center px-4 py-12">
      <div className="grid w-full gap-6 lg:grid-cols-[1.35fr_0.9fr]">
        <Card>
          <CardHeader>
            <CardTitle>{quote.number}</CardTitle>
            <CardDescription>
              Quote from {sellerName}
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-6">
            <div className="grid gap-4 sm:grid-cols-3">
              <InfoBlock label="Status" value={statusLabel(decisionState)} />
              <InfoBlock label="Issued" value={formatDate(quote.issueDate)} />
              <InfoBlock label="Valid until" value={formatDate(quote.expiryDate)} />
            </div>

            <div className="grid gap-3">
              <h2 className="text-sm font-medium text-muted-foreground">Quote summary</h2>
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
                          {toNumber(item.quantity)} x{" "}
                          {formatCurrency(toNumber(item.unitPriceGross), quote.currency)}
                        </p>
                      </div>
                      <p className="font-medium">
                        {formatCurrency(toNumber(item.lineGross), quote.currency)}
                      </p>
                    </div>
                  ))}
              </div>
            </div>

            {quote.notes ? (
              <div className="grid gap-2">
                <h2 className="text-sm font-medium text-muted-foreground">Notes</h2>
                <p className="whitespace-pre-wrap text-sm">{quote.notes}</p>
              </div>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>
              {decisionState === "accepted"
                ? "Quote accepted"
                : decisionState === "rejected"
                  ? "Quote rejected"
                  : "Review this quote"}
            </CardTitle>
            <CardDescription>
              {decisionState === "pending"
                ? "Confirm whether you want to accept or reject this quote."
                : decisionAt
                  ? `Decision recorded on ${decisionAt}.`
                  : "This quote is no longer actionable."}
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-6">
            {error ? (
              <p className="text-sm text-destructive" role="alert">
                {error}
              </p>
            ) : null}

            <div className="grid gap-4 rounded-lg border p-4">
              <InfoBlock label="Customer" value={quote.contact.name} />
              <InfoBlock
                label="Company"
                value={quote.contact.company ?? quote.buyerSnapshot?.company ?? "Not provided"}
              />
              <InfoBlock
                label="Total"
                value={formatCurrency(toNumber(quote.totalGross), quote.currency)}
              />
            </div>

            {decisionState === "pending" ? (
              <div className="grid gap-4">
                <div className="grid gap-2">
                  <label className="text-sm font-medium" htmlFor="publicQuoteRejectionReason">
                    Rejection reason (optional)
                  </label>
                  <Textarea
                    id="publicQuoteRejectionReason"
                    value={rejectionReason}
                    onChange={(event) => onRejectionReasonChange?.(event.target.value)}
                    placeholder="Tell the sender why this quote does not work for you."
                    rows={4}
                  />
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Button type="button" disabled={submitting} onClick={onAccept}>
                    Accept quote
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={submitting}
                    onClick={onReject}
                  >
                    Reject quote
                  </Button>
                </div>
              </div>
            ) : null}

            {decisionState === "rejected" && quote.publicRejectionReason ? (
              <div className="grid gap-2 rounded-lg border border-dashed p-4">
                <p className="text-sm font-medium">Rejection reason</p>
                <p className="text-sm text-muted-foreground">{quote.publicRejectionReason}</p>
              </div>
            ) : null}
          </CardContent>
          <CardFooter className="justify-between text-sm text-muted-foreground">
            <span>{sellerName}</span>
            <span>{formatCurrency(toNumber(quote.totalGross), quote.currency)}</span>
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

function statusLabel(state: "pending" | "accepted" | "rejected") {
  if (state === "accepted") return "Accepted"
  if (state === "rejected") return "Rejected"
  return "Pending"
}
