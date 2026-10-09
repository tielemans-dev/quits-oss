import { useI18n } from "../../lib/i18n/react"
import { Button } from "../ui/button"
import { Panel } from "../kvit/panel"

/** The loading state keeps the shape of the page, so nothing jumps when the figures arrive. */
export function DashboardSkeleton() {
  const { t } = useI18n()
  const bar = "bg-foreground/8 animate-pulse rounded-full"
  const panel = "border-hairline bg-panel rounded-xl border"
  return (
    <div role="status" aria-live="polite" data-slot="dashboard-skeleton" className="@container">
      <span className="sr-only">{t("dashboard.loading")}</span>
      <div
        aria-hidden="true"
        className="grid gap-4 @2xl:grid-cols-2 @4xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] @4xl:items-start"
      >
        <div className="bg-brand/15 animate-pulse rounded-xl p-6 @2xl:col-span-2 @4xl:col-span-1">
          <span className={`${bar} block h-2.5 w-20`} />
          <span className={`${bar} mt-5 block h-12 w-3/4 max-w-sm`} />
          <span className={`${bar} mt-5 block h-2.5 w-1/2`} />
          <span className={`${bar} mt-8 block h-2 w-full`} />
        </div>
        <div className={`${panel} space-y-4 p-4`}>
          <span className={`${bar} block h-2.5 w-24`} />
          {[0, 1, 2].map((row) => (
            <div key={row} className="flex items-center gap-3" style={{ opacity: 1 - row * 0.2 }}>
              <span className="bg-foreground/8 size-7 shrink-0 animate-pulse rounded-lg" />
              <span className={`${bar} h-3 w-1/2`} />
              <span className={`${bar} ml-auto h-3 w-16`} />
            </div>
          ))}
        </div>
        <div className={`${panel} space-y-3 p-4`}>
          <span className={`${bar} block h-2.5 w-20`} />
          {[0, 1, 2, 3, 4].map((row) => (
            <div key={row} className="flex items-center gap-3" style={{ opacity: 1 - row * 0.14 }}>
              <span className="bg-foreground/8 size-5 shrink-0 animate-pulse rounded-[6px]" />
              <span className={`${bar} h-3 w-1/3`} />
              <span className={`${bar} ml-auto h-3 w-16`} />
            </div>
          ))}
        </div>
        <div className="space-y-4 @2xl:col-span-2 @4xl:col-span-1">
          <div className={`${panel} p-4`}>
            <span className={`${bar} block h-2.5 w-20`} />
            <div className="mt-6 flex h-28 items-end gap-1.5">
              {[35, 55, 40, 65, 50, 80, 45, 60, 70, 55, 75, 90].map((height, index) => (
                <span
                  key={index}
                  className="bg-foreground/8 flex-1 animate-pulse rounded-[5px]"
                  style={{ height: `${height}%` }}
                />
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

/** A calm error: nothing is lost, and the way forward is one button. */
export function DashboardError({ onRetry, retrying }: { onRetry: () => void; retrying: boolean }) {
  const { t } = useI18n()
  return (
    <Panel data-slot="dashboard-error" role="alert" className="mx-auto max-w-lg px-6 py-10 text-center">
      <h2 className="text-base font-semibold tracking-[-0.01em]">{t("dashboard.error.title")}</h2>
      <p className="text-muted-foreground mx-auto mt-1 max-w-sm text-sm">{t("dashboard.error.description")}</p>
      <Button type="button" variant="outline" className="mt-5" disabled={retrying} onClick={onRetry}>
        {t("dashboard.error.retry")}
      </Button>
    </Panel>
  )
}
