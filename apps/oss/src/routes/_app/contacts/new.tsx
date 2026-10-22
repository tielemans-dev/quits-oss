import { useBusinessBuyersOnly } from "../../../hooks/use-business-buyers-only"
import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useEffect, useRef, useState } from "react"
import { trpc } from "../../../trpc/client"
import { Button } from "../../../components/ui/button"
import { Input } from "../../../components/ui/input"
import { Label } from "../../../components/ui/label"
import { Textarea } from "../../../components/ui/textarea"
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "../../../components/ui/card"
import { useI18n } from "../../../lib/i18n/react"
import { PEPPOL_EAS_CODES } from "@quits/contracts/exports"
import { readPeppolEndpoint } from "./-peppol-endpoint"
import { contactSaveError } from "./-contact-save-error"
import { cvrSaveLookupError } from "../../../lib/contacts/cvr-errors"
import { handledMutationError } from "../../../lib/query-refresh"
import { CompanyField } from "./-company-field"
import { CvrLookup, type RegistryCustomer } from "./-cvr-lookup"
import { BillingAddressFields } from "./-billing-address"

/** The forms that send people here from their customer picker. */
const returnPaths = ["/invoices/new"] as const

export const Route = createFileRoute("/_app/contacts/new")({
  validateSearch: (search: Record<string, unknown>): { returnTo?: (typeof returnPaths)[number] } => ({
    returnTo: returnPaths.find(path => path === search.returnTo),
  }),
  component: NewContactPage,
})

/** How long the form waits for the organization's default country before it opens without one. */
const COUNTRY_LOOKUP_TIMEOUT_MS = 3000

function NewContactPage() {
  const { t } = useI18n()
  const navigate = useNavigate()
  const { returnTo } = Route.useSearch()
  const [saving, setSaving] = useState(false)
  const businessOnly = useBusinessBuyersOnly()
  const [error, setError] = useState<string | null>(null)
  const [organizationCountry, setOrganizationCountry] = useState<string | null>(null)
  // The form stays closed to submission until the default country answered, so a quick submit cannot drop it.
  // A failed or stalled lookup opens it with the country left to the person; an answer that arrives later still fills
  // the select until they choose one.
  const [countrySettled, setCountrySettled] = useState(false)
  // A CVR answer remounts the fields it fills (`key`), so they start from the register's values.
  const [prefill, setPrefill] = useState<{ key: number; customer: RegistryCustomer | null }>({ key: 0, customer: null })
  const formRef = useRef<HTMLFormElement>(null)
  function fillFromRegistry(customer: RegistryCustomer) {
    const typedName = (formRef.current?.elements.namedItem("name") as HTMLInputElement | null)?.value.trim()
    // A name the person typed survives the lookup. A name the previous lookup filled in does not.
    setPrefill(({ key, customer: previous }) => ({
      key: key + 1,
      customer: { ...customer, name: typedName && typedName !== previous?.name ? typedName : customer.name },
    }))
  }
  useEffect(() => {
    let cancelled = false
    const settle = () => { if (!cancelled) setCountrySettled(true) }
    const timeout = setTimeout(settle, COUNTRY_LOOKUP_TIMEOUT_MS)
    trpc.settings.get.query()
      .then(settings => { if (!cancelled) setOrganizationCountry(settings.countryCode) })
      .catch(() => {})
      .finally(settle)
    return () => { cancelled = true; clearTimeout(timeout) }
  }, [])

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError(null)
    setSaving(true)

    const form = new FormData(e.currentTarget)
    const peppol = readPeppolEndpoint(form)
    if (!peppol.ok) {
      setError(t(peppol.error))
      setSaving(false)
      return
    }

    try {
      const contact = await trpc.contacts.create.mutate({
        name: form.get("name") as string,
        email: (form.get("email") as string) || "",
        phone: (form.get("phone") as string) || undefined,
        company: (form.get("company") as string) || undefined,
        address: (form.get("address") as string) || undefined,
        city: (form.get("city") as string) || undefined,
        state: (form.get("state") as string) || undefined,
        zip: (form.get("zip") as string) || undefined,
        country: (form.get("country") as string) || undefined,
        taxId: (form.get("taxId") as string) || undefined,
        peppolEndpointId: peppol.peppolEndpointId ?? undefined,
        peppolEndpointScheme: peppol.peppolEndpointScheme ?? undefined,
        notes: (form.get("notes") as string) || undefined,
        // The server takes the legal name, CVR number and registered address from its own lookup.
        registryCvr: prefill.customer?.taxId,
      }, handledMutationError)
      navigate(returnTo ? { to: returnTo, search: { contactId: contact.id } } : { to: "/contacts/$contactId", params: { contactId: contact.id }, search: {} })
    } catch (err) {
      const lookupError = prefill.customer?.taxId ? cvrSaveLookupError(err) : null
      setError(lookupError ? t(lookupError) : contactSaveError(err, t, "contacts.new.error.createFailed"))
      setSaving(false)
    }
  }

  return (
    <div>
      <Card>
        <CardHeader>
          <CardTitle>{t("contacts.new.title")}</CardTitle>
        </CardHeader>
        <form ref={formRef} onSubmit={handleSubmit}>
          <CardContent className="grid gap-4">
            {error && (
              <p className="text-sm text-destructive" role="alert">
                {error}
              </p>
            )}

            <CvrLookup onFound={fillFromRegistry} />

            <div className="grid gap-2">
              <Label htmlFor="name">{t("contacts.field.name")} {t("contacts.field.required")}</Label>
              <Input
                key={`name-${prefill.key}`}
                id="name"
                name="name"
                defaultValue={prefill.customer?.name}
                required
                maxLength={120}
                placeholder={t("contacts.placeholder.name")}
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="grid gap-2">
                <Label htmlFor="email">{t("contacts.field.email")}</Label>
                <Input
                  id="email"
                  name="email"
                  type="email"
                  maxLength={254}
                  placeholder={t("contacts.placeholder.email")}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="phone">{t("contacts.field.phone")}</Label>
                <Input
                  id="phone"
                  name="phone"
                  maxLength={40}
                  placeholder={t("contacts.placeholder.phone")}
                />
              </div>
            </div>

            <CompanyField
              key={`company-${prefill.key}`}
              businessOnly={businessOnly}
              defaultValue={prefill.customer?.company}
              placeholder={t("contacts.placeholder.company")}
              locked={Boolean(prefill.customer)}
              names={prefill.customer ? [prefill.customer.company, ...(prefill.customer.secondaryNames ?? [])] : []}
            />

            <BillingAddressFields
              key={`billing-${prefill.key}`}
              billing={prefill.customer ?? {}}
              registered={prefill.customer}
              defaultCountry={organizationCountry}
              placeholder={t("contacts.placeholder.address")}
            />

            <div className="grid gap-2">
              <Label htmlFor="taxId">{t("contacts.field.taxId")}</Label>
              <Input
                key={`taxId-${prefill.key}`}
                id="taxId"
                name="taxId"
                defaultValue={prefill.customer?.taxId}
                readOnly={Boolean(prefill.customer)}
                aria-describedby={prefill.customer ? "registry-help" : undefined}
                maxLength={40}
                placeholder={t("contacts.placeholder.taxId")}
              />
            </div>

            <div className="grid gap-2">
              <div className="grid grid-cols-1 sm:grid-cols-[2fr_1fr] gap-4">
                <div className="grid gap-2">
                  <Label htmlFor="peppolEndpointId">{t("exports.contact.peppolEndpointId")}</Label>
                  <Input
                    id="peppolEndpointId"
                    name="peppolEndpointId"
                    maxLength={80}
                    placeholder={t("exports.contact.peppolEndpointId.placeholder")}
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="peppolEndpointScheme">{t("exports.contact.peppolEndpointScheme")}</Label>
                  <Input
                    id="peppolEndpointScheme"
                    name="peppolEndpointScheme"
                    inputMode="numeric"
                    maxLength={4}
                    pattern="^\d{4}$"
                    list="peppol-eas-codes"
                    title={t("exports.contact.peppolEndpointScheme.invalid")}
                    placeholder={t("exports.contact.peppolEndpointScheme.placeholder")}
                  />
                </div>
              </div>
              <datalist id="peppol-eas-codes">
                {PEPPOL_EAS_CODES.map((code) => (
                  <option key={code} value={code} />
                ))}
              </datalist>
              <p className="text-xs text-muted-foreground">{t("exports.contact.peppolHint")}</p>
            </div>

            <div className="grid gap-2">
              <Label htmlFor="notes">{t("contacts.field.notes")}</Label>
              <Textarea
                id="notes"
                name="notes"
                placeholder={t("contacts.placeholder.notes")}
                rows={3}
                maxLength={5000}
              />
            </div>
          </CardContent>
          <CardFooter className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => navigate({ to: returnTo ?? "/contacts" })}
            >
              {t("contacts.action.cancel")}
            </Button>
            <Button type="submit" disabled={saving || !countrySettled}>
              {saving ? t("contacts.action.creating") : t("contacts.action.create")}
            </Button>
          </CardFooter>
        </form>
      </Card>
    </div>
  )
}
