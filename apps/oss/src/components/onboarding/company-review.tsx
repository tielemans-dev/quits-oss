import { useState } from "react"
import { confirmOnboardingV2Schema, isValidDanishCvr, type ConfirmOnboardingV2Input } from "@quits/contracts/onboarding"
import { useI18n } from "../../lib/i18n/react"
import { translateCvrError } from "../../lib/i18n/cvr-error"
import { trpc } from "../../trpc/client"
import { SellerVatStatus } from "../seller-vat-status"
import { Button } from "../ui/button"
import { Input } from "../ui/input"
import { Label } from "../ui/label"
import { Textarea } from "../ui/textarea"

/** A lookup result or manual fallback enters the same review. Lookup never implies VAT status. */
export function CompanyReview({ company, confirmationEnabled, nonVatEnabled = false, onComplete }: {
  company?: Pick<ConfirmOnboardingV2Input, "companyName" | "companyAddress" | "cvr" | "companyForm">
  confirmationEnabled: boolean
  nonVatEnabled?: boolean
  onComplete: () => void
}) {
  const { t } = useI18n()
  const [values, setValues] = useState(company ?? { companyName: "", companyAddress: "", cvr: "", companyForm: "" })
  const [registered, setRegistered] = useState<boolean | null>(null)
  const [key] = useState(() => crypto.randomUUID())
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setSaving(true)
    setError(null)
    try {
      if (!confirmationEnabled || registered === null || (!nonVatEnabled && registered === false)) throw new Error(t("vatStatus.label"))
      const cvr = values.cvr
      if (typeof cvr !== "string" || !isValidDanishCvr(cvr.trim())) throw new Error(t("cvr.invalid"))
      const summary = confirmOnboardingV2Schema.parse({ ...values, cvr: cvr.trim(), idempotencyKey: key, source: company ? "cvr" : "manual",
        momsRegistered: registered, ...(registered ? { vatId: `DK${cvr.trim()}` } : {}) })
      const { token } = await trpc.runtime.prepareSellerVatConfirmation.mutate({ companyName: summary.companyName,
        companyAddress: summary.companyAddress, countryCode: "DK", cvr: summary.cvr, vatId: summary.vatId })
      const result = await trpc.onboarding.confirmV2.mutate({ ...summary, sellerVatConfirmationToken: token })
      if (result.status === "complete" || result.status === "already_complete") onComplete()
    } catch (cause) {
      setError(cause instanceof Error ? translateCvrError(cause.message, t) : t("settings.error.saveFailed"))
    } finally { setSaving(false) }
  }
  // Only a hosted distribution with both capabilities may mount this confirmation flow.
  if (!confirmationEnabled) return null
  return <form onSubmit={submit} className="grid gap-4">
    <h2 className="text-lg font-semibold">{t("onboardingV2.reviewTitle")}</h2>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {([ ["companyName", t("settings.companyName.label")], ["companyAddress", t("settings.companyAddress.label")],
      ["cvr", "CVR"], ["companyForm", t("onboardingV2.companyForm")] ] as const).map(([field, label]) =>
      <div className="grid gap-2" key={field}><Label htmlFor={`review-${field}`}>{label} <span aria-hidden="true">*</span></Label>
        {/* A registry address keeps its line break between street and postal district. */}
        {field === "companyAddress"
          ? <Textarea id="review-companyAddress" rows={2} value={values.companyAddress} required disabled={saving} maxLength={240}
            onChange={event => { setValues(current => ({ ...current, companyAddress: event.target.value })); setRegistered(null) }} />
          : <Input id={`review-${field}`} value={values[field]} required disabled={saving}
            maxLength={field === "companyName" ? 120 : field === "companyForm" ? 80 : 8}
            onChange={event => { setValues(current => ({ ...current, [field]: event.target.value })); setRegistered(null) }} />}</div>)}
    <p className="text-sm text-muted-foreground">{t("sellerCard.body")}</p>
    <SellerVatStatus nonVatEnabled={nonVatEnabled} value={registered} onChange={setRegistered} disabled={saving} required />
    <Button type="submit" disabled={saving || registered === null}>{t("settings.action.save")}</Button>
  </form>
}
