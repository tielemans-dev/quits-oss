import { useAppQuery } from "../../../hooks/use-query-refresh"
import { QueryError } from "../../../components/query-state"
import { EMAIL_SEND_FAILED_PARAM } from "../../../lib/email-send-failure"
import { InvoiceFlow, InvoiceDetailPanel, useInvoiceMorph } from "../../../components/invoices/flow"
import type { CreatedDocumentTarget } from "../../../lib/create-and-send"
import { createFileRoute, Link } from "@tanstack/react-router"
import { InvoiceListSummary } from "../../../components/invoices/list-summary"
import { useState, useRef } from "react"
import { useCalendarDate } from "../../../hooks/use-calendar-date"
import { trpc } from "../../../trpc/client"
import { formatDate as formatDateIntl } from "../../../lib/i18n/format"
import { Button } from "../../../components/ui/button"
import { Amount } from "../../../components/kvit/amount"
import {
  decimalFromNumber,
  formatAmountText,
} from "../../../components/kvit/amount-format"
import { CustomerMark } from "../../../components/kvit/customer-mark"
import {
  ListBody,
  ListCell,
  ListEmpty,
  ListHead,
  ListHeadCell,
  ListRow,
  ListSkeleton,
  ListTable,
  listRowLinkClass,
  rowActionsClass,
} from "../../../components/kvit/list"
import { PageHeader } from "../../../components/kvit/page-header"
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
import { Plus, Trash2 } from "lucide-react"
import { cn } from "../../../lib/utils"
import { useI18n } from "../../../lib/i18n/react"
import { invoiceDisplayStatus } from "../../../lib/payments/invoice-display-status"
import { PILL_STAGGER_MS, SwappingStatusBadge } from "../../../components/jobs/swapping-status-badge"
import { useReminderJobs } from "../../../components/jobs/reminder-jobs-store"
import { remindedInvoiceIds } from "../../../lib/jobs/reminder-tracker"

export const Route = createFileRoute("/_app/invoices/")({
  component: InvoicesListPage,
})

type Invoice = {
  id: string
  /** Null until the invoice is sent. */
  number: string | null
  status: string
  paymentStatus: string
  lastEmailAttemptOutcome: string | null
  issueDate: string
  dueDate: string
  total: number
  balanceDue: number
  currency: string
  contact: { name: string }
}

function formatDate(dateStr: string, locale?: string) {
  return formatDateIntl(dateStr, locale, undefined, { month: "short" })
}

function InvoicesListPage() {
  const { t, locale } = useI18n()
  const list = useAppQuery(["invoices", "settings"], async () => {
    const [invoices, settings] = await Promise.all([trpc.invoices.list.query(), trpc.settings.get.query().catch(() => ({ timezone: null }))])
    return { invoices: invoices as unknown as Invoice[], timezone: settings.timezone }
  })
  const invoices = list.data?.invoices ?? []
  const loadInvoices = list.refresh
  const origin = useRef<DOMRect | undefined>(undefined)
  const [flowOpen, setFlowOpen] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [notice, setNotice] = useState<CreatedDocumentTarget | null>(null)
  const [fresh, setFresh] = useState<string | null>(null)
  const toast = useInvoiceMorph(notice, origin.current)
  function completed(target: CreatedDocumentTarget) {
    origin.current = document.querySelector(".invoice-preview-side")?.getBoundingClientRect()
    setFlowOpen(false)
    setNotice(target)
    setFresh(target.id)
  }
  const summaryQuery = useAppQuery(["dashboard"], () => trpc.dashboard.summary.query())
  const summary = summaryQuery.data
  const loading = list.loading
  const timezone = list.data?.timezone ?? null
  const today = useCalendarDate(timezone)
  const [deleting, setDeleting] = useState<string | null>(null)
  const reminded = remindedInvoiceIds(useReminderJobs())
  // Rows whose pill changes together fade one after another, top to bottom.
  const stagger = new Map<string, number>()
  for (const invoice of invoices) if (reminded.has(invoice.id)) stagger.set(invoice.id, stagger.size)

  async function handleDelete(id: string) {
    setDeleting(id)
    try {
      await trpc.invoices.delete.mutate({ id })

    } catch {
      // Silently fail
    } finally {
      setDeleting(null)
    }
  }

  if (list.error) return <QueryError error={list.error} retry={loadInvoices} />

  if (loading) {
    return (
      <div>
        <PageHeader title={t("invoices.title")} />
        <ListSkeleton label={t("invoices.loading")} bleed />
      </div>
    )
  }

  const newInvoice = (label: string) => (
    <Button data-invoice-create onClick={event => { origin.current = event.currentTarget.getBoundingClientRect(); setFlowOpen(true) }}>
        <Plus />
        {label}
    </Button>
  )

  const noticeInvoice = invoices.find(invoice => invoice.id === notice?.id)
  const noticeText = notice?.sendError === EMAIL_SEND_FAILED_PARAM
    ? `${t("invoices.detail.email.sendFailed.title")} ${t("invoices.detail.email.sendFailed.body")}`
    : notice?.sendError ?? (notice?.emailWarning ? t("invoices.detail.warning.emailSkipped", { reason: notice.emailWarning }) : t(notice?.kind === "recurring" ? "invoices.flow.scheduleSaved" : notice?.kind === "draft" ? "invoices.flow.created" : "shell.request.invoice.sent"))
  return (
    <div>
      {flowOpen && <InvoiceFlow open origin={origin.current} onClose={() => setFlowOpen(false)} onComplete={target => { void completed(target) }} />}
      {selected && <InvoiceDetailPanel key={selected} id={selected} origin={origin.current} onClose={() => setSelected(null)} />}
      {notice && <div ref={toast} role="status" className="invoice-toast fixed bottom-4 right-4 z-40 max-w-[calc(100vw-2rem)] rounded-lg border bg-panel p-4 shadow-lg">
        <p>{noticeText}</p>
        {noticeInvoice && <Amount value={decimalFromNumber(noticeInvoice.total, noticeInvoice.currency)} currency={noticeInvoice.currency} locale={locale} />}
        {notice.paymentUrl && <Button variant="outline" onClick={() => { void navigator.clipboard.writeText(notice.paymentUrl!).catch(() => {}) }}>{t("invoices.flow.copyLink")}</Button>}
        <Button variant="ghost" onClick={() => setNotice(null)}>{t("ui.close")}</Button>
      </div>}
      <PageHeader title={t("invoices.title")} actions={invoices.length ? newInvoice(t("invoices.action.new")) : null} />

      {summaryQuery.error ? <QueryError error={summaryQuery.error} retry={summaryQuery.refresh} /> : summary ? <InvoiceListSummary summary={summary} /> : null}
      {invoices.length === 0 ? (
        <ListEmpty
          title={t("invoices.empty.title")}
          description={t("invoices.empty.description")}
          action={newInvoice(t("invoices.action.create"))}
        />
      ) : (
        <ListTable
          label={t("invoices.title")}
          columns="minmax(0,2.2fr) 6rem 7rem 7rem minmax(8.5rem,1fr) 8rem 2.25rem"
          compactColumns="minmax(0,2.2fr) 6rem 7rem minmax(8.5rem,1fr) 8rem 2.25rem"
        >
          <ListHead>
            <ListHeadCell>{t("invoices.table.contact")}</ListHeadCell>
            <ListHeadCell>{t("invoices.table.number")}</ListHeadCell>
            <ListHeadCell className="hidden @5xl:block">{t("invoices.table.issueDate")}</ListHeadCell>
            <ListHeadCell className="hidden @4xl:block">{t("invoices.table.dueDate")}</ListHeadCell>
            <ListHeadCell align="end">{t("invoices.table.total")}</ListHeadCell>
            <ListHeadCell>{t("invoices.table.status")}</ListHeadCell>
            <ListHeadCell />
          </ListHead>
          <ListBody>
            {invoices.map((invoice) => {
              const partlyPaid = invoice.balanceDue > 0 && invoice.balanceDue < invoice.total
              const dueDate = formatDate(invoice.dueDate, locale)
              return (
                <ListRow key={invoice.id} data-invoice-id={invoice.id} className={invoice.id === fresh ? "invoice-fresh-row" : undefined}>
                  <ListCell className="@max-4xl:col-start-1 @max-4xl:row-start-1">
                    <div className="flex min-w-0 items-center gap-2.5">
                      <CustomerMark name={invoice.contact.name} />
                      <div className="min-w-0">
                        <Link
                          onClick={event => { if (!event.ctrlKey && !event.metaKey && !event.shiftKey && event.button === 0) { event.preventDefault(); origin.current = event.currentTarget.closest("[data-invoice-id]")!.getBoundingClientRect(); setSelected(invoice.id) } }}
                          to="/invoices/$invoiceId"
                          params={{ invoiceId: invoice.id }}
                          search={{ emailWarning: undefined }}
                          aria-label={
                            invoice.number
                              ? t("invoices.row.link", { number: invoice.number, customer: invoice.contact.name })
                              : t("invoices.row.linkDraft", { customer: invoice.contact.name })
                          }
                          className={cn(listRowLinkClass, "block truncate font-semibold")}
                        >
                          {invoice.contact.name}
                        </Link>
                        <span
                          className={cn(
                            "text-muted-foreground block truncate text-xs @4xl:hidden",
                            invoice.status === "overdue" && "text-tone-warning"
                          )}
                        >
                          {t("invoices.table.dueDate")} {dueDate}
                        </span>
                      </div>
                    </div>
                  </ListCell>
                  <ListCell className="font-mono text-xs tracking-[0.01em] @max-4xl:col-start-1 @max-4xl:row-start-2">
                    {invoice.number ?? (
                      <>
                        <span aria-hidden="true" className="text-muted-foreground">
                          —
                        </span>
                        <span className="sr-only">{t("invoices.number.draft")}</span>
                      </>
                    )}
                  </ListCell>
                  <ListCell className="text-muted-foreground hidden @5xl:block">
                    {formatDate(invoice.issueDate, locale)}
                  </ListCell>
                  <ListCell
                    className={cn(
                      "text-muted-foreground hidden @4xl:block",
                      invoice.status === "overdue" && "text-tone-warning"
                    )}
                  >
                    {dueDate}
                  </ListCell>
                  <ListCell align="end" className="@max-4xl:col-start-2 @max-4xl:row-start-1">
                    <div className="flex flex-col items-end">
                      <Amount
                        value={decimalFromNumber(invoice.total, invoice.currency)}
                        currency={invoice.currency}
                        locale={locale}
                      />
                      {partlyPaid ? (
                        <span className="text-muted-foreground num -mt-0.5 text-xs">
                          {t("payments.summary.balanceDue")}{" "}
                          {formatAmountText(
                            decimalFromNumber(invoice.balanceDue, invoice.currency),
                            invoice.currency,
                            locale
                          )}
                        </span>
                      ) : null}
                    </div>
                  </ListCell>
                  <ListCell className="@max-4xl:col-start-2 @max-4xl:row-start-2 @max-4xl:justify-self-end">
                    <SwappingStatusBadge
                      status={invoiceDisplayStatus(invoice, timezone, today, reminded.has(invoice.id))}
                      delay={Math.min(stagger.get(invoice.id) ?? 0, 5) * PILL_STAGGER_MS}
                    />
                  </ListCell>
                  <ListCell className="@max-4xl:col-start-1 @max-4xl:row-start-2 @max-4xl:-my-1.5 @max-4xl:justify-self-end @max-4xl:empty:sr-only">
                    {invoice.status === "draft" && (
                      <div className={rowActionsClass}>
                        <AlertDialog>
                          <AlertDialogTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              className="size-9 @4xl:size-7"
                              aria-label={t("invoices.delete.title")}
                              disabled={deleting === invoice.id}
                            >
                              <Trash2 className="text-muted-foreground size-4" />
                            </Button>
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>{t("invoices.delete.title")}</AlertDialogTitle>
                              <AlertDialogDescription>
                                {invoice.number
                                  ? t("invoices.delete.description", { number: invoice.number })
                                  : t("invoices.delete.descriptionDraft")}
                              </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel>{t("invoices.action.cancel")}</AlertDialogCancel>
                              <AlertDialogAction
                                variant="destructive"
                                onClick={() => handleDelete(invoice.id)}
                              >
                                {t("invoices.action.delete")}
                              </AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                      </div>
                    )}
                  </ListCell>
                </ListRow>
              )
            })}
          </ListBody>
        </ListTable>
      )}
    </div>
  )
}
