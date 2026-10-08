import { Link } from "@tanstack/react-router"
import { Plus } from "lucide-react"

import { useI18n } from "../../lib/i18n/react"
import { cn } from "../../lib/utils"
import { Button } from "../ui/button"
import { Panel } from "../kvit/panel"
import { DocLink } from "./doc-link"
import type { Summary } from "./summary-model"
import { DoubleRule } from "./double-rule"

/** The same two buttons on both start states, so the first action is never a hunt. */
function NewInvoiceButton({ label }: { label: string }) {
  return (
    <Button asChild>
      <Link to="/invoices/new">
        <Plus />
        {label}
      </Link>
    </Button>
  )
}

/**
 * A ghost of the dashboard to come: a blue slab, a few bars, two rows. Pure decoration, with no
 * figures in it, so nothing on screen is a made-up number.
 */
function GhostDashboard() {
  return (
    <div
      aria-hidden="true"
      className="mx-auto w-full max-w-sm space-y-2.5 [mask-image:linear-gradient(to_bottom,black_55%,transparent)]"
    >
      <div className="bg-brand/90 relative overflow-hidden rounded-xl p-4">
        <span className="block h-2 w-16 rounded-full bg-white/35" />
        <span className="mt-4 block h-7 w-40 rounded-md bg-white/85" />
        <span className="mt-2 block h-1 w-40 rounded-full bg-white/50" />
        <span className="mt-0.5 block h-1 w-40 rounded-full bg-white/25" />
        <span className="mt-4 flex h-1.5 gap-0.5 rounded-full">
          <span className="w-1/3 rounded-full bg-white" />
          <span className="w-1/2 rounded-full bg-white/40" />
          <span className="w-1/6 rounded-full bg-[#ffbfb5]" />
        </span>
      </div>
      <div className="border-hairline bg-panel flex h-16 items-end gap-1 rounded-xl border p-3">
        {[30, 55, 40, 70, 45, 85].map((height, index) => (
          <span
            key={index}
            className={cn("flex-1 rounded-[3px]", index === 5 ? "bg-brand" : "bg-brand/25")}
            style={{ height: `${height}%` }}
          />
        ))}
      </div>
      {[0, 1].map((row) => (
        <div
          key={row}
          className="border-hairline bg-panel flex items-center gap-3 rounded-lg border px-3 py-2.5"
          style={{ opacity: 0.85 - row * 0.3 }}
        >
          <span className="bg-brand-soft size-5 shrink-0 rounded-[6px]" />
          <span className="bg-foreground/10 h-2.5 w-24 rounded-full" />
          <span className="bg-foreground/10 ml-auto h-2.5 w-14 rounded-full" />
        </div>
      ))}
    </div>
  )
}

/**
 * A brand-new organization. There is nothing to total, so there are no figures: a warm line about
 * what will appear here, and one clear action. A customer can be added first, as a quieter second
 * choice.
 */
export function FirstRun() {
  const { t } = useI18n()
  const points = [
    t("dashboard.welcome.point.incoming"),
    t("dashboard.welcome.point.attention"),
    t("dashboard.welcome.point.kvit"),
  ]

  return (
    <section
      data-slot="dashboard-first-run"
      className="border-hairline rounded-xl border border-dashed px-5 py-10 sm:px-8 sm:py-14"
    >
      <div className="mx-auto grid max-w-4xl items-center gap-10 md:grid-cols-[minmax(0,1fr)_minmax(0,20rem)] md:gap-14">
        <div>
          <h2 className="text-xl font-bold tracking-[-0.02em] sm:text-2xl">{t("dashboard.welcome.title")}</h2>
          <p className="text-muted-foreground mt-2 max-w-md text-sm sm:text-base">
            {t("dashboard.welcome.description")}
          </p>
          <ul className="mt-5 space-y-2 text-sm">
            {points.map((point) => (
              <li key={point} className="flex items-center gap-3">
                <DoubleRule className="text-foreground" />
                {point}
              </li>
            ))}
          </ul>
          <div className="mt-7 flex flex-wrap items-center gap-2">
            <NewInvoiceButton label={t("dashboard.welcome.action.invoice")} />
            <Button asChild variant="outline">
              <Link to="/contacts/new">{t("dashboard.welcome.action.contact")}</Link>
            </Button>
          </div>
        </div>
        <GhostDashboard />
      </div>
    </section>
  )
}

/**
 * In between: drafts or other first steps exist, but nothing has been sent, so no money is owed
 * and a "0,00 kr." would say nothing. It stands where the hero will be and points at the next step:
 * with one draft (an invoice or a quote), to carry on with it; with several, to the list of them
 * with their number; with none, to the invoices. The top bar already has "Ny", so this card does not offer it again.
 */
export function GettingStarted({ drafts, className }: { drafts: Summary["drafts"]; className?: string }) {
  const { t } = useI18n()
  return (
    <Panel data-slot="dashboard-getting-started" className={cn("flex flex-col justify-center p-5 sm:p-6", className)}>
      <span className="bg-brand-soft text-brand-text mb-4 grid size-9 place-items-center rounded-full">
        <DoubleRule />
      </span>
      <h2 className="text-lg font-bold tracking-[-0.02em] sm:text-xl">{t("dashboard.start.title")}</h2>
      <p className="text-muted-foreground mt-1.5 max-w-md text-sm">{t("dashboard.start.description")}</p>
      <div className="mt-5 flex flex-wrap items-center gap-2">
        {drafts.count === 1 && drafts.newestId && drafts.newestKind ? (
          <>
            <Button asChild>
              <DocLink kind={drafts.newestKind} id={drafts.newestId}>
                {t("dashboard.start.action.continue")}
              </DocLink>
            </Button>
            <Button asChild variant="outline">
              <Link to="/invoices">{t("dashboard.start.action.invoices")}</Link>
            </Button>
          </>
        ) : (
          <Button asChild>
            <Link to="/invoices">
              {drafts.count > 1 ? t("dashboard.start.action.drafts", { count: drafts.count }) : t("dashboard.start.action.invoices")}
            </Link>
          </Button>
        )}
      </div>
    </Panel>
  )
}
