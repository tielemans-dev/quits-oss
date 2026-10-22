import type { CvrCompany } from "@quits/contracts/cvr"
import { isValidDanishCvr } from "@quits/contracts/onboarding"
import { useNavigate } from "@tanstack/react-router"
import { Check, ChevronsUpDown, Plus } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { z } from "zod"
import { cvrSaveLookupError } from "../lib/contacts/cvr-errors"
import type { TranslationKey } from "../lib/i18n/messages"
import { useI18n } from "../lib/i18n/react"
import { handledMutationError } from "../lib/query-refresh"
import { cn } from "../lib/utils"
import { trpc } from "../trpc/client"
import { Button } from "./ui/button"
import { Command, CommandGroup, CommandInput, CommandItem, CommandList } from "./ui/command"
import { Input } from "./ui/input"
import { Label } from "./ui/label"
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover"

type Contact = { id: string; name: string; taxId?: string | null }
type Props = {
  id: string; contacts: Contact[]; value: string; invalid?: boolean
  onChange: (contactId: string) => void
  /** Called after a customer from the register is saved; the form reloads its customers. */
  onCreated: (contactId: string) => void
}

/** Search params of the invoice form; "Opret manuelt" comes back with the new customer preselected. */
export const pickedContactSearch = (search: Record<string, unknown>): { contactId?: string } => ({ contactId: typeof search.contactId === "string" ? search.contactId : undefined })
const cvrDigits = (value: string) => value.replace(/^DK\s*/i, "").replace(/\s/g, "")
const emailSchema = z.string().trim().email()
const LOOKUP_TIMEOUT_MS = 15_000

/**
 * Picks an existing customer or adds one from the CVR register, with the search onboarding uses.
 * Without a lookup provider (self-hosted) it lists the customers and the manual path only.
 */
export function CustomerPicker({ id, contacts, value, invalid, onChange, onCreated }: Props) {
  const { t } = useI18n()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [available, setAvailable] = useState(false)
  const [query, setQuery] = useState("")
  const [matches, setMatches] = useState<CvrCompany[]>([])
  const [searching, setSearching] = useState(false)
  const [searched, setSearched] = useState(false)
  const [lookupError, setLookupError] = useState<TranslationKey | null>(null)
  const [chosen, setChosen] = useState<CvrCompany | null>(null)
  const [email, setEmail] = useState("")
  // An address the person typed survives picking another company.
  const emailTyped = useRef(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<TranslationKey | null>(null)
  const [created, setCreated] = useState<Contact | null>(null)

  useEffect(() => {
    let cancelled = false
    void Promise.resolve().then(() => trpc.cvr.customerAvailable.query()).then(state => { if (!cancelled) setAvailable(state.enabled) }).catch(() => {})
    return () => { cancelled = true }
  }, [])

  // As onboarding: a name searches 250 ms after typing from three characters, eight digits look the number up.
  useEffect(() => {
    const q = query.trim()
    const cvr = cvrDigits(q)
    const byNumber = /^\d+$/.test(cvr)
    setMatches([]); setSearched(false)
    setLookupError(byNumber && cvr.length === 8 && !isValidDanishCvr(cvr) ? "cvr.invalid" : null)
    if (!available || (byNumber ? cvr.length !== 8 || !isValidDanishCvr(cvr) : q.length < 3)) { setSearching(false); setSearched(true); return }
    const controller = new AbortController(), { signal } = controller
    const timer = setTimeout(() => {
      setSearching(true)
      // The server gives up on the register after 10 s; a request that never answers fails here instead of searching forever.
      const deadline = AbortSignal.any([signal, AbortSignal.timeout(LOOKUP_TIMEOUT_MS)])
      const request = byNumber ? trpc.cvr.customer.query({ cvr }, { signal: deadline }).then(company => (company ? [company] : [])) : trpc.cvr.customerSearch.query({ q }, { signal: deadline })
      request
        .then(result => { if (!signal.aborted) { setMatches(result); setSearched(true) } })
        .catch((err: { data?: { code?: string } }) => { if (!signal.aborted) setLookupError(err.data?.code === "NOT_IMPLEMENTED" ? "shell.request.customer.unavailable" : "shell.request.customer.lookupError") })
        .finally(() => { if (!signal.aborted) setSearching(false) })
    }, 250)
    // A cancelled lookup never answers, so it must not leave the picker searching.
    return () => { clearTimeout(timer); controller.abort(); setSearching(false) }
  }, [query, available])

  // Start fresh on open, so the closing popover does not switch views while it fades out.
  function toggle(next: boolean) {
    if (next) { setQuery(""); setChosen(null); setEmail(""); setError(null); emailTyped.current = false }
    setOpen(next)
  }
  const close = () => setOpen(false)

  function choose(company: CvrCompany) {
    setChosen(company); setError(null)
    if (!emailTyped.current) setEmail(company.email ?? "")
  }

  async function add() {
    if (!chosen || pending) return
    if (!emailSchema.safeParse(email).success) { setError("docForm.customer.emailInvalid"); return }
    setPending(true); setError(null)
    try {
      const contact = await trpc.contacts.create.mutate({ name: chosen.name, email: email.trim(), reuseCvr: true, registryCvr: chosen.cvr }, handledMutationError)
      setCreated({ id: contact.id, name: contact.name })
      onCreated(contact.id)
      close()
    } catch (err) { setError(cvrSaveLookupError(err) ?? "contacts.new.error.createFailed") } finally { setPending(false) }
  }

  const q = query.trim().toLowerCase()
  const shown = contacts.filter(contact => !q || contact.name.toLowerCase().includes(q) || (contact.taxId && cvrDigits(contact.taxId) === cvrDigits(q)))
  const known = new Set(contacts.map(contact => contact.taxId && cvrDigits(contact.taxId)))
  const fresh = matches.filter(company => !known.has(company.cvr))
  const selected = contacts.find(contact => contact.id === value) ?? (created?.id === value ? created : undefined)
  // The first customer starts here: the empty state says what to type rather than what is missing.
  const prompt: TranslationKey = available ? "docForm.customer.prompt" : "docForm.noContacts"
  const status: TranslationKey | null = searching ? "docForm.customer.searching" : lookupError
    ?? (!q ? (available || !contacts.length ? prompt : null) : searched && !shown.length && !fresh.length ? "docForm.customer.none" : null)

  return <Popover open={open} onOpenChange={toggle}>
    <PopoverTrigger asChild>
      <Button id={id} type="button" variant="outline" role="combobox" aria-expanded={open} aria-invalid={invalid} className="h-auto min-h-9 w-full justify-between font-normal whitespace-normal text-left">
        <span className={cn("min-w-0 break-words", !selected && "text-muted-foreground")}>{selected?.name ?? t(contacts.length ? "docForm.selectContact" : prompt)}</span>
        <ChevronsUpDown className="opacity-50" />
      </Button>
    </PopoverTrigger>
    <PopoverContent align="start" className="w-(--radix-popover-trigger-width) min-w-72 p-0">
      {chosen ? <div className="grid gap-3 p-3">
        <div className="text-sm break-words">
          <p className="font-medium">{chosen.name}</p>
          <p className="text-muted-foreground"><span className="tabular-nums">CVR {chosen.cvr}</span>{chosen.address && ` · ${chosen.address}`}</p>
        </div>
        <div className="grid gap-2">
          <Label htmlFor={`${id}-email`}>{t("docForm.customer.email")} *</Label>
          {/* Enter adds the customer instead of submitting the document form. */}
          <Input id={`${id}-email`} type="email" autoComplete="email" required autoFocus value={email} aria-invalid={!!error}
            onChange={event => { emailTyped.current = true; setEmail(event.target.value) }}
            onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); void add() } }} />
        </div>
        {error && <p role="alert" className="text-sm text-destructive">{t(error)}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" disabled={pending} onClick={() => setChosen(null)}>{t("docForm.customer.back")}</Button>
          <Button type="button" disabled={pending} onClick={() => void add()}>{t("docForm.customer.add")}</Button>
        </div>
      </div> : <Command shouldFilter={false}>
        <CommandInput value={query} onValueChange={setQuery} placeholder={t(available ? "docForm.customer.search" : "docForm.selectContact")} />
        <CommandList>
          {status && <p role="status" className="px-3 py-3 text-sm text-muted-foreground">{t(status)}</p>}
          {shown.length > 0 && <CommandGroup heading={t("docForm.customer.existing")}>
            {shown.map(contact => <CommandItem key={contact.id} value={contact.id} onSelect={() => { onChange(contact.id); close() }}>
              <span className="truncate">{contact.name}</span>{contact.id === value && <Check className="ml-auto" />}
            </CommandItem>)}
          </CommandGroup>}
          {fresh.length > 0 && <CommandGroup heading={t("docForm.customer.registry")}>
            {fresh.map(company => <CommandItem key={company.cvr} value={`cvr-${company.cvr}`} onSelect={() => choose(company)}>
              <span className="grid min-w-0"><span className="truncate">{company.name}</span><span className="truncate text-xs text-muted-foreground">CVR {company.cvr} · {company.address}</span></span>
            </CommandItem>)}
          </CommandGroup>}
          <CommandGroup>
            <CommandItem value="manual" onSelect={() => void navigate({ to: "/contacts/new", search: { returnTo: "/invoices/new" } })}><Plus />{t("docForm.customer.manual")}</CommandItem>
          </CommandGroup>
        </CommandList>
      </Command>}
    </PopoverContent>
  </Popover>
}
