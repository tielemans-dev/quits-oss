import type { DocumentLineInput } from "@quits/contracts/invoices"
import { documentVat, fractionToPercentage, percentageToFraction } from "@quits/shared/pricing"
import { useI18n } from "../../lib/i18n/react"

export function LineVatSelect({ item, taxRate, index, standardVatRate, defaultCountry, momsRegistered, disabled, onChange }: {
  item: DocumentLineInput; taxRate: string; index: number; standardVatRate?: string | null; defaultCountry?: string | null;
  momsRegistered?: boolean | null; disabled?: boolean; onChange: (vat: NonNullable<DocumentLineInput["vat"]>) => void;
}) {
  const { t } = useI18n()
  const vat = documentVat(item, taxRate || "0")
  if (momsRegistered === false && Number(vat.rate) === 0 && (!item.vat || vat.treatment === "unclassified_zero")) return <span className="text-sm whitespace-nowrap">{t("line.noVat")}</span>
  const configuredRate = standardVatRate ?? (taxRate || "0")
  const standardRate = percentageToFraction(configuredRate)
  const ordinary = vat.treatment === "standard" && Number(vat.rate) === Number(standardRate)
  // A restrictive adopter policy is presented without a one-option dropdown.
  // Existing exceptional drafts still show their actual classification and fail issuance policy.
  if (standardVatRate && vat.treatment === "standard" && Number(fractionToPercentage(vat.rate)) === Number(standardVatRate)) return <span className="text-sm whitespace-nowrap">{t("invoiceVat.hosted", { rate: standardVatRate })}</span>
  const value = ordinary ? "standard" : vat.treatment
  const known = ["standard", "exempt", "out_of_scope"].includes(value) && (value !== "standard" || ordinary)
  return <select aria-label={t("vat.lineRate", { number: index + 1 })} disabled={disabled || !!standardVatRate} value={known ? value : "existing"}
    className="h-9 min-w-0 w-full rounded-md border border-input bg-background px-2 text-sm"
    onChange={event => {
      const treatment = event.target.value as "standard" | "exempt" | "out_of_scope"
      onChange({ treatment, rate: treatment === "standard" ? standardRate : "0", country: treatment === "out_of_scope" ? null : vat.country ?? defaultCountry ?? null,
        reasonCode: null })
    }}>
    {!known && <option value="existing">{t(`vat.treatment.${vat.treatment}`)} · {fractionToPercentage(vat.rate)} %</option>}
    {Number(configuredRate) > 0 && <option value="standard">{Number(configuredRate) === 25 ? t("invoiceVat.standard") : t("invoiceVat.hosted", { rate: configuredRate })}</option>}
    <option value="exempt">{t("invoiceVat.exempt")}</option>
    <option value="out_of_scope">{t("invoiceVat.outOfScope")}</option>
  </select>
}
