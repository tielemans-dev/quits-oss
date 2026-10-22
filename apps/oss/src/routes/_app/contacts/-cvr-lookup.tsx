import type { CvrCompany } from "@quits/contracts/cvr"
import { isValidDanishCvr } from "@quits/contracts/onboarding"
import { useEffect, useState } from "react"
import { RefreshCw } from "lucide-react"
import { addressLines } from "../../../lib/contacts/registry"
import { handledMutationError } from "../../../lib/query-refresh"
import { Button } from "../../../components/ui/button"
import { Input } from "../../../components/ui/input"
import { Label } from "../../../components/ui/label"
import { formatDate } from "../../../lib/i18n/format"
import type { TranslationKey } from "../../../lib/i18n/messages"
import { useI18n } from "../../../lib/i18n/react"
import { cn } from "../../../lib/utils"
import { trpc } from "../../../trpc/client"

/** The customer fields the CVR register answers for. */
export type RegistryCustomer = { name: string; company: string; address: string; zip: string; city: string; country: string; taxId: string }

/** "Vestergade 5, 8000 Aarhus C" becomes the street, postnr and by fields of the customer form. */
export function registryCustomer(company: CvrCompany): RegistryCustomer {
  const [street = "", place = ""] = addressLines(company.address)
  const postal = /^(\d{4})\s+(.+)$/.exec(place)
  return {
    name: company.name, company: company.name, address: street,
    zip: postal?.[1] ?? "", city: postal?.[2] ?? place, country: "DK", taxId: company.cvr,
  }
}

/** Whether the runtime supplies a CVR lookup (hosted). Self-hosted installs have none. */
export function useCvrLookupAvailable() {
  const [available, setAvailable] = useState(false)
  useEffect(() => {
    let cancelled = false
    void Promise.resolve().then(() => trpc.cvr.customerAvailable.query()).then((state) => { if (!cancelled) setAvailable(state.enabled) }).catch(() => {})
    return () => { cancelled = true }
  }, [])
  return available
}

/** The message for a failed register lookup: no such company, no lookup here, or the lookup failed. */
export function cvrLookupError(err: unknown): TranslationKey {
  const code = (err as { data?: { code?: string } }).data?.code
  return code === "NOT_FOUND" ? "shell.request.customer.notFound" : code === "NOT_IMPLEMENTED" ? "shell.request.customer.unavailable" : "shell.request.customer.lookupError"
}

/** Refreshes a CVR customer's legal name, CVR number and registered address from the register. */
export function CvrRefreshButton({ contactId, onRefreshed, onError }: { contactId: string; onRefreshed: () => void; onError: (key: TranslationKey) => void }) {
  const { t } = useI18n()
  const [pending, setPending] = useState(false)
  async function refresh() {
    setPending(true)
    try {
      await trpc.contacts.refreshFromCvr.mutate({ id: contactId }, handledMutationError)
      onRefreshed()
    } catch (err) {
      onError(cvrLookupError(err))
    } finally {
      setPending(false)
    }
  }
  return (
    <Button type="button" variant="outline" disabled={pending} onClick={() => void refresh()}>
      <RefreshCw />
      {t(pending ? "contacts.cvr.refreshing" : "contacts.cvr.refresh")}
    </Button>
  )
}

/**
 * Fills the customer form from the CVR register, with the lookup onboarding and the command bar use.
 * Renders nothing unless the runtime supplies a lookup (hosted). The register's name and CVR number
 * then stay locked; the rest of the form stays editable.
 */
export function CvrLookup({ onFound }: { onFound: (customer: RegistryCustomer) => void }) {
  const { t, locale } = useI18n()
  const available = useCvrLookupAvailable()
  const [cvr, setCvr] = useState("")
  const [pending, setPending] = useState(false)
  const [message, setMessage] = useState<{ key: TranslationKey; error: boolean; vars?: Record<string, string> } | null>(null)

  if (!available) return null

  async function lookup() {
    const value = cvr.replace(/^DK\s*/i, "").replace(/\s/g, "")
    if (!isValidDanishCvr(value)) { setMessage({ key: "cvr.invalid", error: true }); return }
    setPending(true)
    setMessage(null)
    try {
      const company = await trpc.cvr.customer.query({ cvr: value })
      if (!company) setMessage({ key: "shell.request.customer.notFound", error: true })
      else {
        onFound(registryCustomer(company))
        // A ceased or bankrupt company still fills the form, but the hint says so instead of confirming.
        if (company.status === "active") setMessage({ key: "contacts.cvr.filled", error: false })
        else setMessage({
          key: company.statusDate ? "contacts.cvr.inactive" : "contacts.cvr.inactiveUndated",
          error: true,
          vars: {
            status: t(`onboardingV2.status.${company.status}`),
            date: company.statusDate ? formatDate(company.statusDate, locale, "UTC", { month: "short", dayFirst: true }) : "",
          },
        })
      }
    } catch (err) {
      setMessage({ key: cvrLookupError(err), error: true })
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="grid gap-2">
      <Label htmlFor="cvrLookup">{t("contacts.cvr.label")}</Label>
      <div className="flex gap-2">
        <Input
          id="cvrLookup"
          inputMode="numeric"
          autoComplete="off"
          maxLength={14}
          placeholder="12345678"
          value={cvr}
          aria-describedby="cvrLookup-status"
          onChange={(event) => setCvr(event.target.value)}
          // Enter looks the number up instead of submitting the half-filled form.
          onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void lookup() } }}
        />
        <Button type="button" variant="outline" disabled={pending} onClick={() => void lookup()}>
          {t(pending ? "contacts.cvr.looking" : "contacts.cvr.action")}
        </Button>
      </div>
      <p id="cvrLookup-status" role="status" className={cn("text-sm", message?.error ? "text-destructive" : "text-muted-foreground")}>
        {t(message?.key ?? "contacts.cvr.hint", message?.vars)}
      </p>
    </div>
  )
}
