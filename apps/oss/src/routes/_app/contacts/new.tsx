import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useState } from "react"
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

export const Route = createFileRoute("/_app/contacts/new")({
  component: NewContactPage,
})

function NewContactPage() {
  const { t } = useI18n()
  const navigate = useNavigate()
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

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
      await trpc.contacts.create.mutate({
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
      })
      navigate({ to: "/contacts" })
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : t("contacts.new.error.createFailed")
      )
      setSaving(false)
    }
  }

  return (
    <div className="p-6 max-w-2xl">
      <Card>
        <CardHeader>
          <CardTitle>{t("contacts.new.title")}</CardTitle>
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
                  pattern="^\+?[0-9()\-\s.]{6,20}$"
                  title={t("contacts.phone.invalid")}
                  placeholder={t("contacts.placeholder.phone")}
                />
              </div>
            </div>

            <div className="grid gap-2">
              <Label htmlFor="company">{t("contacts.field.company")}</Label>
              <Input
                id="company"
                name="company"
                maxLength={120}
                placeholder={t("contacts.placeholder.company")}
              />
            </div>

            <div className="grid gap-2">
              <Label htmlFor="address">{t("contacts.field.address")}</Label>
              <Input
                id="address"
                name="address"
                maxLength={240}
                placeholder={t("contacts.placeholder.address")}
              />
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              <div className="grid gap-2">
                <Label htmlFor="city">{t("contacts.field.city")}</Label>
                <Input id="city" name="city" maxLength={120} />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="state">{t("contacts.field.state")}</Label>
                <Input id="state" name="state" maxLength={120} />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="zip">{t("contacts.field.zip")}</Label>
                <Input id="zip" name="zip" maxLength={20} />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="country">{t("contacts.field.country")}</Label>
                <Input id="country" name="country" maxLength={80} />
              </div>
            </div>

            <div className="grid gap-2">
              <Label htmlFor="taxId">{t("contacts.field.taxId")}</Label>
              <Input
                id="taxId"
                name="taxId"
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
              onClick={() => navigate({ to: "/contacts" })}
            >
              {t("contacts.action.cancel")}
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? t("contacts.action.creating") : t("contacts.action.create")}
            </Button>
          </CardFooter>
        </form>
      </Card>
    </div>
  )
}
