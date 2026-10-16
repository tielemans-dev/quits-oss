import { Check } from "lucide-react"
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react"

import { formatIsoDate } from "../../lib/exports/format"
import { formatCurrency, formatDate } from "../../lib/i18n/format"
import { useI18n } from "../../lib/i18n/react"
import { DURATION, EASE_ENTER } from "../../lib/motion"
import { matchPayment, parsePaymentRequest, type Candidate, type MatchInvoice } from "../../lib/payments/payment-match"
import { cn } from "../../lib/utils"
import { trpc } from "../../trpc/client"
import { useShellPermissions } from "../shell/use-shell-permissions"
import { Button } from "../ui/button"
import { stagger } from "./request-card-slot"
import type { RequestCardProps } from "./request-intent"

/** How long Fortryd stays after the payment is recorded (the check holds for the same time). */
const UNDO_MS = 8000
const button = "transition-[color,background-color,box-shadow]"

/**
 * A payment that came in, matched to the invoice it pays. Logic proposes; the click decides. An
 * exact amount with the invoice number in the reference is one card; anything less sure is a
 * shortlist to pick from. Marking paid records the received amount through `payments.record`
 * (the server refuses more than the balance), and Fortryd voids that payment again.
 */
export function PaymentMatchCard({ intent, onDismiss }: RequestCardProps) {
  const { t, locale } = useI18n()
  const { can } = useShellPermissions()
  const payment = useMemo(() => parsePaymentRequest(intent.input), [intent.input])
  const [loaded, setLoaded] = useState<{ invoices: MatchInvoice[]; timezone: string | null } | null>(null)
  const [picked, setPicked] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [done, setDone] = useState<{ paymentId: string; candidate: Candidate; undone: boolean } | null>(null)
  const sending = useRef(false)
  // One id per payment and invoice: a retry of the same click is the same request to the server.
  const request = useRef<{ key: string; id: string } | null>(null)
  const dismissRef = useRef(onDismiss)
  useEffect(() => { dismissRef.current = onDismiss })

  useEffect(() => {
    let cancelled = false
    Promise.all([trpc.invoices.list.query(), trpc.settings.get.query().catch(() => ({ timezone: null }))])
      .then(([invoices, settings]) => { if (!cancelled) setLoaded({ invoices: invoices as unknown as MatchInvoice[], timezone: settings.timezone ?? null }) })
      .catch(() => { if (!cancelled) setError(t("shell.request.payment.error.load")) })
    return () => { cancelled = true }
  }, [t])

  const match = useMemo(() => payment && loaded && matchPayment(payment, loaded.invoices), [payment, loaded])
  const today = loaded ? formatIsoDate(new Date(), loaded.timezone) : null
  const candidates = match?.kind === "exact" ? [match.candidate] : match?.kind === "shortlist" ? match.candidates : []
  const chosen = match?.kind === "exact" ? match.candidate : candidates.find(c => c.invoice.id === picked)
  const money = (minor: number, currency: string) => formatCurrency(minor / 100, currency, locale)

  async function markPaid() {
    if (sending.current || !payment || !chosen || !today) return
    sending.current = true
    setPending(true); setError(null)
    const key = `${intent.input}|${chosen.invoice.id}`
    if (request.current?.key !== key) request.current = { key, id: crypto.randomUUID() }
    try {
      // The amount received, exactly: whole øre divided by 100 is a number with two decimals, which the server reads back as the same øre.
      const result = await trpc.payments.record.mutate({
        invoiceId: chosen.invoice.id, amount: payment.amountMinor / 100, paidAt: today, method: "bank_transfer",
        reference: payment.reference || undefined, requestId: request.current.id,
      })
      setDone({ paymentId: result.payment.id, candidate: chosen, undone: false })
    } catch {
      setError(t("shell.request.payment.error.record"))
    } finally { sending.current = false; setPending(false) }
  }

  async function undo() {
    if (!done || done.undone) return
    try {
      await trpc.payments.void.mutate({ paymentId: done.paymentId, reason: t("shell.request.payment.undoReason") })
      setDone({ ...done, undone: true })
    } catch { setError(t("shell.request.payment.error.undo")) }
  }

  // The check holds while Fortryd is on offer, then lets go.
  const [leaving, setLeaving] = useState(false)
  useEffect(() => {
    if (!done) return
    const leave = setTimeout(() => setLeaving(true), UNDO_MS)
    const close = setTimeout(() => dismissRef.current(), UNDO_MS + DURATION.leave)
    return () => { clearTimeout(leave); clearTimeout(close) }
  }, [done?.paymentId])

  if (done) {
    const { invoice } = done.candidate
    return (
      <div
        role="status"
        className={cn("request-stagger flex items-center gap-3 overflow-hidden p-6", leaving && "scale-90 opacity-0 transition-[opacity,transform] motion-reduce:scale-100")}
        style={{ "--stagger-delay": `${DURATION.squareShrink}ms`, ...(leaving && { transitionDuration: `${DURATION.leave}ms`, transitionTimingFunction: EASE_ENTER }) } as CSSProperties}
      >
        <span {...stagger(0)} className="bg-tone-success/15 text-tone-success flex size-9 shrink-0 items-center justify-center rounded-full">
          <Check className="size-5" aria-hidden="true" />
        </span>
        <div {...stagger(1)} className="min-w-0 flex-1">
          <p className="font-semibold">{t(done.undone ? "shell.request.payment.undone" : done.candidate.shortMinor ? "shell.request.payment.recorded" : "shell.request.payment.paid")}</p>
          <p className="text-muted-foreground truncate text-sm tabular-nums">{[invoice.number, invoice.contact.name].filter(Boolean).join(" · ")}</p>
        </div>
        {!done.undone && can("payment:void") && (
          <Button {...stagger(2)} type="button" variant="outline" onClick={() => void undo()} className={button}>{t("shell.request.payment.undo")}</Button>
        )}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      </div>
    )
  }

  const row = (c: Candidate) => (
    <span className="min-w-0 flex-1">
      <span className="block truncate font-semibold">{c.invoice.contact.name}</span>
      <span className="text-muted-foreground block tabular-nums">
        {c.invoice.number}{c.shortMinor > 0 && ` · ${t("shell.request.payment.short", { amount: money(c.shortMinor, c.invoice.currency) })}`}
      </span>
    </span>
  )

  return (
    <div className="space-y-4 overflow-hidden p-4">
      <p {...stagger(0)} className="font-semibold">{t("shell.request.title.payment")}</p>
      {payment && (
        <dl {...stagger(1)} className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-muted-foreground">{t("shell.request.payment.payer")}</dt><dd className="truncate">{payment.payer || "—"}</dd>
          <dt className="text-muted-foreground">{t("shell.request.payment.amount")}</dt><dd className="font-semibold tabular-nums">{money(payment.amountMinor, payment.currency)}</dd>
          <dt className="text-muted-foreground">{t("shell.request.payment.date")}</dt><dd className="tabular-nums">{today ? formatDate(today, locale) : "—"}</dd>
          <dt className="text-muted-foreground">{t("shell.request.payment.reference")}</dt><dd className="truncate">{payment.reference || "—"}</dd>
        </dl>
      )}
      {!match ? (
        <p {...stagger(2)} role={error ? "alert" : undefined} className={error ? "text-sm text-destructive" : "text-muted-foreground text-sm"}>
          {error ?? (payment ? t("shell.request.payment.loading") : t("shell.request.payment.error.read"))}
        </p>
      ) : match.kind === "none" ? (
        <p {...stagger(2)} className="text-muted-foreground text-sm">{t("shell.request.payment.none")}</p>
      ) : (
        <ul {...stagger(2)} aria-label={t("shell.request.payment.matches")} className="max-h-56 divide-y overflow-y-auto border-t text-sm">
          {candidates.map(c => (
            <li key={c.invoice.id}>
              <label className="flex items-center gap-3 py-2">
                {match.kind === "shortlist" && (
                  <input type="radio" name="payment-match" checked={picked === c.invoice.id} disabled={pending} onChange={() => setPicked(c.invoice.id)}
                    aria-label={t("shell.request.overdue.select", { number: c.invoice.number ?? "", customer: c.invoice.contact.name })} className="accent-foreground size-4 shrink-0" />
                )}
                {row(c)}
                <span className="tabular-nums">{formatCurrency(c.invoice.balanceDue, c.invoice.currency, locale)}</span>
              </label>
            </li>
          ))}
        </ul>
      )}
      {error && match && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <div {...stagger(3)} className="flex justify-end gap-2">
        {/* The shadcn default animates every property; name the ones that change. */}
        <Button type="button" variant="outline" onClick={onDismiss} disabled={pending} className={button}>{t("shell.request.dismiss")}</Button>
        {candidates.length > 0 && (
          <Button type="button" disabled={pending || !chosen} onClick={() => void markPaid()} className={button}>
            {t(chosen && chosen.shortMinor > 0 ? "shell.request.payment.recordPartial" : "shell.request.payment.markPaid")}
          </Button>
        )}
      </div>
    </div>
  )
}
