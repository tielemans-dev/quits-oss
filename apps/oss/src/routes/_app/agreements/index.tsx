import { createFileRoute, Link } from "@tanstack/react-router"
import { useEffect, useState } from "react"
import { trpc } from "../../../trpc/client"
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
import { useI18n } from "../../../lib/i18n/react"
import { formatCurrency, formatDate } from "../../../lib/i18n/format"

export const Route = createFileRoute("/_app/agreements/")({ component: AgreementsPage })
function AgreementsPage() {
  const { t, locale } = useI18n()
  const [agreements, setAgreements] = useState<
    Awaited<ReturnType<typeof trpc.agreements.list.query>>
  >([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    trpc.agreements.list
      .query()
      .then((data) => {
        if (!cancelled) setAgreements(data)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : t("agreements.error"))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [t])
  return (
    <div className="p-6 grid gap-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">{t("agreements.title")}</h1>
          <p className="text-muted-foreground">{t("agreements.description")}</p>
        </div>
        <Button asChild>
          <Link to="/agreements/new">{t("agreements.new")}</Link>
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">{t("agreements.draftOnly")}</p>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      {loading ? (
        <p>{t("agreements.loading")}</p>
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
                  <Badge variant="secondary">
                    {agreement.status === "draft" ? t("agreements.draft") : agreement.status}
                  </Badge>
                </TableCell>
                <TableCell>{agreement.contact.name}</TableCell>
                <TableCell>{formatDate(agreement.validUntil, locale, "UTC")}</TableCell>
                <TableCell>{formatCurrency(agreement.total, agreement.currency, locale)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  )
}
