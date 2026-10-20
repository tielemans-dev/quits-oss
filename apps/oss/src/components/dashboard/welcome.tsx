import { Link } from "@tanstack/react-router"
import { Plus } from "lucide-react"

import { useI18n } from "../../lib/i18n/react"
import { Button } from "../ui/button"
import { DocLink } from "./doc-link"
import type { Summary } from "./summary-model"
import { DoubleRule } from "./double-rule"
import { DashboardSection } from "./section"

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
 * A brand-new organization. There is nothing to total, so there are no figures: a warm line about
 * what will appear here, and one clear action. A customer can be added first, as a quieter second
 * choice.
 */
export function FirstRun({ readyCompany }: { readyCompany?: string } = {}) {
  const { t } = useI18n()
  const points = [
    t("dashboard.welcome.point.incoming"),
    t("dashboard.welcome.point.attention"),
    t("dashboard.welcome.point.kvit"),
  ]

  return (
    <section
      data-slot="dashboard-first-run"
      className="grid items-start gap-10 md:grid-cols-[minmax(0,1fr)_minmax(0,20rem)] md:gap-14"
    >
      <div>
        <h2 className="text-xl font-medium tracking-[-0.02em] text-balance">
          {readyCompany ? t("onboardingV2.ready.heading", { company: readyCompany }) : t("dashboard.welcome.title")}
        </h2>
        <p className="text-muted-foreground mt-2 max-w-md text-sm">
          {readyCompany ? t("onboardingV2.ready.sub") : t("dashboard.welcome.description")}
        </p>
        {readyCompany ? (
          <div className="mt-5 space-y-1 text-sm">
            <p className="text-muted-foreground text-xs">{t("onboardingV2.ready.tag")}</p>
            <h3 className="font-medium">{t("onboardingV2.ready.first")}</h3>
            <p className="text-muted-foreground">{t("onboardingV2.ready.firstBody")}</p>
          </div>
        ) : null}
        <div className="mt-6 flex flex-wrap items-center gap-2">
          <NewInvoiceButton label={readyCompany ? t("onboardingV2.ready.create") : t("dashboard.welcome.action.invoice")} />
          <Button asChild variant="outline">
            <Link to="/contacts/new">{t("dashboard.welcome.action.contact")}</Link>
          </Button>
        </div>
      </div>
      {readyCompany ? (
        <ul className="text-sm">
          <li className="border-hairline border-t py-3">
            <Link to="/contacts/new" className="hover:text-foreground text-muted-foreground transition-colors">{t("onboardingV2.ready.customers")}</Link>
          </li>
          <li className="border-hairline border-t py-3">
            <Link to="/settings" className="hover:text-foreground text-muted-foreground transition-colors">{t("onboardingV2.ready.settings")}</Link>
          </li>
        </ul>
      ) : (
        <ul className="text-sm">
          {points.map((point) => (
            <li key={point} className="border-hairline flex items-center gap-3 border-t py-3">
              <DoubleRule className="text-muted-foreground" />
              {point}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/**
 * In between: drafts or other first steps exist, but nothing has been sent, so no money is owed
 * and a "0,00 kr." would say nothing. It stands where the hero will be and points at the next step,
 * and every action lands where a draft is:
 * - one draft: continue it, an invoice or a quote by its kind;
 * - several: continue the newest, with a quiet link to the list of its kind. The summary has only
 *   a total and the newest kind, so the text claims the total and the link never claims a count
 *   (the drafts may be of both kinds);
 * - none: the invoices.
 * It takes the place of Udestående, under its heading. The top bar already has "Ny", so this does
 * not offer it again.
 */
export function GettingStarted({ drafts, className }: { drafts: Summary["drafts"]; className?: string }) {
  const { t } = useI18n()
  const newest = drafts.count > 0 && drafts.newestId && drafts.newestKind ? { id: drafts.newestId, kind: drafts.newestKind } : null
  const listOfNewest = newest?.kind === "quote" ? "/quotes" : "/invoices"
  return (
    <DashboardSection title={t("dashboard.hero.label")} data-slot="dashboard-getting-started" className={className}>
      <div className="border-hairline border-t pt-4">
        <p className="text-base font-medium tracking-[-0.01em]">{t("dashboard.start.title")}</p>
        <p className="text-muted-foreground mt-1 max-w-md text-sm">
          {drafts.count > 1 ? t("dashboard.start.descriptionDrafts", { count: drafts.count }) : t("dashboard.start.description")}
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          {newest ? (
            <>
              <Button asChild size="sm">
                <DocLink kind={newest.kind} id={newest.id}>
                  {drafts.count > 1 ? t("dashboard.start.action.continueNewest") : t("dashboard.start.action.continue")}
                </DocLink>
              </Button>
              <Button asChild variant="outline" size="sm">
                <Link to={listOfNewest}>
                  {newest.kind === "quote" ? t("dashboard.start.action.quotes") : t("dashboard.start.action.invoices")}
                </Link>
              </Button>
            </>
          ) : (
            <Button asChild size="sm">
              <Link to="/invoices">{t("dashboard.start.action.invoices")}</Link>
            </Button>
          )}
        </div>
      </div>
    </DashboardSection>
  )
}
