import { useQueryRevision } from "../../../hooks/use-query-refresh"
import { QueryError, QuerySkeleton } from "../../../components/query-state"
import { useBusinessBuyersOnly } from "../../../hooks/use-business-buyers-only"
import { CountrySelect } from "../../../components/country-select"
import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useState, useEffect } from "react"
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
import { useI18n } from "../../../lib/i18n/react"
import { PEPPOL_EAS_CODES } from "@quits/contracts/exports"
import { readPeppolEndpoint } from "./-peppol-endpoint"

export const Route = createFileRoute("/_app/contacts/$contactId")({
  component: EditContactPage,
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

function EditContactPage() {
  const { t } = useI18n()
  const { contactId } = Route.useParams()
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
      })
      navigate({ to: "/contacts" })
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : t("contacts.edit.error.updateFailed")
      )
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

            {contact.email && (
              <div className="grid gap-2 rounded-md border p-4" aria-busy={resuming}>
                <p className="text-sm font-medium" role="status">
                  {t(contact.reminderUnsubscribedAt ? "contacts.reminders.stopped" : "contacts.reminders.active")}
                </p>
                <p className="text-sm text-muted-foreground">{t("contacts.reminders.scope", { email: contact.email })}</p>
                {contact.reminderUnsubscribedAt && contact.canResumeReminders && (
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button type="button" variant="outline" disabled={resuming}>
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
                  pattern="^\+?[0-9()\-\s.]{6,20}$"
                  title={t("contacts.phone.invalid")}
                  defaultValue={contact.phone ?? ""}
                />
              </div>
            </div>

            <div className="grid gap-2">
              <Label htmlFor="company">{t("contacts.field.company")}</Label>
              <Input
                id="company"
                aria-describedby={businessOnly ? "company-help" : undefined}
                name="company"
                maxLength={120}
                defaultValue={contact.company ?? ""}
              />
              {businessOnly && <p id="company-help" className="text-sm text-muted-foreground">{t("contacts.businessOnly.help")}</p>}
            </div>

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
              onClick={() => navigate({ to: "/contacts" })}
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
