import { useAppQuery } from "../../hooks/use-query-refresh"
import { QueryError, QuerySkeleton } from "../../components/query-state"
import { createFileRoute } from "@tanstack/react-router"
import { ShieldCheck } from "lucide-react"
import { useState } from "react"
import type { ApprovalRow } from "../../components/agents/types"
import { ApprovalItem } from "../../components/agents/approval-item"
import { Button } from "../../components/ui/button"
import { useI18n } from "../../lib/i18n/react"
import { trpc } from "../../trpc/client"

export const Route = createFileRoute("/_app/approvals")({
  component: ApprovalsPage,
})

type View = "pending" | "history"

function ApprovalsPage() {
  const { t } = useI18n()
  const [view, setView] = useState<View>("pending")
  const list = useAppQuery(["agents"], () => trpc.agents.approvals.query({ view }), [view])
  const [retained, setRetained] = useState<ApprovalRow[]>([])
  const approvals = list.data ? [...list.data, ...retained.filter(row => !list.data?.some(current => current.id === row.id))] : null

  return (
    <div className="p-6">
      <div className="mb-6 grid gap-1">
        <h1 className="text-2xl font-bold">{t("agents.approvals.title")}</h1>
        <p className="max-w-2xl text-sm text-muted-foreground">{t("agents.approvals.description")}</p>
      </div>

      <div role="tablist" className="mb-4 inline-flex gap-1 rounded-lg bg-muted p-1">
        {(["pending", "history"] as const).map((option) => (
          <Button
            key={option}
            role="tab"
            aria-selected={view === option}
            size="sm"
            variant={view === option ? "secondary" : "ghost"}
            className={view === option ? "bg-background shadow-sm" : undefined}
            onClick={() => { setRetained([]); setView(option) }}
          >
            {t(`agents.approvals.tab.${option}`)}
          </Button>
        ))}
      </div>

      {list.error && approvals?.length ? <QueryError error={list.error} retry={list.refresh} /> : null}
      {list.error && !approvals?.length ? (
        <QueryError error={list.error} retry={list.refresh} />
      ) : approvals === null ? (
        <QuerySkeleton />
      ) : approvals.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <ShieldCheck className="mb-4 size-12 text-muted-foreground" />
          <p className="text-muted-foreground">{t(`agents.approvals.empty.${view}`)}</p>
        </div>
      ) : (
        <div className="grid max-w-3xl gap-3">
          {approvals.map((approval) => (
            <ApprovalItem key={approval.id} approval={approval} onDecisionStart={() => setRetained(rows => rows.some(row => row.id === approval.id) ? rows : [...rows, approval])} />
          ))}
        </div>
      )}
    </div>
  )
}
