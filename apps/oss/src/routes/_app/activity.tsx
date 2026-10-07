import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useCallback, useEffect, useState } from "react"
import { AccountingExportCard } from "../../components/activity/accounting-export-card"
import { ActivityList } from "../../components/activity/activity-list"
import { Button } from "../../components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card"
import { Label } from "../../components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select"
import type { ActivityEntry } from "../../lib/exports/activity"
import { useI18n } from "../../lib/i18n/react"
import { cn } from "../../lib/utils"
import { trpc } from "../../trpc/client"

type ActivityTab = "audit" | "accounting"

export const Route = createFileRoute("/_app/activity")({
  validateSearch: (search: Record<string, unknown>): { tab?: ActivityTab } =>
    search.tab === "accounting" ? { tab: "accounting" } : {},
  component: ActivityPage,
})

const PAGE_SIZE = 50
const FILTERS = [
  "all",
  "invoice",
  "quote",
  "creditNote",
  "payment",
  "contact",
  "recurring",
  "approval",
  "agentKey",
] as const
type Filter = (typeof FILTERS)[number]

function ActivityPage() {
  const { t } = useI18n()
  const { tab = "audit" } = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const tabs: Array<{ id: ActivityTab; label: string }> = [
    { id: "audit", label: t("activity.tab.audit") },
    { id: "accounting", label: t("activity.tab.accounting") },
  ]

  return (
    <div className="p-6 max-w-4xl grid gap-6">
      <div>
        <h1 className="text-2xl font-semibold">{t("activity.title")}</h1>
        <p className="text-sm text-muted-foreground">{t("activity.description")}</p>
      </div>

      <div role="tablist" className="inline-flex w-fit rounded-lg bg-muted p-1">
        {tabs.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            aria-selected={tab === entry.id}
            onClick={() =>
              navigate({ search: entry.id === "audit" ? {} : { tab: entry.id }, replace: true })
            }
            className={cn(
              "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
              tab === entry.id
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {entry.label}
          </button>
        ))}
      </div>

      {tab === "audit" ? <AuditLog /> : <AccountingExportCard />}
    </div>
  )
}

type LoadState = "loading" | "ready" | "error" | "forbidden"

function AuditLog() {
  const { t } = useI18n()
  const [filter, setFilter] = useState<Filter>("all")
  const [events, setEvents] = useState<ActivityEntry[]>([])
  const [cursor, setCursor] = useState<number | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [state, setState] = useState<LoadState>("loading")
  const [loadingMore, setLoadingMore] = useState(false)

  const fetchPage = useCallback(
    (beforeSequence?: number) =>
      trpc.activity.list.query({
        order: "desc",
        limit: PAGE_SIZE,
        ...(beforeSequence !== undefined ? { beforeSequence } : {}),
        ...(filter !== "all" ? { aggregateType: filter } : {}),
      }),
    [filter]
  )

  const handleError = useCallback((error: unknown) => {
    const code = (error as { data?: { code?: string } } | null)?.data?.code
    setState(code === "FORBIDDEN" ? "forbidden" : "error")
  }, [])

  useEffect(() => {
    let cancelled = false
    setState("loading")
    fetchPage()
      .then((page) => {
        if (cancelled) return
        setEvents(page.events)
        setCursor(page.nextSequence)
        setHasMore(page.hasMore)
        setState("ready")
      })
      .catch((error: unknown) => {
        if (!cancelled) handleError(error)
      })
    return () => {
      cancelled = true
    }
  }, [fetchPage, handleError])

  async function loadMore() {
    if (cursor === null) return
    setLoadingMore(true)
    try {
      const page = await fetchPage(cursor)
      setEvents((current) => [...current, ...page.events])
      setCursor(page.nextSequence)
      setHasMore(page.hasMore)
    } catch (error) {
      handleError(error)
    } finally {
      setLoadingMore(false)
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-4">
        <div className="grid gap-1.5">
          <CardTitle>{t("activity.audit.title")}</CardTitle>
          <CardDescription>{t("activity.audit.description")}</CardDescription>
        </div>
        <div className="grid gap-2 w-48">
          <Label htmlFor="activity-filter">{t("activity.filter.label")}</Label>
          <Select value={filter} onValueChange={(value) => setFilter(value as Filter)}>
            <SelectTrigger id="activity-filter">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {FILTERS.map((option) => (
                <SelectItem key={option} value={option}>
                  {t(`activity.filter.${option}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </CardHeader>
      <CardContent className="grid gap-4">
        {state === "loading" ? (
          <p className="text-sm text-muted-foreground">{t("activity.loading")}</p>
        ) : state === "forbidden" ? (
          <p className="text-sm text-muted-foreground">{t("activity.forbidden")}</p>
        ) : state === "error" ? (
          <p className="text-sm text-destructive">{t("activity.error")}</p>
        ) : events.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("activity.empty")}</p>
        ) : (
          <>
            <ActivityList events={events} showAggregate />
            {hasMore ? (
              <div>
                <Button type="button" variant="outline" onClick={loadMore} disabled={loadingMore}>
                  {loadingMore ? t("activity.loading") : t("activity.loadMore")}
                </Button>
              </div>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  )
}
