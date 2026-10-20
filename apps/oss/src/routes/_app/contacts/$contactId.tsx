import { useQueryRevision } from "../../../hooks/use-query-refresh"
import { QueryError, QuerySkeleton } from "../../../components/query-state"
import { useBusinessBuyersOnly } from "../../../hooks/use-business-buyers-only"
import { CountrySelect } from "../../../components/country-select"
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useState, useEffect, type ReactNode } from "react"
import { trpc } from "../../../trpc/client"
import { Button } from "../../../components/ui/button"
import { AlertDialog, AlertDialogTrigger, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction } from "../../../components/ui/alert-dialog"
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
import { PageHeader } from "../../../components/kvit/page-header"
import { Pencil } from "lucide-react"
import { countryName } from "../../../lib/country-names"
import { useI18n } from "../../../lib/i18n/react"
import { PEPPOL_EAS_CODES } from "@quits/contracts/exports"
import { readPeppolEndpoint } from "./-peppol-endpoint"
import { contactSaveError } from "./-contact-save-error"
import { handledMutationError } from "../../../lib/query-refresh"
import { CompanyField } from "./-company-field"

export const Route = createFileRoute("/_app/contacts/$contactId")({
  // `?edit=true` opens the form directly, for links that send someone to fix the customer.
  validateSearch: (search: Record<string, unknown>): { edit?: boolean } =>
    search.edit === true || search.edit === "true" ? { edit: true } : {},
  component: ContactPage,
})

type ContactData = {
  id: string
  name: string
  email: string | null
  phone: string | null
  company: string | null
  address: string | null
  city: string | null
  state: string | null
  zip: string | null
  country: string | null
  taxId: string | null
  peppolEndpointId: string | null
  peppolEndpointScheme: string | null
  notes: string | null
  reminderUnsubscribedAt: Date | string | null
  canResumeReminders: boolean
}

/** Opening a customer shows what is on file, as invoices and quotes do; Edit switches to the form. */
function ContactPage() {
  const { t, locale } = useI18n()
  const { contactId } = Route.useParams()
  const { edit } = Route.useSearch()
  const query = useQueryRevision(["contacts"])
  const [loadError, setLoadError] = useState<unknown>(null)
  const navigate = useNavigate()
  const [contact, setContact] = useState<ContactData | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [resuming, setResuming] = useState(false)
  const businessOnly = useBusinessBuyersOnly()
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let current = true
    setLoadError(null)
    trpc.contacts.get
      .query({ id: contactId })
      .then((data) => { if (current) setContact(data as ContactData) })
      .catch((failure: unknown) => { if (current) { if ((failure as { data?: { code?: string } } | null)?.data?.code === "NOT_FOUND") { setContact(null); setError(null) } else setLoadError(failure) } })
      .finally(() => { if (current) setLoading(false) })
    return () => { current = false }
  }, [contactId, query.revision])

  async function resumeReminders() {
    setResuming(true)
    setError(null)
    try {
      await trpc.contacts.resumeReminders.mutate({ id: contactId })
      setContact(await trpc.contacts.get.query({ id: contactId }))
    } catch {
      setError(t("contacts.reminders.error"))
    } finally {
      setResuming(false)
    }
  }

  function showSummary() {
    navigate({ to: "/contacts/$contactId", params: { contactId }, search: {} })
  }

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
      await trpc.contacts.update.mutate({
        id: contactId,
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
        // Both fields empty sends null, which clears a saved endpoint.
        peppolEndpointId: peppol.peppolEndpointId,
        peppolEndpointScheme: peppol.peppolEndpointScheme,
        notes: (form.get("notes") as string) || undefined,
      }, handledMutationError)
      setContact(await trpc.contacts.get.query({ id: contactId }))
      setSaving(false)
      showSummary()
    } catch (err) {
      setError(contactSaveError(err, t, "contacts.edit.error.updateFailed"))
      setSaving(false)
    }
  }

  if (loadError && (!contact || contact.id !== contactId)) return <QueryError error={loadError} retry={query.refresh} />

  if (loading || (contact && contact.id !== contactId)) {
    return (
      <div>
        <QuerySkeleton />
      </div>
    )
  }

  if (!contact) {
    return (
      <div>
        <p className="text-destructive">
          {error ?? t("contacts.edit.error.notFound")}
        </p>
        <Button
          variant="outline"
          className="mt-4"
          onClick={() => navigate({ to: "/contacts" })}
        >
          {t("contacts.action.back")}
        </Button>
      </div>
    )
  }

  const place = [[contact.zip, contact.city].filter(Boolean).join(" "), contact.state].filter(Boolean).join(", ")
  const address = [contact.address, place, contact.country ? countryName(contact.country, locale) : null].filter(Boolean)
  const peppol = contact.peppolEndpointId ? [contact.peppolEndpointScheme, contact.peppolEndpointId].filter(Boolean).join(":") : null

  if (!edit) return (
    <div className="grid max-w-3xl gap-6">
      <Link to="/contacts" className="text-muted-foreground text-sm hover:underline">{t("contacts.action.back")}</Link>
      <PageHeader
        className="mb-0"
        title={contact.name}
        subtitle={contact.company && contact.company !== contact.name ? contact.company : undefined}
        actions={
          <Button asChild>
            <Link to="/contacts/$contactId" params={{ contactId }} search={{ edit: true }}>
              <Pencil />
              {t("contacts.action.edit")}
            </Link>
          </Button>
        }
      />
      {loadError ? <QueryError error={loadError} retry={query.refresh} /> : null}
      {error && <p className="text-sm text-destructive" role="alert">{error}</p>}

      <dl className="border-hairline grid border-t sm:grid-cols-[12rem_minmax(0,1fr)]">
        <Fact label={t("contacts.field.company")}>{contact.company}</Fact>
        <Fact label={t("contacts.field.email")}>{contact.email}</Fact>
        <Fact label={t("contacts.field.phone")}>{contact.phone}</Fact>
        <Fact label={t("contacts.field.address")}>{address.length ? address.map((line) => <span key={line} className="block">{line}</span>) : null}</Fact>
        <Fact label={t("contacts.field.taxId")}>{contact.taxId}</Fact>
        <Fact label={t("exports.contact.peppolEndpointId")}>{peppol}</Fact>
        <Fact label={t("contacts.field.notes")}>{contact.notes ? <span className="whitespace-pre-line">{contact.notes}</span> : null}</Fact>
      </dl>

      {contact.email && (
        <div className="grid gap-2 rounded-md border p-4" aria-busy={resuming}>
          <p className="text-sm font-medium" role="status">
            {t(contact.reminderUnsubscribedAt ? "contacts.reminders.stopped" : "contacts.reminders.active")}
          </p>
          <p className="text-sm text-muted-foreground">{t("contacts.reminders.scope", { email: contact.email })}</p>
          {contact.reminderUnsubscribedAt && contact.canResumeReminders && (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button type="button" variant="outline" className="justify-self-start" disabled={resuming}>
                  {t(resuming ? "contacts.reminders.resuming" : "contacts.reminders.resume")}
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>{t("contacts.reminders.resume")}</AlertDialogTitle>
                  <AlertDialogDescription>{t("contacts.reminders.confirm", { email: contact.email })}</AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>{t("contacts.action.cancel")}</AlertDialogCancel>
                  <AlertDialogAction onClick={resumeReminders}>{t("contacts.reminders.resume")}</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
        </div>
      )}
    </div>
  )

  return (
    <div>
      <Card>
        <CardHeader>
          <CardTitle>{t("contacts.edit.title")}</CardTitle>
        </CardHeader>
        <form onSubmit={handleSubmit}>
          <CardContent className="grid gap-4">
            {loadError ? <QueryError error={loadError} retry={query.refresh} /> : null}
            {error && (
              <p className="text-sm text-destructive" role="alert">
                {error}
              </p>
            )}

            <div className="grid gap-2">
              <Label htmlFor="name">{t("contacts.field.name")} {t("contacts.field.required")}</Label>
              <Input
                id="name"
                name="name"
                required
                maxLength={120}
                defaultValue={contact.name}
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
                  defaultValue={contact.email ?? ""}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="phone">{t("contacts.field.phone")}</Label>
                <Input
                  id="phone"
                  name="phone"
                  maxLength={40}
                  defaultValue={contact.phone ?? ""}
                />
              </div>
            </div>

            <CompanyField businessOnly={businessOnly} defaultValue={contact.company ?? ""} />

            <div className="grid gap-2">
              <Label htmlFor="address">{t("contacts.field.address")}</Label>
              <Input
                id="address"
                name="address"
                maxLength={240}
                defaultValue={contact.address ?? ""}
              />
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              <div className="grid gap-2">
                <Label htmlFor="city">{t("contacts.field.city")}</Label>
                <Input
                  id="city"
                  name="city"
                  maxLength={120}
                  defaultValue={contact.city ?? ""}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="state">{t("contacts.field.state")}</Label>
                <Input
                  id="state"
                  name="state"
                  maxLength={120}
                  defaultValue={contact.state ?? ""}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="zip">{t("contacts.field.zip")}</Label>
                <Input
                  id="zip"
                  name="zip"
                  maxLength={20}
                  defaultValue={contact.zip ?? ""}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="country">{t("contacts.field.country")}</Label>
                <CountrySelect id="country" name="country" value={contact.country} />
              </div>
            </div>

            <div className="grid gap-2">
              <Label htmlFor="taxId">{t("contacts.field.taxId")}</Label>
              <Input
                id="taxId"
                name="taxId"
                maxLength={40}
                defaultValue={contact.taxId ?? ""}
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
                    defaultValue={contact.peppolEndpointId ?? ""}
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
                    defaultValue={contact.peppolEndpointScheme ?? ""}
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
                rows={3}
                maxLength={5000}
                defaultValue={contact.notes ?? ""}
              />
            </div>
          </CardContent>
          <CardFooter className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={showSummary}
            >
              {t("contacts.action.cancel")}
            </Button>
            <Button type="submit" disabled={saving}>
              {saving
                ? t("contacts.action.saving")
                : t("contacts.action.saveChanges")}
            </Button>
          </CardFooter>
        </form>
      </Card>
    </div>
  )
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground pt-3 text-sm sm:border-hairline sm:border-b sm:pb-3">{label}</dt>
      <dd className="border-hairline border-b pt-1 pb-3 text-sm sm:pt-3">{children || <span className="text-muted-foreground">—</span>}</dd>
    </>
  )
}
