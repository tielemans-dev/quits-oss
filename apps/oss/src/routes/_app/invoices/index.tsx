import { createFileRoute, Link } from "@tanstack/react-router"
import { useState, useEffect } from "react"
import { trpc } from "../../../trpc/client"
import { formatDate as formatDateIntl } from "../../../lib/i18n/format"
import { Button } from "../../../components/ui/button"
import { StatusBadge } from "../../../components/status-badge"
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
import {
  invoiceAmountRule,
  invoiceDisplayStatus,
} from "../../../lib/payments/invoice-display-status"
import { loadInvoicesListData } from "./-index.helpers"

export const Route = createFileRoute("/_app/invoices/")({
  component: InvoicesListPage,
})

type Invoice = {
  id: string
  /** Null until the invoice is sent. */
  number: string | null
  status: string
  paymentStatus: string
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
  const [invoices, setInvoices] = useState<Invoice[]>([])
  const [loading, setLoading] = useState(true)
  const [deleting, setDeleting] = useState<string | null>(null)

  async function loadInvoices() {
    try {
      const data = await loadInvoicesListData({
        list: () => trpc.invoices.list.query(),
        markOverdue: () => trpc.invoices.markOverdue.mutate(),
      })
      setInvoices(data as unknown as Invoice[])
    } catch {
      // Auth or org errors handled by layout
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadInvoices()
  }, [])

  async function handleDelete(id: string) {
    setDeleting(id)
    try {
      await trpc.invoices.delete.mutate({ id })
      setInvoices((prev) => prev.filter((inv) => inv.id !== id))
    } catch {
      // Silently fail
    } finally {
      setDeleting(null)
    }
  }

  if (loading) {
    return (
      <div className="p-6">
        <PageHeader title={t("invoices.title")} />
        <ListSkeleton label={t("invoices.loading")} />
      </div>
    )
  }

  const newInvoice = (label: string) => (
    <Button asChild>
      <Link to="/invoices/new">
        <Plus />
        {label}
      </Link>
    </Button>
  )

  return (
    <div className="p-6">
      <PageHeader title={t("invoices.title")} actions={newInvoice(t("invoices.action.new"))} />

      {invoices.length === 0 ? (
        <ListEmpty
          title={t("invoices.empty.title")}
          description={t("invoices.empty.description")}
          action={newInvoice(t("invoices.action.create"))}
        />
      ) : (
        <ListTable
          label={t("invoices.title")}
          columns="minmax(0,2.2fr) 7.5rem 7.5rem 7.5rem minmax(8.5rem,1fr) 8.5rem 2.25rem"
        >
          <ListHead>
            <ListHeadCell>{t("invoices.table.contact")}</ListHeadCell>
            <ListHeadCell>{t("invoices.table.number")}</ListHeadCell>
            <ListHeadCell>{t("invoices.table.issueDate")}</ListHeadCell>
            <ListHeadCell>{t("invoices.table.dueDate")}</ListHeadCell>
            <ListHeadCell align="end">{t("invoices.table.total")}</ListHeadCell>
            <ListHeadCell>{t("invoices.table.status")}</ListHeadCell>
            <ListHeadCell />
          </ListHead>
          <ListBody>
            {invoices.map((invoice) => {
              const { rule, paidFraction } = invoiceAmountRule(invoice)
              const partlyPaid = invoice.balanceDue > 0 && invoice.balanceDue < invoice.total
              const dueDate = formatDate(invoice.dueDate, locale)
              return (
                <ListRow key={invoice.id}>
                  <ListCell className="max-md:col-start-1 max-md:row-start-1">
                    <div className="flex min-w-0 items-center gap-2.5">
                      <CustomerMark name={invoice.contact.name} />
                      <div className="min-w-0">
                        <Link
                          to="/invoices/$invoiceId"
                          params={{ invoiceId: invoice.id }}
                          search={{ emailWarning: undefined }}
                          className={cn(listRowLinkClass, "block truncate font-semibold")}
                        >
                          {invoice.contact.name}
                        </Link>
                        <span
                          className={cn(
                            "text-muted-foreground block truncate text-xs md:hidden",
                            invoice.status === "overdue" && "text-tone-danger"
                          )}
                        >
                          {t("invoices.table.dueDate")} {dueDate}
                        </span>
                      </div>
                    </div>
                  </ListCell>
                  <ListCell className="font-mono text-[12.5px] tracking-[0.01em] max-md:col-start-1 max-md:row-start-2">
                    {invoice.number ?? (
                      <>
                        <span aria-hidden="true" className="text-muted-foreground">
                          —
                        </span>
                        <span className="sr-only">{t("invoices.number.draft")}</span>
                      </>
                    )}
                  </ListCell>
                  <ListCell className="text-muted-foreground max-md:hidden">
                    {formatDate(invoice.issueDate, locale)}
                  </ListCell>
                  <ListCell
                    className={cn(
                      "text-muted-foreground max-md:hidden",
                      invoice.status === "overdue" && "text-tone-danger"
                    )}
                  >
                    {dueDate}
                  </ListCell>
                  <ListCell align="end" className="max-md:col-start-2 max-md:row-start-1">
                    <div className="flex flex-col items-end">
                      <Amount
                        value={decimalFromNumber(invoice.total, invoice.currency)}
                        currency={invoice.currency}
                        locale={locale}
                        rule={rule}
                        paidFraction={paidFraction}
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
                  <ListCell className="max-md:col-start-2 max-md:row-start-2 max-md:justify-self-end">
                    <StatusBadge domain="invoice" status={invoiceDisplayStatus(invoice)} />
                  </ListCell>
                  <ListCell className="max-md:col-span-2 max-md:row-start-3 max-md:empty:hidden">
                    {invoice.status === "draft" && (
                      <div className={rowActionsClass}>
                        <AlertDialog>
                          <AlertDialogTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              className="size-7"
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
