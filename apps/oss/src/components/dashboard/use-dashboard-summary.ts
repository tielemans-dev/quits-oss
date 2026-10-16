import { useAppQuery } from "../../hooks/use-query-refresh"

import type { DashboardSummary } from "@quits/contracts/dashboard"

import { trpc } from "../../trpc/client"

export type SummaryLoad =
  | { status: "loading" }
  | { status: "error"; retrying: boolean }
  | { status: "ready"; summary: DashboardSummary }

/** The one place the dashboard reads its summary, so the data source can change without the page noticing. */
const fetchSummary = () => trpc.dashboard.summary.query()

export function useDashboardSummary() {
  const query = useAppQuery(["dashboard"], fetchSummary)
  const load: SummaryLoad = query.error ? { status: "error", retrying: false }
    : !query.data ? { status: "loading" } : { status: "ready", summary: query.data }
  return { load, refresh: query.refresh, retry: query.refresh }
}
