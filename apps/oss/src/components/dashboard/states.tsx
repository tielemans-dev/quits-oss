import { useI18n } from "../../lib/i18n/react"
import { Button } from "../ui/button"

/** The loading state keeps the shape of the page, so nothing jumps when the figures arrive. */
export function DashboardSkeleton() {
  const { t } = useI18n()
  const bar = "bg-foreground/8 block animate-pulse rounded-full"
  const rows = (count: number) =>
    Array.from({ length: count }, (_, row) => (
      <div key={row} className="border-hairline flex items-center gap-4 border-t py-4" style={{ opacity: 1 - row * 0.18 }}>
        <span className={`${bar} h-3 w-2/5`} />
        <span className={`${bar} ml-auto h-3 w-16`} />
      </div>
    ))
  return (
    <div role="status" aria-live="polite" data-slot="dashboard-skeleton" className="@container">
      <span className="sr-only">{t("dashboard.loading")}</span>
      <div aria-hidden="true" className="grid gap-10 @4xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] @4xl:items-start @4xl:gap-x-12">
        <div className="space-y-10">
          <div>
            <span className={`${bar} mb-3 h-3 w-36`} />
            {rows(3)}
          </div>
          <div>
            <span className={`${bar} mb-3 h-3 w-24`} />
            <div className="border-hairline border-t pt-4">
              <span className={`${bar} h-8 w-48`} />
              <span className={`${bar} mt-5 h-2 w-full`} />
            </div>
          </div>
        </div>
        <div>
          <span className={`${bar} mb-3 h-3 w-24`} />
          {rows(4)}
        </div>
      </div>
    </div>
  )
}

/** A calm error: nothing is lost, and the way forward is one button. */
export function DashboardError({ onRetry, retrying }: { onRetry: () => void; retrying: boolean }) {
  const { t } = useI18n()
  return (
    <div data-slot="dashboard-error" role="alert" className="mx-auto max-w-lg py-10 text-center">
      <h2 className="text-base font-medium tracking-[-0.01em]">{t("dashboard.error.title")}</h2>
      <p className="text-muted-foreground mx-auto mt-1 max-w-sm text-sm">{t("dashboard.error.description")}</p>
      <Button type="button" variant="outline" className="mt-5" disabled={retrying} onClick={onRetry}>
        {t("dashboard.error.retry")}
      </Button>
    </div>
  )
}
