import { useState } from "react"
import type { PublicDeliverableDto } from "../../lib/agreements/public"
import { submitPublicDeliverableDecision } from "../../lib/agreements/public-session"
import type { PublicSeller } from "../../lib/documents/public-presentation"
import { formatDate } from "../../lib/i18n/format"
import { useI18n } from "../../lib/i18n/react"
import { PublicSellerHeader } from "../documents/public-seller-header"
import { Button } from "../ui/button"
import { Label } from "../ui/label"
import { Textarea } from "../ui/textarea"
import { Badge } from "../ui/badge"

export function PublicDeliverablePage({ token, initial, seller }: { token: string; initial: PublicDeliverableDto; seller: PublicSeller }) {
  const { t, locale } = useI18n()
  const [line, setLine] = useState(initial)
  const [note, setNote] = useState("")
  const [confirmed, setConfirmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [invalid, setInvalid] = useState(false)
  // Agreed and expected dates are calendar dates: shown as stored, not shifted by a timezone.
  const calendarDate = (value: string) => formatDate(value, locale, "UTC")
  async function submit(decision: "accept" | "request_changes") {
    setBusy(true)
    setError(null)
    try {
      const result = await submitPublicDeliverableDecision({ data: { token, decision: decision === "accept" ? { decision, confirmed } : { decision, note } } })
      if (result.kind === "ready") setLine(result.deliverable)
      else if (result.kind === "invalid") setInvalid(true)
      else setError(t(result.kind === "retry_later" ? "agreements.retryLater" : "agreements.deliveryAlreadyDecided"))
    } catch {
      setError(t("agreements.error"))
    } finally { setBusy(false) }
  }
  if (invalid) return <main className="mx-auto max-w-lg px-4 py-20"><h1 className="text-2xl font-semibold">{t("agreements.invalidLink")}</h1></main>
  return <main className="mx-auto max-w-2xl px-4 py-12 grid gap-6 [overflow-wrap:anywhere]">
    <PublicSellerHeader seller={seller} />
    <header className="grid gap-2">
      <p>{t("agreements.document")} {line.agreementNumber}: {line.agreementTitle}</p>
      <h1 className="text-3xl font-semibold">{line.title}</h1>
      <Badge variant="outline">{t(`agreements.fulfillment.${line.status as "delivered" | "accepted" | "changes_requested"}`)}</Badge>
    </header>
    <p className="whitespace-pre-wrap">{line.description}</p>
    <p>{t("agreements.deliveryRevision")}: {line.deliveryRevision}</p>
    {line.agreedDate && <p>{t("agreements.agreedDate")}: {calendarDate(line.agreedDate)}</p>}
    {line.expectedDate && <p>{t("agreements.expectedDate")}: {calendarDate(line.expectedDate)}</p>}
    {line.acceptedAt && <p>{t("agreements.acceptedRevision")}: {line.acceptedRevision}</p>}
    {line.changeRequestNote && <section><h2 className="font-medium">{t("agreements.changeRequestNote")}</h2><p className="whitespace-pre-wrap">{line.changeRequestNote}</p></section>}
    {error && <p role="alert">{error}</p>}
    {line.status === "delivered" && <>
      <form className="grid gap-3" onSubmit={event => { event.preventDefault(); void submit("accept") }}>
        <label className="flex items-start gap-2"><input type="checkbox" checked={confirmed} disabled={busy} onChange={event => setConfirmed(event.target.checked)} />{t("agreements.confirmDelivery")}</label>
        <Button disabled={busy || !confirmed}>{t("agreements.acceptDelivery")}</Button>
      </form>
      <form className="grid gap-3" onSubmit={event => { event.preventDefault(); void submit("request_changes") }}>
        <Label htmlFor="change-request-note">{t("agreements.changeRequestNote")}</Label>
        <Textarea id="change-request-note" value={note} maxLength={5000} required disabled={busy} onChange={event => setNote(event.target.value)} />
        <Button variant="outline" disabled={busy || !note.trim()}>{t("agreements.requestChanges")}</Button>
      </form>
    </>}
  </main>
}
