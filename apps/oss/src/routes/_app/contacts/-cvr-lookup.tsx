import type { CvrCompany } from "@quits/contracts/cvr"
import { isValidDanishCvr } from "@quits/contracts/onboarding"
import { useEffect, useState } from "react"
import { addressLines } from "../../../components/onboarding-v2/lookup-preview"
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

/**
 * Fills the customer form from the CVR register, with the lookup onboarding and the command bar use.
 * Renders nothing unless the runtime supplies a lookup (hosted); the fields stay editable either way.
 */
export function CvrLookup({ onFound }: { onFound: (customer: RegistryCustomer) => void }) {
  const { t, locale } = useI18n()
  const [available, setAvailable] = useState(false)
  const [cvr, setCvr] = useState("")
  const [pending, setPending] = useState(false)
  const [message, setMessage] = useState<{ key: TranslationKey; error: boolean; vars?: Record<string, string> } | null>(null)

  useEffect(() => {
    let cancelled = false
    trpc.cvr.customerAvailable.query().then((state) => { if (!cancelled) setAvailable(state.enabled) }).catch(() => {})
    return () => { cancelled = true }
  }, [])

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
      const unavailable = (err as { data?: { code?: string } }).data?.code === "NOT_IMPLEMENTED"
      setMessage({ key: unavailable ? "shell.request.customer.unavailable" : "shell.request.customer.lookupError", error: true })
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
