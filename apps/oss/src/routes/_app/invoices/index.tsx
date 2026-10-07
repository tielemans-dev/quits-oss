import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useState, useEffect } from "react"
import { trpc } from "../../../trpc/client"
import {
  formatCurrency as formatCurrencyIntl,
  formatDate as formatDateIntl,
} from "../../../lib/i18n/format"
import { Button } from "../../../components/ui/button"
import { Badge } from "../../../components/ui/badge"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../../components/ui/table"
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
import { Plus, Trash2, FileText } from "lucide-react"
import { useI18n } from "../../../lib/i18n/react"
import { invoiceDisplayStatus } from "../../../lib/payments/invoice-display-status"
import { loadInvoicesListData } from "./-index.helpers"

export const Route = createFileRoute("/_app/invoices/")({
  component: InvoicesListPage,
})

type Invoice = {
  id: string
  number: string
  status: string
  paymentStatus: string
  issueDate: string
  dueDate: string
  total: number
  balanceDue: number
  currency: string
  contact: { name: string }
}

const statusConfig: Record<string, { label: string; className: string }> = {
  draft: { label: "Draft", className: "bg-muted text-muted-foreground" },
  sent: { label: "Sent", className: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200" },
  paid: { label: "Paid", className: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200" },
  overdue: { label: "Overdue", className: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200" },
  partially_paid: {
    label: "Partially paid",
    className: "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200",
  },
  credited: {
    label: "Credited",
    className: "bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200",
  },
}

function formatCurrency(amount: number, currency: string) {
  return formatCurrencyIntl(amount, currency)
}

function formatDate(dateStr: string, locale?: string) {
  return formatDateIntl(dateStr, locale, undefined, { month: "short" })
}

function getInvoiceStatusLabel(status: string, t: ReturnType<typeof useI18n>["t"]) {
  if (status === "sent") return t("invoices.status.sent")
  if (status === "paid") return t("invoices.status.paid")
  if (status === "overdue") return t("invoices.status.overdue")
  if (status === "partially_paid") return t("status.partially_paid")
  if (status === "credited") return t("status.credited")
  return t("invoices.status.draft")
}

function StatusBadge({ status, label }: { status: string; label: string }) {
  const config = statusConfig[status] ?? statusConfig.draft
  return (
    <Badge variant="outline" className={config.className}>
      {label}
    </Badge>
  )
}

function InvoicesListPage() {
  const { t, locale } = useI18n()
  const navigate = useNavigate()
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
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-bold">{t("invoices.title")}</h1>
        </div>
        <p className="text-muted-foreground">{t("invoices.loading")}</p>
      </div>
    )
  }

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">{t("invoices.title")}</h1>
        <Button asChild>
          <Link to="/invoices/new">
            <Plus />
            {t("invoices.action.new")}
          </Link>
        </Button>
      </div>

      {invoices.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <FileText className="size-12 text-muted-foreground mb-4" />
          <h2 className="text-lg font-semibold mb-1">{t("invoices.empty.title")}</h2>
          <p className="text-muted-foreground mb-4">
            {t("invoices.empty.description")}
          </p>
          <Button asChild>
            <Link to="/invoices/new">
              <Plus />
              {t("invoices.action.create")}
            </Link>
          </Button>
        </div>
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("invoices.table.number")}</TableHead>
                <TableHead>{t("invoices.table.contact")}</TableHead>
                <TableHead>{t("invoices.table.issueDate")}</TableHead>
                <TableHead>{t("invoices.table.dueDate")}</TableHead>
                <TableHead className="text-right">{t("invoices.table.total")}</TableHead>
                <TableHead>{t("invoices.table.status")}</TableHead>
                <TableHead className="w-[60px]" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {invoices.map((invoice) => (
                <TableRow
                  key={invoice.id}
                  className="cursor-pointer"
                  onClick={() =>
                    navigate({
                      to: "/invoices/$invoiceId",
                      params: { invoiceId: invoice.id },
                      search: { emailWarning: undefined },
                    })
                  }
                >
                  <TableCell className="font-medium">{invoice.number}</TableCell>
                  <TableCell>{invoice.contact.name}</TableCell>
                  <TableCell>{formatDate(invoice.issueDate, locale)}</TableCell>
                  <TableCell>{formatDate(invoice.dueDate, locale)}</TableCell>
                  <TableCell className="text-right">
                    {formatCurrency(invoice.total, invoice.currency)}
                    {invoice.balanceDue > 0 && invoice.balanceDue < invoice.total ? (
                      <p className="text-xs text-muted-foreground">
                        {t("payments.summary.balanceDue")}{" "}
                        {formatCurrency(invoice.balanceDue, invoice.currency)}
                      </p>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    <StatusBadge
                      status={invoiceDisplayStatus(invoice)}
                      label={getInvoiceStatusLabel(invoiceDisplayStatus(invoice), t)}
                    />
                  </TableCell>
                  <TableCell>
                    {invoice.status === "draft" && (
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            onClick={(e) => e.stopPropagation()}
                            disabled={deleting === invoice.id}
                          >
                            <Trash2 className="size-4 text-muted-foreground" />
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>{t("invoices.delete.title")}</AlertDialogTitle>
                            <AlertDialogDescription>
                              {t("invoices.delete.description", {
                                number: invoice.number,
                              })}
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
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  )
}
