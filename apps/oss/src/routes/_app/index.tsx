import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useState, useEffect } from "react"
import { trpc } from "../../trpc/client"
import {
  formatCurrency as formatCurrencyIntl,
  formatDate as formatDateIntl,
} from "../../lib/i18n/format"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../components/ui/card"
import { StatusBadge } from "../../components/status-badge"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../components/ui/table"
import { DollarSign, Clock, AlertTriangle, Users } from "lucide-react"
import { useI18n } from "../../lib/i18n/react"

export const Route = createFileRoute("/_app/")({
  component: DashboardPage,
})

type RecentInvoice = {
  id: string
  number: string | null
  contactName: string
  total: number
  currency: string
  status: string
  issueDate: string
  dueDate: string
}

type DashboardStats = {
  currencyBuckets: Array<{ currency: string; totalRevenue: string; outstanding: string }>
  baseTotal: { currency: string; amount: string; excludedUnknownValuations: number }
  overdueCount: number
  totalContacts: number
  recentInvoices: RecentInvoice[]
}

function formatCurrency(amount: number, currency: string, locale: string) {
  return formatCurrencyIntl(amount, currency, locale)
}

function formatDate(dateStr: string, locale: string) {
  return formatDateIntl(dateStr, locale, undefined, { month: "short" })
}

function DashboardPage() {
  const { t, locale } = useI18n()
  const navigate = useNavigate()
  const [stats, setStats] = useState<DashboardStats | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function loadStats() {
      try {
        const data = await trpc.dashboard.stats.query()
        setStats(data as DashboardStats)
      } catch {
        // Auth or org errors handled by layout
      } finally {
        setLoading(false)
      }
    }
    loadStats()
  }, [])

  if (loading) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-bold mb-6">{t("nav.dashboard")}</h1>
        <p className="text-muted-foreground">{t("dashboard.loading")}</p>
      </div>
    )
  }

  if (!stats) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-bold mb-6">{t("nav.dashboard")}</h1>
        <p className="text-muted-foreground">
          {t("dashboard.loadError")}
        </p>
      </div>
    )
  }

  return (
    <div className="p-6 space-y-8">
      <div>
        <h1 className="text-2xl font-bold">{t("nav.dashboard")}</h1>
        <p className="text-muted-foreground mt-1">
          {t("dashboard.subtitle")}
        </p>
      </div>

      {/* Stat Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
            <CardTitle className="text-sm font-medium">{t("dashboard.totalRevenue")}</CardTitle>
            <DollarSign className="size-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="num text-2xl font-bold">
              {stats.currencyBuckets.map(bucket => <div key={bucket.currency}>{formatCurrency(Number(bucket.totalRevenue), bucket.currency, locale)}</div>)}
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              {t("dashboard.totalRevenueHint")}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
            <CardTitle className="text-sm font-medium">{t("dashboard.outstanding")}</CardTitle>
            <Clock className="size-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="num text-2xl font-bold">
              {stats.currencyBuckets.map(bucket => <div key={bucket.currency}>{formatCurrency(Number(bucket.outstanding), bucket.currency, locale)}</div>)}
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              {t("dashboard.outstandingHint")}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
            <CardTitle className="text-sm font-medium">{t("dashboard.overdue")}</CardTitle>
            <AlertTriangle className="size-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="num text-2xl font-bold">{stats.overdueCount}</div>
            <p className="text-xs text-muted-foreground mt-1">
              {stats.overdueCount === 1
                ? t("dashboard.overdueSingle")
                : t("dashboard.overduePlural")}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
            <CardTitle className="text-sm font-medium">
              {t("dashboard.totalContacts")}
            </CardTitle>
            <Users className="size-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="num text-2xl font-bold">{stats.totalContacts}</div>
            <p className="text-xs text-muted-foreground mt-1">
              {stats.totalContacts === 1
                ? t("dashboard.totalContactsSingle")
                : t("dashboard.totalContactsPlural")}
            </p>
          </CardContent>
        </Card>
      </div>

      <Card><CardHeader><CardTitle>{t("dashboard.baseTotal")}</CardTitle><CardDescription>{t("dashboard.baseTotalHint", { count: stats.baseTotal.excludedUnknownValuations })}</CardDescription></CardHeader><CardContent>{formatCurrency(Number(stats.baseTotal.amount), stats.baseTotal.currency, locale)}</CardContent></Card>

      {/* Recent Invoices */}
      <Card>
        <CardHeader>
          <CardTitle>{t("dashboard.recentInvoices")}</CardTitle>
          <CardDescription>{t("dashboard.recentInvoicesDesc")}</CardDescription>
        </CardHeader>
        <CardContent>
          {stats.recentInvoices.length === 0 ? (
            <p className="text-muted-foreground text-sm py-4 text-center">
              {t("dashboard.noInvoices")}{" "}
              <Link
                to="/invoices/new"
                className="text-brand-text underline underline-offset-4"
              >
                {t("dashboard.createFirstInvoice")}
              </Link>{" "}
              {t("dashboard.getStartedSuffix")}
            </p>
          ) : (
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("dashboard.table.number")}</TableHead>
                    <TableHead>{t("dashboard.table.contact")}</TableHead>
                    <TableHead>{t("dashboard.table.issueDate")}</TableHead>
                    <TableHead>{t("dashboard.table.dueDate")}</TableHead>
                    <TableHead className="text-right">{t("dashboard.table.total")}</TableHead>
                    <TableHead>{t("dashboard.table.status")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {stats.recentInvoices.map((invoice) => (
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
                      <TableCell className="font-medium">
                        {invoice.number ?? (
                          <span className="font-normal text-muted-foreground" aria-label={t("invoices.number.draft")}>—</span>
                        )}
                      </TableCell>
                      <TableCell>{invoice.contactName}</TableCell>
                      <TableCell>{formatDate(invoice.issueDate, locale)}</TableCell>
                      <TableCell>{formatDate(invoice.dueDate, locale)}</TableCell>
                      <TableCell className="text-right num">
                        {formatCurrency(invoice.total, invoice.currency, locale)}
                      </TableCell>
                      <TableCell>
                        <StatusBadge domain="invoice" status={invoice.status} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
