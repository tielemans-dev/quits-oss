import { isValidDanishCvr } from "@quits/contracts/onboarding"
import { useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { useI18n } from "../../lib/i18n/react"
import { trpc } from "../../trpc/client"
import { cn } from "../../lib/utils"
import { Button } from "../ui/button"
import { InvoiceRequestCard } from "./invoice-request-card"
import { stagger } from "./request-card-slot"
import type { RequestCardProps } from "./request-intent"

type Company = { cvr: string; name: string; address: string; id?: string }
const normalize = (value: string) => value.replace(/^DK\s*/i, "").replace(/\s/g, "")
const transition = "transition-[color,background-color,box-shadow]"

/** Registry reads only until the confirming click. The invoice stays an unsaved draft for review. */
export function CustomerRequestCard({ intent, onDismiss }: RequestCardProps) {
  const { t } = useI18n()
  const cvr = intent.input.replace(/^(?:ny\s+kunde\s*|cvr\s*:?\s*)/iu, "").replace(/^cvr\s*:?\s*/iu, "").trim()
  const [company, setCompany] = useState<Company | null>(null)
  const [contactId, setContactId] = useState("")
  const [created, setCreated] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [pending, setPending] = useState(false)
  const busy = useRef(false)
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!created) return
    const timer = setTimeout(() => setCreated(false), 8000)
    return () => clearTimeout(timer)
  }, [created])

  useEffect(() => {
    let cancelled = false
    const controller = new AbortController()
    setError(null); setCompany(null)
    if (!isValidDanishCvr(cvr)) { setError(t("cvr.invalid")); return }
    async function load() {
      try {
        const contacts = await trpc.contacts.list.query()
        if (cancelled) return
        const existing = contacts.find(contact => contact.taxId && normalize(contact.taxId) === cvr)
        const found = existing ? { cvr, id: existing.id, name: existing.name, address: [existing.address, existing.zip, existing.city].filter(Boolean).join(", ") } : await trpc.cvr.customer.query({ cvr }, { signal: controller.signal })
        if (cancelled) return
        if (!found) setError(t("shell.request.customer.notFound"))
        else setCompany(found)
      } catch (err) {
        if (!cancelled) setError(t((err as { data?: { code?: string } }).data?.code === "NOT_IMPLEMENTED" ? "shell.request.customer.unavailable" : "shell.request.customer.lookupError"))
      }
    }
    void load()
    return () => { cancelled = true; controller.abort() }
  }, [cvr, t, attempt])

  async function confirm() {
    if (!company || busy.current) return
    busy.current = true; setPending(true); setError(null)
    try {
      const contact = company.id ? { id: company.id, reused: true } : await trpc.contacts.create.mutate({
        name: company.name, company: company.name, address: company.address, country: "DK", taxId: cvr, reuseCvr: true,
      })
      setContactId(contact.id); setCreated(!contact.reused)
    } catch { setError(t("contacts.new.error.createFailed")) }
    finally { busy.current = false; setPending(false) }
  }

  async function undo() {
    if (busy.current) return
    busy.current = true; setPending(true); setError(null)
    try {
      // The existing delete command refuses a customer already used by an invoice or other document.
      await trpc.contacts.undoCreate.mutate({ id: contactId })
      setContactId(""); setCreated(false)
    } catch { setError(t("shell.request.customer.undoError")) }
    finally { busy.current = false; setPending(false) }
  }

  // Keep undo within the palette's focus trap; dashboard confirmations use the viewport corner.
  const dialog = root.current?.closest('[role="dialog"]')
  return <div ref={root}>
    {contactId ? <InvoiceRequestCard intent={{ kind: "invoice", input: `faktura til CVR ${cvr}` }} initialContactId={contactId} onDismiss={onDismiss} /> : <div className="space-y-4 p-4">
      <div {...stagger(0)} className="space-y-1 text-sm break-words">
        <h2 className="font-semibold">{company?.name ?? t("shell.request.title.customer")}</h2>
        {company ? <><p className="text-muted-foreground">{company.address}</p><p className="text-muted-foreground tabular-nums">CVR {cvr}</p></> : !error && <p role="status">{t("shell.request.customer.loading")}</p>}
        {company?.id && <p>{t("shell.request.customer.exists")}</p>}
      </div>
      <div {...stagger(1)} className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="outline" disabled={pending} onClick={onDismiss} className={transition}>{t("shell.request.dismiss")}</Button>
        {company && <Button type="button" disabled={pending} onClick={() => void confirm()} className={transition}>{t(company.id ? "shell.request.customer.use" : "shell.request.customer.create")}</Button>}
        {!company && error && <Button type="button" variant="outline" onClick={() => setAttempt(value => value + 1)} className={transition}>{t("shell.request.customer.retry")}</Button>}
      </div>
      {!company && error && <a href="/contacts/new" className="text-sm underline underline-offset-4">{t("shell.request.customer.manual")}</a>}
    </div>}
    {error && <p role="alert" className="text-destructive px-4 pb-4 text-sm">{error}</p>}
    {created && createPortal(<div role="status" className={cn("bg-popover text-popover-foreground border-hairline z-50 flex max-w-[calc(100vw-2rem)] items-center gap-4 rounded-2xl border p-4 shadow-sm", dialog ? "m-4" : "fixed right-4 bottom-4")}>
      <span className="text-sm">{t("shell.request.customer.created")}</span>
      <Button type="button" variant="outline" disabled={pending} onClick={() => void undo()} className={transition}>{t("shell.request.customer.undo")}</Button>
    </div>, dialog ?? document.body)}
  </div>
}
