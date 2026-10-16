import { useQueryRevision } from "../../hooks/use-query-refresh"
import { useEffect, useState } from "react"
import { trpc } from "../../trpc/client"
import { Badge } from "../ui/badge"

const REFRESH_MS = 60_000

/** Pending approval count for navigation. Renders nothing when the inbox is empty. */
export function PendingApprovalsBadge({ className }: { className?: string }) {
  const [count, setCount] = useState<number | null>(null)
  const query = useQueryRevision(["agents"])

  useEffect(() => {
    let cancelled = false
    const load = () =>
      trpc.agents.pendingCount
        .query()
        .then((value) => {
          if (!cancelled) setCount(value)
        })
        .catch(() => { /* Keep the last confirmed count until the next read succeeds. */ })
    void load()
    const timer = setInterval(load, REFRESH_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [query.revision])

  if (count === null || count === 0) return null
  return (
    <Badge variant="destructive" className={className}>
      {count}
    </Badge>
  )
}
