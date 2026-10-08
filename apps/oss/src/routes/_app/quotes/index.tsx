import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useState, useEffect } from "react"
import { trpc } from "../../../trpc/client"
import {
  formatCurrency as formatCurrencyIntl,
  formatDate as formatDateIntl,
} from "../../../lib/i18n/format"
import { Button } from "../../../components/ui/button"
import { StatusBadge } from "../../../components/status-badge"
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

export const Route = createFileRoute("/_app/quotes/")({
  component: QuotesListPage,
})

type Quote = {
  id: string
  /** Null until the quote is sent. */
  number: string | null
  status: string
  issueDate: string
  expiryDate: string
  total: number
  currency: string
  contact: { name: string }
}

function formatCurrency(amount: number, currency: string) {
  return formatCurrencyIntl(amount, currency)
}

function formatDate(dateStr: string, locale?: string) {
  return formatDateIntl(dateStr, locale, undefined, { month: "short" })
}

function QuotesListPage() {
  const { t, locale } = useI18n()
  const navigate = useNavigate()
  const [quotes, setQuotes] = useState<Quote[]>([])
  const [loading, setLoading] = useState(true)
  const [deleting, setDeleting] = useState<string | null>(null)

  async function loadQuotes() {
    try {
      const data = await trpc.quotes.list.query()
      setQuotes(data as unknown as Quote[])
    } catch {
      // Auth or org errors handled by layout
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadQuotes()
  }, [])

  async function handleDelete(id: string) {
    setDeleting(id)
    try {
      await trpc.quotes.delete.mutate({ id })
      setQuotes((prev) => prev.filter((q) => q.id !== id))
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
          <h1 className="text-2xl font-bold">{t("quotes.title")}</h1>
        </div>
        <p className="text-muted-foreground">{t("quotes.loading")}</p>
      </div>
    )
  }

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">{t("quotes.title")}</h1>
        <Button asChild>
          <Link to="/quotes/new">
            <Plus />
            {t("quotes.action.new")}
          </Link>
        </Button>
      </div>

      {quotes.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <FileText className="size-12 text-muted-foreground mb-4" />
          <h2 className="text-lg font-semibold mb-1">{t("quotes.empty.title")}</h2>
          <p className="text-muted-foreground mb-4">
            {t("quotes.empty.description")}
          </p>
          <Button asChild>
            <Link to="/quotes/new">
              <Plus />
              {t("quotes.action.create")}
            </Link>
          </Button>
        </div>
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("quotes.table.number")}</TableHead>
                <TableHead>{t("quotes.table.contact")}</TableHead>
                <TableHead>{t("quotes.table.issueDate")}</TableHead>
                <TableHead>{t("quotes.table.expiryDate")}</TableHead>
                <TableHead className="text-right">{t("quotes.table.total")}</TableHead>
                <TableHead>{t("quotes.table.status")}</TableHead>
                <TableHead className="w-[60px]" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {quotes.map((quote) => (
                <TableRow
                  key={quote.id}
                  className="cursor-pointer"
                  onClick={() =>
                    navigate({
                      to: "/quotes/$quoteId",
                      params: { quoteId: quote.id },
                      search: { emailWarning: undefined },
                    })
                  }
                >
                  <TableCell className="font-medium">
                    {quote.number ?? (
                      <span className="font-normal text-muted-foreground">{t("quotes.number.draft")}</span>
                    )}
                  </TableCell>
                  <TableCell>{quote.contact.name}</TableCell>
                  <TableCell>{formatDate(quote.issueDate, locale)}</TableCell>
                  <TableCell>{formatDate(quote.expiryDate, locale)}</TableCell>
                  <TableCell className="text-right num">
                    {formatCurrency(quote.total, quote.currency)}
                  </TableCell>
                  <TableCell>
                    <StatusBadge domain="quote" status={quote.status} />
                  </TableCell>
                  <TableCell>
                    {quote.status === "draft" && (
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            onClick={(e) => e.stopPropagation()}
                            disabled={deleting === quote.id}
                          >
                            <Trash2 className="size-4 text-muted-foreground" />
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>{t("quotes.delete.title")}</AlertDialogTitle>
                            <AlertDialogDescription>
                              {quote.number
                                ? t("quotes.delete.description", { number: quote.number })
                                : t("quotes.delete.descriptionDraft")}
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>{t("quotes.action.cancel")}</AlertDialogCancel>
                            <AlertDialogAction
                              variant="destructive"
                              onClick={() => handleDelete(quote.id)}
                            >
                              {t("quotes.action.delete")}
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
