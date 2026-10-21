import { useRef, useState } from "react"
import type { CompanyLookupResult } from "../../lib/runtime/company-lookup"
import { handledMutationError } from "../../lib/query-refresh"
import { trpc } from "../../trpc/client"
import { useI18n } from "../../lib/i18n/react"
import { Button } from "../ui/button"
import { Input } from "../ui/input"
import { Label } from "../ui/label"
import { CompanyReview } from "./company-review"

/** Lookup and manual entry converge on the existing review, with a fresh explicit VAT choice. */
export function CompanySetup({ onComplete, nonVatEnabled = false }: { onComplete: () => void; nonVatEnabled?: boolean }) {
  const { t } = useI18n()
  const [query, setQuery] = useState("")
  const [result, setResult] = useState<CompanyLookupResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [review, setReview] = useState<{ company?: CompanyLookupResult["companies"][number] } | null>(null)
  const generation = useRef(0)
  async function lookup(event: React.FormEvent) {
    event.preventDefault()
    const current = ++generation.current
    setBusy(true); setResult(null)
    try {
      const facts = await trpc.runtime.lookupOnboardingCompany.mutate({ query }, handledMutationError)
      if (current === generation.current) setResult(facts)
    } catch {
      if (current === generation.current) setResult({ companies: [], unavailable: true })
    } finally { if (current === generation.current) setBusy(false) }
  }
  if (review) {
    const company = review.company
    return <div className="grid gap-4">
      <Button variant="outline" onClick={() => { generation.current++; setReview(null) }}>{t("onboardingV2.backToLookup")}</Button>
      <CompanyReview nonVatEnabled={nonVatEnabled} confirmationEnabled onComplete={onComplete} company={company ? {
        companyName: company.companyName, companyAddress: company.companyAddress, cvr: company.cvr, companyForm: company.companyForm,
      } : undefined} />
    </div>
  }
  return <div className="grid gap-4">
    <form onSubmit={lookup} className="grid gap-3">
      <Label htmlFor="company-query">{t("onboardingV2.lookupLabel")}</Label>
      <Input id="company-query" value={query} minLength={3} maxLength={160} required onChange={event => {
        generation.current++; setBusy(false); setResult(null); setQuery(event.target.value)
      }} />
      <Button disabled={busy}>{t("sellerSetup.lookup")}</Button>
    </form>
    {result && (result.unavailable || !result.companies.length) && <p role="status">{t("onboardingV2.lookupUnavailable")}</p>}
    {result?.companies.map(company => <div key={company.cvr} className="grid gap-2 rounded-md border p-4">
      <p>{company.companyName} · {company.cvr}</p><p className="whitespace-pre-line">{company.companyAddress}</p>
      <p>{company.companyForm} · {company.statusText}</p>
      {company.presetsAllowed ? <Button variant="outline" onClick={() => setReview({ company })}>{t("onboardingV2.reviewTitle")}</Button>
        : <p>{t("onboardingV2.statusUnknown")}</p>}
    </div>)}
    <Button variant="outline" onClick={() => { generation.current++; setBusy(false); setReview({}) }}>{t("sellerSetup.manual")}</Button>
  </div>
}
