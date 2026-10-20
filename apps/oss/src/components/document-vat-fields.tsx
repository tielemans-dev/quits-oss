import type { DocumentLineInput } from "@quits/contracts/invoices"
import { vatReasonCodes, vatTreatmentSchema, type VatReasonCode, type DraftVatEvidence } from "@quits/contracts/vat"
import { documentVat } from "@quits/shared/pricing"
import type { CalculateDocumentOutput } from "@quits/contracts/pricing"
import { useState, type ComponentProps } from "react"
import { useI18n } from "../lib/i18n/react"
import { formatCurrency } from "../lib/i18n/format"
import { vatFractionToPercentText, vatPercentTextToFraction } from "../lib/vat-rate-input"
import { Input } from "./ui/input"
import { Label } from "./ui/label"

/** Per-line classifications and document evidence. Evidence may stay incomplete in a draft. */
/** A line's VAT rate typed as a percentage (25); the line keeps the fraction ("0.25"). */
function VatPercentInput({ value, onChange, ...props }: { value: string; onChange: (fraction: string) => void } & Omit<ComponentProps<typeof Input>, "value" | "onChange">) {
  const { locale } = useI18n()
  // The typed text, kept while it still means the line's rate, so "12," is not reformatted mid-entry.
  // Text that is not a percentage clears the rate, which the preview and the server then reject.
  const [typed, setTyped] = useState<{ text: string; fraction: string } | null>(null)
  return <Input {...props} inputMode="decimal" value={typed?.fraction === value ? typed.text : vatFractionToPercentText(value, locale)} onChange={(event) => {
    const fraction = vatPercentTextToFraction(event.target.value) ?? ""
    setTyped({ text: event.target.value, fraction })
    onChange(fraction)
  }} />
}

export function DocumentVatFields<Line extends DocumentLineInput>({ items, onItemsChange, taxRate, defaultCountry, evidence, onEvidenceChange, classificationReadOnly = false, hideClassification = false, lineErrorId, evidenceErrorId }: {
  items: Line[]
  onItemsChange: (items: Line[]) => void
  taxRate: string
  /** The organization's country: shown for a line without a VAT country, and set when a domestic treatment is chosen, as invoice lines do. */
  defaultCountry?: string | null
  evidence: DraftVatEvidence
  onEvidenceChange: (evidence: DraftVatEvidence) => void
  classificationReadOnly?: boolean
  hideClassification?: boolean
  /** Id of the message describing a VAT error on this line, when there is one. */
  lineErrorId?: (index: number) => string | undefined
  /** Id of the message describing an error on one evidence entry, when there is one. */
  evidenceErrorId?: (entry: keyof DraftVatEvidence) => string | undefined
}) {
  const { t } = useI18n()
  const treatments = items.map((item) => documentVat(item, taxRate || "0").treatment)
  // Each control is flagged only for the evidence entry it edits.
  const evidenceA11y = (entry: keyof DraftVatEvidence) => {
    const id = evidenceErrorId?.(entry)
    return { "aria-invalid": id ? true : undefined, "aria-describedby": id }
  }
  const patchEvidence = (patch: Partial<DraftVatEvidence>) => onEvidenceChange({ ...evidence, ...patch })
  const intra = treatments.includes("intra_community")
  const statement = intra || treatments.includes("exempt") || treatments.includes("reverse_charge_domestic")
  const buyerId = intra || treatments.includes("reverse_charge_domestic")
  return <div className="grid gap-3">
    {!classificationReadOnly && !hideClassification && items.map((item, index) => {
      const vat = documentVat(item, taxRate || "0")
      const reasons: readonly VatReasonCode[] = vatReasonCodes[vat.treatment]
      const errorId = lineErrorId?.(index)
      const a11y = { "aria-invalid": errorId ? true : undefined, "aria-describedby": errorId }
      const patch = (changes: Partial<NonNullable<DocumentLineInput["vat"]>>) => onItemsChange(items.map((line, i) => i === index ? { ...line, vat: { ...vat, ...changes } } : line))
      return <div key={index} className="grid grid-cols-1 gap-2 rounded-md border p-3 sm:grid-cols-2">
        <Label className="sm:col-span-2 block min-w-0 whitespace-normal [overflow-wrap:anywhere]">{item.description || t("vat.line", { number: index + 1 })}</Label>
        <label className="grid min-w-0 gap-1 text-sm">{t("vat.treatment")}
          <select className="h-9 w-full min-w-0 rounded-md border bg-background px-2" aria-label={t("vat.lineTreatment", { number: index + 1 })} {...a11y} value={vat.treatment} onChange={(event) => {
            const treatment = vatTreatmentSchema.parse(event.target.value)
            patch({ treatment, rate: treatment === "standard" ? documentVat({ ...item, vat: undefined }, taxRate || "0").rate : "0", reasonCode: vatReasonCodes[treatment][0] ?? null,
              ...(treatment === "standard" || treatment === "exempt" ? { country: vat.country ?? defaultCountry ?? null } : {}) })
          }}>
            {vatTreatmentSchema.options.map((treatment) => <option key={treatment} value={treatment}>{t(`vat.treatment.${treatment}`)}</option>)}
          </select>
        </label>
        {vat.treatment === "standard" && <label className="grid min-w-0 gap-1 text-sm">{t("vat.percentRate")}
          <VatPercentInput aria-label={t("vat.lineRate", { number: index + 1 })} {...a11y} value={vat.rate} onChange={(rate) => patch({ rate })} />
        </label>}
        {reasons.length > 0 && <label className="grid min-w-0 gap-1 text-sm">{t("vat.reason")}
          <select className="h-9 w-full min-w-0 rounded-md border bg-background px-2" value={vat.reasonCode ?? ""} aria-label={t("vat.lineReason", { number: index + 1 })} {...a11y} onChange={(event) => patch({ reasonCode: event.target.value as NonNullable<DocumentLineInput["vat"]>["reasonCode"] })}>
            <option value="">{t("vat.chooseReason")}</option>
            {reasons.map((reason) => <option key={reason} value={reason}>{t(`vat.reason.${reason}`)}</option>)}
          </select>
        </label>}
        {vat.treatment !== "out_of_scope" && <label className="grid min-w-0 gap-1 text-sm">{t("vat.country")}
          <Input maxLength={2} {...a11y} placeholder={defaultCountry ?? undefined} value={vat.country ?? ""} onChange={(event) => patch({ country: event.target.value.toUpperCase() || null })} />
        </label>}
      </div>
    })}
    {hideClassification && items.map((item, index) => {
      const vat = documentVat(item, taxRate || "0")
      const reasons: readonly VatReasonCode[] = vatReasonCodes[vat.treatment]
      if (!reasons.length) return null
      return <label key={index} className="grid gap-1 text-sm">{t("vat.lineReason", { number: index + 1 })}
        <select className="h-9 w-full min-w-0 rounded-md border bg-background px-2" disabled={classificationReadOnly} value={vat.reasonCode ?? ""} onChange={event => onItemsChange(items.map((line, i) => i === index ? { ...line, vat: { ...vat, reasonCode: event.target.value as VatReasonCode } } : line))}>
          <option value="">{t("vat.chooseReason")}</option>
          {reasons.map(reason => <option key={reason} value={reason}>{t(`vat.reason.${reason}`)}</option>)}
        </select>
      </label>
    })}
    {statement && <label className="grid gap-1 text-sm">{t("vat.statement")}
      <Input {...evidenceA11y("statementText")} aria-label={t("vat.statement")} value={evidence.statementText ?? ""} onChange={(event) => patchEvidence({ statementText: event.target.value || undefined })} />
    </label>}
    {buyerId && <label className="grid gap-1 text-sm">{t("vat.buyerId")}
      <Input {...evidenceA11y("buyerVatId")} value={evidence.buyerVatId ?? ""} onChange={(event) => patchEvidence({ buyerVatId: event.target.value || undefined })} />
    </label>}
    {intra && <>
      <label className="grid gap-1 text-sm">{t("vat.viesResult")}
        <select {...evidenceA11y("viesCheck")} className="h-9 w-full min-w-0 rounded-md border bg-background px-2" value={evidence.viesCheck?.result ?? "unavailable"} onChange={(event) => patchEvidence({ viesCheck: { at: evidence.viesCheck?.at ?? new Date().toISOString(), result: event.target.value as "valid" | "invalid" | "unavailable" } })}>
          {(["unavailable", "valid", "invalid"] as const).map((value) => <option key={value} value={value}>{t(`vat.vies.${value}`)}</option>)}
        </select>
      </label>
      <label className="grid gap-1 text-sm">{t("vat.viesAt")}
        <Input {...evidenceA11y("viesCheck")} value={evidence.viesCheck?.at ?? ""} onChange={(event) => patchEvidence({ viesCheck: { at: event.target.value, result: evidence.viesCheck?.result ?? "unavailable" } })} />
      </label>
    </>}
    {treatments.includes("export") && <>
      <label className="grid gap-1 text-sm">{t("vat.exportKind")}
        <select {...evidenceA11y("exportEvidence")} className="h-9 w-full min-w-0 rounded-md border bg-background px-2" value={evidence.exportEvidence?.kind ?? "customs_declaration"} onChange={(event) => patchEvidence({ exportEvidence: { kind: event.target.value as "customs_declaration" | "carrier_document" | "other", ref: evidence.exportEvidence?.ref ?? "" } })}>
          {(["customs_declaration", "carrier_document", "other"] as const).map((value) => <option key={value} value={value}>{t(`vat.export.${value}`)}</option>)}
        </select>
      </label>
      <label className="grid gap-1 text-sm">{t("vat.exportRef")}
        <Input {...evidenceA11y("exportEvidence")} value={evidence.exportEvidence?.ref ?? ""} onChange={(event) => patchEvidence({ exportEvidence: { kind: evidence.exportEvidence?.kind ?? "customs_declaration", ref: event.target.value } })} />
      </label>
    </>}
  </div>
}

export function VatGroupPreview({ result, error }: { result: CalculateDocumentOutput | null; error: string | null }) {
  const { t, locale } = useI18n()
  if (!result) return <p role="status" className="text-sm text-destructive">{error ? t("vat.invalidInput") : ""}</p>
  return <div className="grid gap-1 text-sm" aria-label={t("vat.groups")}>
    {result.groups.map((group) => <div key={group.key} className="flex justify-between gap-3">
      <span>{t(`vat.treatment.${group.treatment}`)}</span>
      <span>{t("vat.groupAmounts", { net: formatCurrency(Number(group.net), result.currency, locale), tax: formatCurrency(Number(group.tax), result.currency, locale), gross: formatCurrency(Number(group.gross), result.currency, locale) })}</span>
    </div>)}
  </div>
}
