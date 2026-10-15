import { useEffect, useMemo, useRef, useState } from "react"

import { formatCurrency } from "../../lib/i18n/format"
import { useI18n } from "../../lib/i18n/react"
import { remindedInvoiceIds } from "../../lib/jobs/reminder-tracker"
import { trpc } from "../../trpc/client"
import { tCount } from "../dashboard/i18n"
import { sendReminderBatch, useReminderJobs } from "../jobs/reminder-jobs-store"
import { Button } from "../ui/button"
import { MAX_BATCH, overdueInvoices, totalsByCurrency, type Invoice } from "./overdue-invoices"
import { stagger } from "./request-card-slot"
import type { RequestCardProps } from "./request-intent"
import { handOffToTracker } from "./tracker-handoff"

/**
 * The invoices the Fakturaer list shows as overdue (same status function, same reminded set), each
 * ticked to start with. "Send rykker til N" queues the existing reminder job for the ticked ones;
 * nothing is sent before that click, and a second try of the same selection queues nothing twice.
 */
export function OverdueRequestCard({ onDismiss }: RequestCardProps) {
  const { t, locale } = useI18n()
  const reminded = remindedInvoiceIds(useReminderJobs())
  const [loaded, setLoaded] = useState<{ invoices: Invoice[]; timezone: string | null } | null>(null)
  // Null until the person changes it: every overdue invoice, up to the limit.
  const [chosen, setChosen] = useState<ReadonlySet<string> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const sending = useRef(false)
  // One id per selection: a retry of the same click is the same request to the server.
  const request = useRef<{ key: string; id: string } | null>(null)
  const dismissRef = useRef(onDismiss)
  useEffect(() => { dismissRef.current = onDismiss })

  useEffect(() => {
    let cancelled = false
    Promise.all([trpc.invoices.list.query(), trpc.settings.get.query().catch(() => ({ timezone: null }))])
      .then(([invoices, settings]) => {
        if (cancelled) return
        setLoaded({ invoices: invoices as unknown as Invoice[], timezone: settings.timezone ?? null })
      })
      .catch(() => { if (!cancelled) setError(t("shell.request.overdue.error.load")) })
    return () => { cancelled = true }
  }, [t])

  const overdue = useMemo(
    () => (loaded ? overdueInvoices(loaded.invoices, loaded.timezone, reminded) : null),
    [loaded, reminded]
  )

  const ticked = (overdue ?? []).filter(({ invoice }, index) => (chosen ? chosen.has(invoice.id) : index < MAX_BATCH))
  const tickedIds = new Set(ticked.map(({ invoice }) => invoice.id))
  const full = ticked.length >= MAX_BATCH
  const totals = totalsByCurrency(ticked.map(({ invoice }) => invoice))

  function toggle(id: string) {
    const next = new Set(tickedIds)
    if (!next.delete(id)) next.add(id)
    setChosen(next)
  }

  function send() {
    if (sending.current || !ticked.length) return
    sending.current = true
    setPending(true)
    const ids = ticked.map(({ invoice }) => invoice.id)
    const key = ids.join()
    if (request.current?.key !== key) request.current = { key, id: crypto.randomUUID() }
    const id = request.current.id
    const surface = root.current?.closest("[data-slot=request-card-slot]") ?? root.current
    // The card becomes the spinner square and flies to the corner, where the tracker toast takes over.
    // The square owns the send and any retry; the same id keeps a retry from queueing twice.
    handOffToTracker(
      surface!.getBoundingClientRect(),
      () => sendReminderBatch(ids, id),
      { failed: t("shell.request.overdue.error.send"), retry: t("reminders.tracker.retry"), close: t("reminders.tracker.dismiss") }
    )
    dismissRef.current()
  }

  const button = "transition-[color,background-color,box-shadow]"
  return (
    <div ref={root} className="space-y-4 p-4">
      <p {...stagger(0)} className="font-semibold">{t("shell.request.title.overdue")}</p>
      {!overdue ? (
        <p {...stagger(1)} role={error ? "alert" : undefined} className={error ? "text-sm text-destructive" : "text-muted-foreground text-sm"}>
          {error ?? t("shell.request.overdue.loading")}
        </p>
      ) : overdue.length === 0 ? (
        <p {...stagger(1)} className="text-muted-foreground text-sm">{t("shell.request.overdue.empty")}</p>
      ) : (
        <>
          <ul {...stagger(1)} className="max-h-64 divide-y overflow-y-auto text-sm">
            {overdue.map(({ invoice, days }) => (
              <li key={invoice.id}>
                <label className="flex items-center gap-3 py-2">
                  <input
                    type="checkbox"
                    checked={tickedIds.has(invoice.id)}
                    disabled={pending || (full && !tickedIds.has(invoice.id))}
                    onChange={() => toggle(invoice.id)}
                    aria-label={t("shell.request.overdue.select", { number: invoice.number ?? "", customer: invoice.contact.name })}
                    className="accent-foreground size-4 shrink-0"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-semibold">{invoice.contact.name}</span>
                    <span className="text-muted-foreground block tabular-nums">
                      {invoice.number} · {tCount(t, "shell.request.overdue.days", days)}
                    </span>
                  </span>
                  <span className="tabular-nums">{formatCurrency(invoice.balanceDue, invoice.currency, locale)}</span>
                </label>
              </li>
            ))}
          </ul>
          <div {...stagger(2)} className="flex items-baseline justify-between gap-3 border-t pt-3 text-sm font-semibold tabular-nums">
            <span>{t("shell.request.overdue.total")}</span>
            <span>{totals.map(({ currency, amount }) => formatCurrency(amount, currency, locale)).join(" · ") || "—"}</span>
          </div>
          {overdue.length > MAX_BATCH && <p className="text-muted-foreground text-sm">{t("shell.request.overdue.limit")}</p>}
        </>
      )}
            <div {...stagger(3)} className="flex justify-end gap-2">
        {/* The shadcn default animates every property; name the ones that change. */}
        <Button type="button" variant="outline" onClick={onDismiss} disabled={pending} className={button}>{t("shell.request.dismiss")}</Button>
        {overdue && overdue.length > 0 && (
          <Button type="button" disabled={pending || !ticked.length} onClick={send} className={button}>
            {pending ? t("reminders.tracker.step.sending") : t("reminders.batch.send", { count: ticked.length })}
          </Button>
        )}
      </div>
    </div>
  )
}
