import { useAppQuery } from "../../../hooks/use-query-refresh"
import { QueryError } from "../../../components/query-state"
import { AgreementTemplateManager } from "../../../components/agreements/template-manager"
import { createFileRoute, Link } from "@tanstack/react-router"
import { trpc } from "../../../trpc/client"
import { Button } from "../../../components/ui/button"
import { StatusBadge } from "../../../components/status-badge"
import { Amount } from "../../../components/kvit/amount"
import { decimalFromNumber } from "../../../components/kvit/amount-format"
import { CustomerMark } from "../../../components/kvit/customer-mark"
import {
  ListBody,
  ListCell,
  ListHead,
  ListHeadCell,
  ListRow,
  ListSkeleton,
  ListTable,
  listRowLinkClass,
} from "../../../components/kvit/list"
import { cn } from "../../../lib/utils"
import { useI18n } from "../../../lib/i18n/react"
import { formatShortDate } from "../../../lib/i18n/format"

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
        <ListSkeleton label={t("agreements.loading")} bleed />
      ) : agreements.length === 0 ? (
        <p>{t("agreements.empty")}</p>
      ) : (
        <ListTable
          label={t("agreements.title")}
          columns="minmax(0,2.2fr) 6rem 7rem minmax(8.5rem,1fr) 8rem"
          compactColumns="minmax(0,2.2fr) 6rem minmax(8.5rem,1fr) 8rem"
        >
          <ListHead>
            <ListHeadCell>{t("agreements.titleField")}</ListHeadCell>
            <ListHeadCell>{t("agreements.number")}</ListHeadCell>
            <ListHeadCell className="hidden @5xl:block">{t("agreements.validUntil")}</ListHeadCell>
            <ListHeadCell align="end">{t("agreements.total")}</ListHeadCell>
            <ListHeadCell>{t("agreements.status")}</ListHeadCell>
          </ListHead>
          <ListBody>
            {agreements.map((agreement) => (
              <ListRow key={agreement.id}>
                <ListCell className="@max-4xl:col-start-1 @max-4xl:row-start-1">
                  <div className="flex min-w-0 items-center gap-2.5">
                    <CustomerMark name={agreement.contact.name} />
                    <div className="min-w-0">
                      {/* The link covers the whole row, so a click anywhere on it opens the agreement. */}
                      <Link
                        to="/agreements/$agreementId"
                        params={{ agreementId: agreement.id }}
                        aria-label={
                          agreement.number
                            ? t("agreements.row.link", { number: agreement.number, title: agreement.title, customer: agreement.contact.name })
                            : t("agreements.row.linkDraft", { title: agreement.title, customer: agreement.contact.name })
                        }
                        className={cn(listRowLinkClass, "block truncate font-semibold")}
                      >
                        {agreement.title}
                      </Link>
                      <span className="text-muted-foreground block truncate text-xs">{agreement.contact.name}</span>
                    </div>
                  </div>
                </ListCell>
                <ListCell className="font-mono text-xs tracking-[0.01em] @max-4xl:col-start-1 @max-4xl:row-start-2">
                  {agreement.number ?? (
                    <>
                      <span aria-hidden="true" className="text-muted-foreground">
                        —
                      </span>
                      <span className="sr-only">{t("agreements.number.draft")}</span>
                    </>
                  )}
                </ListCell>
                <ListCell className="text-muted-foreground hidden @5xl:block">
                  {formatShortDate(agreement.validUntil, locale, "UTC")}
                </ListCell>
                <ListCell align="end" className="@max-4xl:col-start-2 @max-4xl:row-start-1">
                  <Amount
                    value={decimalFromNumber(agreement.total, agreement.currency)}
                    currency={agreement.currency}
                    locale={locale}
                  />
                </ListCell>
                <ListCell className="@max-4xl:col-start-2 @max-4xl:row-start-2 @max-4xl:justify-self-end">
                  <StatusBadge domain="agreement" status={agreement.status} />
                </ListCell>
              </ListRow>
            ))}
          </ListBody>
        </ListTable>
      )}
    </div>
  )
}
