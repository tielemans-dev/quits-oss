import { createFileRoute, Link } from "@tanstack/react-router"
import { useState, useEffect } from "react"
import { trpc } from "../../../trpc/client"
import { formatDate as formatDateIntl } from "../../../lib/i18n/format"
import { Button } from "../../../components/ui/button"
import { StatusBadge } from "../../../components/status-badge"
import { Amount } from "../../../components/kvit/amount"
import { decimalFromNumber } from "../../../components/kvit/amount-format"
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

function formatDate(dateStr: string, locale?: string) {
  return formatDateIntl(dateStr, locale, undefined, { month: "short" })
}

function QuotesListPage() {
  const { t, locale } = useI18n()
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
        <PageHeader title={t("quotes.title")} />
        <ListSkeleton label={t("quotes.loading")} />
      </div>
    )
  }

  const newQuote = (label: string) => (
    <Button asChild>
      <Link to="/quotes/new">
        <Plus />
        {label}
      </Link>
    </Button>
  )

  return (
    <div className="p-6">
      <PageHeader title={t("quotes.title")} actions={newQuote(t("quotes.action.new"))} />

      {quotes.length === 0 ? (
        <ListEmpty
          title={t("quotes.empty.title")}
          description={t("quotes.empty.description")}
          action={newQuote(t("quotes.action.create"))}
        />
      ) : (
        <ListTable
          label={t("quotes.title")}
          columns="minmax(0,2.2fr) 7.5rem 7.5rem 7.5rem minmax(8.5rem,1fr) 8.5rem 2.25rem"
        >
          <ListHead>
            <ListHeadCell>{t("quotes.table.contact")}</ListHeadCell>
            <ListHeadCell>{t("quotes.table.number")}</ListHeadCell>
            <ListHeadCell>{t("quotes.table.issueDate")}</ListHeadCell>
            <ListHeadCell>{t("quotes.table.expiryDate")}</ListHeadCell>
            <ListHeadCell align="end">{t("quotes.table.total")}</ListHeadCell>
            <ListHeadCell>{t("quotes.table.status")}</ListHeadCell>
            <ListHeadCell />
          </ListHead>
          <ListBody>
            {quotes.map((quote) => {
              const expiryDate = formatDate(quote.expiryDate, locale)
              return (
                <ListRow key={quote.id}>
                  <ListCell className="max-md:col-start-1 max-md:row-start-1">
                    <div className="flex min-w-0 items-center gap-2.5">
                      <CustomerMark name={quote.contact.name} />
                      <div className="min-w-0">
                        <Link
                          to="/quotes/$quoteId"
                          params={{ quoteId: quote.id }}
                          search={{ emailWarning: undefined }}
                          className={cn(listRowLinkClass, "block truncate font-semibold")}
                        >
                          {quote.contact.name}
                        </Link>
                        <span className="text-muted-foreground block truncate text-xs md:hidden">
                          {t("quotes.table.expiryDate")} {expiryDate}
                        </span>
                      </div>
                    </div>
                  </ListCell>
                  <ListCell className="font-mono text-[12.5px] tracking-[0.01em] max-md:col-start-1 max-md:row-start-2">
                    {quote.number ?? (
                      <>
                        <span aria-hidden="true" className="text-muted-foreground">
                          —
                        </span>
                        <span className="sr-only">{t("quotes.number.draft")}</span>
                      </>
                    )}
                  </ListCell>
                  <ListCell className="text-muted-foreground max-md:hidden">
                    {formatDate(quote.issueDate, locale)}
                  </ListCell>
                  <ListCell className="text-muted-foreground max-md:hidden">{expiryDate}</ListCell>
                  <ListCell align="end" className="max-md:col-start-2 max-md:row-start-1">
                    {/* The double rule is for money that has arrived; a quote asks for none. */}
                    <Amount
                      value={decimalFromNumber(quote.total, quote.currency)}
                      currency={quote.currency}
                      locale={locale}
                    />
                  </ListCell>
                  <ListCell className="max-md:col-start-2 max-md:row-start-2 max-md:justify-self-end">
                    <StatusBadge domain="quote" status={quote.status} />
                  </ListCell>
                  <ListCell className="max-md:col-span-2 max-md:row-start-3 max-md:empty:hidden">
                    {quote.status === "draft" && (
                      <div className={rowActionsClass}>
                        <AlertDialog>
                          <AlertDialogTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              className="size-7"
                              aria-label={t("quotes.delete.title")}
                              disabled={deleting === quote.id}
                            >
                              <Trash2 className="text-muted-foreground size-4" />
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
