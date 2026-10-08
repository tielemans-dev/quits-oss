import type { ReactNode } from "react"
import type { ClientActionItem, ClientActionPage } from "../../lib/client-actions/page"
import { itemRecordKind } from "../../lib/client-actions/item-kind"
import { formatCurrency, formatDate } from "../../lib/i18n/format"
import { useI18n } from "../../lib/i18n/react"
import { LocalizedDocument } from "../documents/localized-document"
import { PublicSellerHeader } from "../documents/public-seller-header"
import { Badge } from "../ui/badge"
import { Button } from "../ui/button"

export type ClientActionRef = { kind: "agreement" | "deliverable" | "invoice"; recordId: string }

const SECTIONS = ["agreement", "deliverable", "invoice"] as const

function money(amount: number, currency: string, locale: string) {
  try {
    return formatCurrency(amount, currency, locale)
  } catch {
    return `${amount.toFixed(2)} ${currency}`
  }
}

/**
 * The page a customer opens from a client action link, and the seller's preview of it: both are
 * this component fed by the same page builder. In a preview every control is inert, so looking at
 * it never decides or pays anything.
 */
export function ClientActionHub({
  page,
  preview = false,
  embedded = false,
  busyInvoiceId = null,
  gate,
  notice,
  hrefFor,
  downloadHref,
  onOpen,
  onPay,
}: {
  page: ClientActionPage
  preview?: boolean
  /** Shown inside the seller's app, which already has a page landmark. */
  embedded?: boolean
  busyInvoiceId?: string | null
  /** The email verification step, shown above the records when approving needs it. */
  gate?: ReactNode
  notice?: ReactNode
  hrefFor?: (ref: ClientActionRef) => string
  downloadHref?: (ref: ClientActionRef) => string
  onOpen?: (ref: ClientActionRef) => void
  onPay?: (invoiceId: string) => void
}) {
  const { t, locale } = useI18n()
  const sellerName = page.seller.name
  const Container = embedded ? "div" : "main"
  return (
    <Container className={`mx-auto grid w-full max-w-3xl min-w-0 gap-6 [overflow-wrap:anywhere] ${embedded ? "py-2" : "px-4 py-8 sm:py-12"}`}>
      <PublicSellerHeader seller={page.seller} />
      <header className="grid gap-1">
        <h1 className="text-2xl font-semibold sm:text-3xl">
          {sellerName ? t("clientActions.title", { seller: sellerName }) : t("clientActions.titleFallback")}
        </h1>
        <p className="text-muted-foreground">{t("clientActions.greeting", { name: page.recipientName })}</p>
        <p className="font-medium" data-testid="client-action-summary">
          {page.attention > 0
            ? t("clientActions.waiting", { count: page.attention })
            : t("clientActions.nothingWaiting")}
        </p>
      </header>
      {notice}
      {gate}
      {SECTIONS.map((kind) => {
        const items = page.items.filter((item) => itemRecordKind(item) === kind)
        if (items.length === 0) return null
        const headingId = `client-actions-${kind}`
        return (
          <section key={kind} aria-labelledby={headingId} className="grid gap-3">
            <h2 id={headingId} className="text-lg font-semibold">
              {t(`clientActions.section.${kind}`)}
            </h2>
            <ul className="grid gap-3">
              {items.map((item) => (
                <li key={`${item.kind}:${item.recordId}`}>
                  <ItemCard
                    item={item}
                    sellerName={sellerName}
                    preview={preview}
                    busy={busyInvoiceId === item.recordId}
                    href={hrefFor?.({ kind: itemRecordKind(item), recordId: item.recordId })}
                    download={downloadHref?.({ kind: itemRecordKind(item), recordId: item.recordId })}
                    onOpen={onOpen}
                    onPay={onPay}
                  />
                </li>
              ))}
            </ul>
          </section>
        )
      })}
      <p className="text-sm text-muted-foreground">
        {t("clientActions.availableUntil", { date: formatDate(page.expiresAt, locale, page.timezone, { month: "long" }) })}
      </p>
    </Container>
  )
}

function ItemCard({
  item,
  sellerName,
  preview,
  busy,
  href,
  download,
  onOpen,
  onPay,
}: {
  item: ClientActionItem
  sellerName: string | null
  preview: boolean
  busy: boolean
  href?: string
  download?: string
  onOpen?: (ref: ClientActionRef) => void
  onPay?: (invoiceId: string) => void
}) {
  const { t } = useI18n()
  const ref = { kind: itemRecordKind(item), recordId: item.recordId }
  const open = (label: string, variant: "default" | "outline" = "outline") =>
    preview || !href ? (
      <Button variant={variant} disabled className="w-full sm:w-auto">{label}</Button>
    ) : (
      <Button asChild variant={variant} className="w-full sm:w-auto">
        <a
          href={href}
          onClick={(event) => {
            if (!onOpen || event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return
            event.preventDefault()
            onOpen(ref)
          }}
        >
          {label}
        </a>
      </Button>
    )
  const downloadLink = (label: string) =>
    preview || !download ? (
      <span className="text-sm text-muted-foreground" aria-disabled="true">{label}</span>
    ) : (
      <a className="text-sm underline underline-offset-4" href={download} target="_blank" rel="noreferrer">
        {label}
      </a>
    )

  if (item.kind === "inactive") {
    return (
      <article className="grid gap-1 rounded-lg border border-dashed p-4" data-state={item.state}>
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="font-medium">{t(`clientActions.kind.${item.recordKind}`)}</h3>
          <Badge variant="outline">{t(`clientActions.state.${item.state}`)}</Badge>
        </div>
        <p className="text-sm text-muted-foreground">
          {item.state === "withdrawn"
            ? t("clientActions.withdrawn.description", { seller: sellerName ?? t("clientActions.theSender") })
            : t("clientActions.unavailable.description")}
        </p>
      </article>
    )
  }

  if (item.kind === "agreement") {
    const actionable = item.state === "open" && item.canApprove
    const calendar = (value: string) => formatDate(value, item.locale, "UTC", { month: "long" })
    return (
      <article className="grid gap-3 rounded-lg border p-4" data-state={item.state} data-actionable={actionable}>
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="font-medium">{[item.number, item.title].filter(Boolean).join(" · ")}</h3>
          <Badge variant={actionable ? "default" : "outline"}>
            {t(item.state === "open" && !item.canApprove ? "clientActions.state.agreement.review" : `clientActions.state.agreement.${item.state}`)}
          </Badge>
        </div>
        {item.state === "open" && item.expiresAt ? (
          <p className="text-sm text-muted-foreground">{t("clientActions.agreement.offerExpires", { date: calendar(item.expiresAt) })}</p>
        ) : null}
        {item.state === "accepted" && item.acceptedAt ? (
          <p className="text-sm text-muted-foreground">{t("clientActions.agreement.acceptedOn", { date: calendar(item.acceptedAt) })}</p>
        ) : null}
        <div className="flex flex-wrap items-center gap-3">
          {open(actionable ? t("clientActions.action.reviewAndDecide") : t("clientActions.action.review"), actionable ? "default" : "outline")}
          {item.download ? downloadLink(t("clientActions.action.downloadAgreement")) : null}
        </div>
      </article>
    )
  }

  if (item.kind === "deliverable") {
    const actionable = item.state === "awaiting" && item.canApprove
    return (
      <article className="grid gap-3 rounded-lg border p-4" data-state={item.state} data-actionable={actionable}>
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="font-medium">{item.title}</h3>
          <Badge variant={actionable ? "default" : "outline"}>
            {t(item.state === "awaiting" && !item.canApprove ? "clientActions.state.deliverable.review" : `clientActions.state.deliverable.${item.state}`)}
          </Badge>
        </div>
        <p className="text-sm text-muted-foreground">
          {t("clientActions.deliverable.agreement", { number: item.agreementNumber, title: item.agreementTitle })}
          {" · "}
          {t("clientActions.deliverable.revision", { revision: item.deliveryRevision })}
        </p>
        {item.state === "accepted" && item.acceptedRevision ? (
          <p className="text-sm text-muted-foreground">{t("clientActions.deliverable.signedRevision", { revision: item.acceptedRevision })}</p>
        ) : null}
        {item.state === "expired" || item.state === "unavailable" ? (
          <p className="text-sm text-muted-foreground">
            {t(item.state === "expired" ? "clientActions.deliverable.expired" : "clientActions.deliverable.unavailable", { seller: sellerName ?? t("clientActions.theSender") })}
          </p>
        ) : null}
        <div>{open(actionable ? t("clientActions.action.reviewAndSignOff") : t("clientActions.action.viewDelivery"), actionable ? "default" : "outline")}</div>
      </article>
    )
  }

  // Invoice. Money and dates follow the invoice's own language, as its payment page does.
  const amount = (value: number) => money(value, item.currency, item.locale)
  const payable = item.state === "payable"
  return (
    <article className="grid gap-3 rounded-lg border p-4" data-state={item.state} data-actionable={payable}>
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-medium">{item.number}</h3>
        <Badge variant={payable ? "default" : "outline"}>{t(`clientActions.state.invoice.${item.state}`)}</Badge>
        {item.overdue && (item.state === "payable" || item.state === "open") ? (
          <Badge variant="destructive">{t("clientActions.state.overdue")}</Badge>
        ) : null}
      </div>
      <p className="text-sm text-muted-foreground">
        {t("clientActions.invoice.total", { amount: amount(item.totalGross) })}
        {" · "}
        {t("clientActions.invoice.dueOn", { date: formatDate(item.dueDate, item.locale, item.timezone, { month: "short" }) })}
      </p>
      {item.amountPaid > 0 && (item.state === "payable" || item.state === "open") ? (
        <p className="text-sm text-muted-foreground">{t("clientActions.invoice.paidSoFar", { amount: amount(item.amountPaid) })}</p>
      ) : null}
      {item.amountCredited > 0 ? (
        <p className="text-sm text-muted-foreground">{t("clientActions.invoice.creditedAmount", { amount: amount(item.amountCredited) })}</p>
      ) : null}
      {item.state === "payable" || item.state === "open" ? (
        <p className="font-medium">{t("clientActions.invoice.balanceDue", { amount: amount(item.balanceDue) })}</p>
      ) : null}
      {item.state === "open" && item.canPay ? (
        <p className="text-sm text-muted-foreground">{t("clientActions.invoice.payUnavailable")}</p>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        {payable ? (
          <Button
            className="w-full sm:w-auto"
            disabled={preview || busy}
            onClick={() => onPay?.(item.recordId)}
          >
            {busy ? t("clientActions.action.paying") : t("clientActions.action.pay", { amount: amount(item.balanceDue) })}
          </Button>
        ) : null}
        {open(t("clientActions.action.viewInvoice"))}
        {item.download ? downloadLink(t("clientActions.action.downloadInvoice")) : null}
      </div>
    </article>
  )
}

/** A page shown in its own language: used for the hub, and for each record opened from it. */
export function InLocale({ locale, children }: { locale: string; children: ReactNode }) {
  return <LocalizedDocument locale={locale}>{children}</LocalizedDocument>
}
