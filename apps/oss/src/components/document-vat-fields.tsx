import type { DocumentLineInput } from "@quits/contracts/invoices"
import { vatReasonCodes, vatTreatmentSchema, type VatReasonCode, type DraftVatEvidence } from "@quits/contracts/vat"
import { documentVat } from "@quits/shared/pricing"
import type { CalculateDocumentOutput } from "@quits/contracts/pricing"
import { useI18n } from "../lib/i18n/react"
import { formatCurrency } from "../lib/i18n/format"
import { Input } from "./ui/input"
import { Label } from "./ui/label"

/** Per-line classifications and document evidence. Evidence may stay incomplete in a draft. */
export function DocumentVatFields<Line extends DocumentLineInput>({ items, onItemsChange, taxRate, evidence, onEvidenceChange, classificationReadOnly = false }: {
  items: Line[]
  onItemsChange: (items: Line[]) => void
  taxRate: string
  evidence: DraftVatEvidence
  onEvidenceChange: (evidence: DraftVatEvidence) => void
  classificationReadOnly?: boolean
}) {
  const { t } = useI18n()
  const treatments = items.map((item) => documentVat(item, taxRate || "0").treatment)
  const patchEvidence = (patch: Partial<DraftVatEvidence>) => onEvidenceChange({ ...evidence, ...patch })
  const intra = treatments.includes("intra_community")
  const statement = intra || treatments.includes("exempt") || treatments.includes("reverse_charge_domestic")
  const buyerId = intra || treatments.includes("reverse_charge_domestic")
  return <div className="grid gap-3">
    {!classificationReadOnly && items.map((item, index) => {
      const vat = documentVat(item, taxRate || "0")
      const reasons: readonly VatReasonCode[] = vatReasonCodes[vat.treatment]
      const patch = (changes: Partial<NonNullable<DocumentLineInput["vat"]>>) => onItemsChange(items.map((line, i) => i === index ? { ...line, vat: { ...vat, ...changes } } : line))
      return <div key={index} className="grid grid-cols-2 gap-2 rounded-md border p-3">
        <Label className="col-span-2">{item.description || t("vat.line", { number: index + 1 })}</Label>
        <label className="grid gap-1 text-sm">{t("vat.treatment")}
          <select className="h-9 rounded-md border bg-background px-2" aria-label={t("vat.lineTreatment", { number: index + 1 })} value={vat.treatment} onChange={(event) => {
            const treatment = vatTreatmentSchema.parse(event.target.value)
            patch({ treatment, rate: treatment === "standard" ? documentVat({ ...item, vat: undefined }, taxRate || "0").rate : "0", reasonCode: vatReasonCodes[treatment][0] ?? null })
          }}>
            {vatTreatmentSchema.options.map((treatment) => <option key={treatment} value={treatment}>{t(`vat.treatment.${treatment}`)}</option>)}
          </select>
        </label>
        {vat.treatment === "standard" && <label className="grid gap-1 text-sm">{t("vat.fractionalRate")}
          <Input aria-label={t("vat.lineRate", { number: index + 1 })} inputMode="decimal" value={vat.rate} onChange={(event) => patch({ rate: event.target.value })} />
        </label>}
        {reasons.length > 0 && <label className="grid gap-1 text-sm">{t("vat.reason")}
          <select className="h-9 rounded-md border bg-background px-2" value={vat.reasonCode ?? ""} aria-label={t("vat.lineReason", { number: index + 1 })} onChange={(event) => patch({ reasonCode: event.target.value as NonNullable<DocumentLineInput["vat"]>["reasonCode"] })}>
            <option value="">{t("vat.chooseReason")}</option>
            {reasons.map((reason) => <option key={reason} value={reason}>{t(`vat.reason.${reason}`)}</option>)}
          </select>
        </label>}
        {vat.treatment !== "out_of_scope" && <label className="grid gap-1 text-sm">{t("vat.country")}
          <Input maxLength={2} value={vat.country ?? ""} onChange={(event) => patch({ country: event.target.value.toUpperCase() || null })} />
        </label>}
      </div>
    })}
    {statement && <label className="grid gap-1 text-sm">{t("vat.statement")}
      <Input aria-label={t("vat.statement")} value={evidence.statementText ?? ""} onChange={(event) => patchEvidence({ statementText: event.target.value || undefined })} />
    </label>}
    {buyerId && <label className="grid gap-1 text-sm">{t("vat.buyerId")}
      <Input value={evidence.buyerVatId ?? ""} onChange={(event) => patchEvidence({ buyerVatId: event.target.value || undefined })} />
    </label>}
    {intra && <>
      <label className="grid gap-1 text-sm">{t("vat.viesResult")}
        <select className="h-9 rounded-md border bg-background px-2" value={evidence.viesCheck?.result ?? "unavailable"} onChange={(event) => patchEvidence({ viesCheck: { at: evidence.viesCheck?.at ?? new Date().toISOString(), result: event.target.value as "valid" | "invalid" | "unavailable" } })}>
          {(["unavailable", "valid", "invalid"] as const).map((value) => <option key={value} value={value}>{t(`vat.vies.${value}`)}</option>)}
        </select>
      </label>
      <label className="grid gap-1 text-sm">{t("vat.viesAt")}
        <Input value={evidence.viesCheck?.at ?? ""} onChange={(event) => patchEvidence({ viesCheck: { at: event.target.value, result: evidence.viesCheck?.result ?? "unavailable" } })} />
      </label>
    </>}
    {treatments.includes("export") && <>
      <label className="grid gap-1 text-sm">{t("vat.exportKind")}
        <select className="h-9 rounded-md border bg-background px-2" value={evidence.exportEvidence?.kind ?? "customs_declaration"} onChange={(event) => patchEvidence({ exportEvidence: { kind: event.target.value as "customs_declaration" | "carrier_document" | "other", ref: evidence.exportEvidence?.ref ?? "" } })}>
          {(["customs_declaration", "carrier_document", "other"] as const).map((value) => <option key={value} value={value}>{t(`vat.export.${value}`)}</option>)}
        </select>
      </label>
      <label className="grid gap-1 text-sm">{t("vat.exportRef")}
        <Input value={evidence.exportEvidence?.ref ?? ""} onChange={(event) => patchEvidence({ exportEvidence: { kind: evidence.exportEvidence?.kind ?? "customs_declaration", ref: event.target.value } })} />
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
