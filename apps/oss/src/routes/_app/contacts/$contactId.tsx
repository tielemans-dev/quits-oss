import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useState, useEffect } from "react"
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
import { ClientLinksCard } from "../../../components/client-actions/client-links-card"

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
}

function EditContactPage() {
  const { t } = useI18n()
  const { contactId } = Route.useParams()
  const navigate = useNavigate()
  const [contact, setContact] = useState<ContactData | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    trpc.contacts.get
      .query({ id: contactId })
      .then((data) => setContact(data as ContactData))
      .catch(() => setError(t("contacts.edit.error.notFound")))
      .finally(() => setLoading(false))
  }, [contactId])

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

  if (loading) {
    return (
      <div className="p-6">
        <p className="text-muted-foreground">{t("contacts.loading")}</p>
      </div>
    )
  }

  if (!contact) {
    return (
      <div className="p-6">
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
    <div className="p-6 max-w-2xl grid gap-6">
      <Card>
        <CardHeader>
          <CardTitle>{t("contacts.edit.title")}</CardTitle>
        </CardHeader>
        <form onSubmit={handleSubmit}>
          <CardContent className="grid gap-4">
            {error && (
              <p className="text-sm text-destructive" role="alert">
                {error}
              </p>
            )}

            <div className="grid gap-2">
              <Label htmlFor="name">{t("contacts.field.name")} *</Label>
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
                name="company"
                maxLength={120}
                defaultValue={contact.company ?? ""}
              />
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
                <Input
                  id="country"
                  name="country"
                  maxLength={80}
                  defaultValue={contact.country ?? ""}
                />
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
      <ClientLinksCard contactId={contact.id} contactName={contact.name} contactEmail={contact.email} />
    </div>
  )
}
