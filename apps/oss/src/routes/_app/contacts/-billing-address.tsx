import { useState } from "react"
import { CountrySelect } from "../../../components/country-select"
import { Input } from "../../../components/ui/input"
import { Label } from "../../../components/ui/label"
import { Switch } from "../../../components/ui/switch"
import { useI18n } from "../../../lib/i18n/react"

type Address = { address?: string | null; city?: string | null; state?: string | null; zip?: string | null; country?: string | null }
export type RegisteredAddress = { address: string; zip: string; city: string }

const same = (billing: Address, registered: RegisteredAddress) =>
  (billing.address ?? "") === registered.address && (billing.zip ?? "") === registered.zip && (billing.city ?? "") === registered.city

/**
 * The customer's billing address fields. A CVR customer has a registered address too; billing uses it
 * until someone switches that off and enters an address of their own.
 */
export function BillingAddressFields({ billing, registered, defaultCountry, placeholder }: {
  billing: Address
  registered: RegisteredAddress | null
  /** The select's country while `billing.country` is undefined, as on a new customer. */
  defaultCountry?: string | null
  placeholder?: string
}) {
  const { t } = useI18n()
  const [useRegistered, setUseRegistered] = useState(registered !== null && same(billing, registered))
  return (
    <>
      {registered && (
        <div className="grid gap-2">
          <label className="flex justify-between gap-3 text-sm font-medium">
            {t("contacts.billing.useRegistered")}
            <Switch checked={useRegistered} onCheckedChange={setUseRegistered} />
          </label>
          {useRegistered && (
            <p className="text-sm text-muted-foreground">
              {[registered.address, [registered.zip, registered.city].filter(Boolean).join(" ")].filter(Boolean).join(", ")}
              <input type="hidden" name="address" value={registered.address} />
              <input type="hidden" name="zip" value={registered.zip} />
              <input type="hidden" name="city" value={registered.city} />
              <input type="hidden" name="country" value="DK" />
            </p>
          )}
        </div>
      )}
      {!useRegistered && (
        <>
          <div className="grid gap-2">
            <Label htmlFor="address">{t("contacts.field.address")}</Label>
            <Input id="address" name="address" maxLength={240} defaultValue={billing.address ?? ""} placeholder={placeholder} />
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <div className="grid gap-2">
              <Label htmlFor="city">{t("contacts.field.city")}</Label>
              <Input id="city" name="city" maxLength={120} defaultValue={billing.city ?? ""} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="state">{t("contacts.field.state")}</Label>
              <Input id="state" name="state" maxLength={120} defaultValue={billing.state ?? ""} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="zip">{t("contacts.field.zip")}</Label>
              <Input id="zip" name="zip" maxLength={20} defaultValue={billing.zip ?? ""} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="country">{t("contacts.field.country")}</Label>
              <CountrySelect id="country" name="country" value={billing.country} defaultCountry={defaultCountry} />
            </div>
          </div>
        </>
      )}
    </>
  )
}
