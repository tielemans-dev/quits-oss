import { useAppQuery } from "../../../hooks/use-query-refresh"
import { QueryError, QuerySkeleton } from "../../../components/query-state"
import { AgreementTemplateManager } from "../../../components/agreements/template-manager"
import { createFileRoute, Link } from "@tanstack/react-router"
import { trpc } from "../../../trpc/client"
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
import { useI18n } from "../../../lib/i18n/react"
import { formatCurrency, formatDate } from "../../../lib/i18n/format"

export const Route = createFileRoute("/_app/agreements/")({ component: AgreementsPage })
function AgreementsPage() {
  const { t, locale } = useI18n()
  const list = useAppQuery(["agreements"], () => trpc.agreements.list.query())
  const agreements = list.data ?? []
  if (list.error) return <QueryError error={list.error} retry={list.refresh} />
  return (
    <div className="grid gap-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">{t("agreements.title")}</h1>
          <p className="text-muted-foreground">{t("agreements.description")}</p>
        </div>
        <Button asChild>
          <Link to="/agreements/new">{t("agreements.new")}</Link>
        </Button>
      </div>
      <AgreementTemplateManager />
      <p className="text-sm text-muted-foreground">{t("agreements.draftOnly")}</p>
      {list.loading ? (
        <QuerySkeleton />
      ) : agreements.length === 0 ? (
        <p>{t("agreements.empty")}</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("agreements.titleField")}</TableHead>
              <TableHead>{t("agreements.customer")}</TableHead>
              <TableHead>{t("agreements.validUntil")}</TableHead>
              <TableHead>{t("agreements.total")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {agreements.map((agreement) => (
              <TableRow key={agreement.id}>
                <TableCell>
                  <Link
                    className="font-medium underline"
                    to="/agreements/$agreementId"
                    params={{ agreementId: agreement.id }}
                  >
                    {agreement.title}
                  </Link>{" "}
                  <StatusBadge domain="agreement" status={agreement.status} />
                </TableCell>
                <TableCell>{agreement.contact.name}</TableCell>
                <TableCell>{formatDate(agreement.validUntil, locale, "UTC")}</TableCell>
                <TableCell className="num">{formatCurrency(agreement.total, agreement.currency, locale)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  )
}
