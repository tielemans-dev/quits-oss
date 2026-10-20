import { useEffect, useState } from "react"
import { getRequestOrganizationId } from "../lib/active-organization"
import { useI18n } from "../lib/i18n/react"
import { subscribeMutationErrors } from "../lib/query-refresh"
import { readableIssues } from "../lib/validation/readable-errors"
import { isUnexpectedFailure } from "../lib/email-send-failure"
import { Button } from "./ui/button"
import { ListSkeleton } from "./kvit/list"

export function QueryError({ error, retry }: { error: unknown; retry: () => void }) {
  const { t } = useI18n()
  return <div role="alert" className="grid max-w-160 justify-items-start gap-1 py-6">
    <p className="text-base font-medium">{t("ui.queryError")}</p>
    <p className="text-muted-foreground text-sm">{t("ui.queryError.body")}</p>
    {error instanceof Error && error.message && <p className="text-muted-foreground font-mono text-xs">{error.message}</p>}
    <Button variant="outline" className="mt-3" onClick={retry}>{t("ui.retry")}</Button>
  </div>
}

export function QuerySkeleton() {
  const { t } = useI18n()
  return <ListSkeleton label={t("ui.loading")} />
}

/** A fallback for mutations whose callers have no local error presentation. */
export function MutationErrors() {
  const { t } = useI18n()
  const [error, setError] = useState<Error | null>(null)
  useEffect(() => subscribeMutationErrors(failure => {
    if (failure.organizationId === getRequestOrganizationId()) setError(failure.error)
  }), [])
  if (!error) return null
  const message = readableIssues(error)?.map(issue => t(issue.key, issue.params)).join(" · ") ?? (isUnexpectedFailure(error) ? t("ui.mutationError") : error.message || t("ui.mutationError"))
  return <div role="alert" className="m-4 flex items-center justify-between gap-4 rounded-md border p-4 text-destructive">
    <p>{message}</p>
    <Button variant="ghost" onClick={() => setError(null)}>{t("ui.close")}</Button>
  </div>
}
