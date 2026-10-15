import type { CSSProperties } from "react"
import { Check } from "lucide-react"
import type { CvrCompany } from "@quits/contracts/cvr"
import { DURATION, STAGGER_STEP, prefersReducedMotion } from "../../lib/motion"
import { useI18n } from "../../lib/i18n/react"
import { Skeleton } from "../ui/skeleton"

/** The skeleton shows at least this long, so a fast answer does not flash. */
export const SKELETON_MIN_MS = 300
const HOLD_MS = 300
/** Reveal slots in reading order: the card's name, two address lines, CVR and industry, then the invoice's seller block. */
const CARD_SLOTS = 5
const INVOICE_START = CARD_SLOTS - 1
const CHECK_SLOT = INVOICE_START + 4

/** How long the filled preview stays before the review form replaces it. */
export const settleMs = () =>
  prefersReducedMotion() ? DURATION.fade + HOLD_MS : CHECK_SLOT * STAGGER_STEP + DURATION.base + HOLD_MS

/** "Vestergade 1, 2100 København Ø" or the same over two lines: street first, then postnr and by. */
export const addressLines = (address: string) =>
  address.split(/\n|,\s*(?=\d{4}\s)/).map((line) => line.trim()).filter(Boolean)

/**
 * One line of text and its skeleton in the same grid cell, so the skeleton fades out where the value
 * fades in and nothing moves. A skeleton is decoration: it stays out of the accessibility tree.
 */
function Slot({ slot, width, filled, children }: { slot: number; width: string; filled: boolean; children?: React.ReactNode }) {
  return (
    <span className="ob-slot" data-filled={filled || undefined} style={{ "--i": slot } as CSSProperties}>
      <Skeleton aria-hidden="true" className="ob-slot-skeleton" style={{ width }} />
      <span className="ob-slot-value">{children}</span>
    </span>
  )
}

type Props = {
  /** null while the lookup is pending. */
  company: CvrCompany | null
  slow: boolean
}

/** The company card and the first invoice, empty until CVR answers and then filled in field by field. */
export function LookupPreview({ company, slow }: Props) {
  const { t, locale } = useI18n()
  const amount = new Intl.NumberFormat(locale, { style: "currency", currency: "DKK" }).format(0)
  const filled = company !== null
  const [street = "", place = ""] = addressLines(company?.address ?? "")
  return (
    <div aria-busy={!filled} className="ob-preview">
      <section className="ob-card" aria-label={t("onboardingV2.company")}>
        <header><h2>{t("onboardingV2.company")}</h2></header>
        <div className="ob-lines">
          <Slot slot={0} width="60%" filled={filled}><strong>{company?.name}</strong></Slot>
          <Slot slot={1} width="45%" filled={filled}>{street}</Slot>
          <Slot slot={2} width="35%" filled={filled}>{place}</Slot>
          <Slot slot={3} width="9ch" filled={filled}>
            <span className="ob-mono">{t("pdf.cvrNumber")} {company?.cvr}</span>
            {filled ? <Check size={14} className="ob-check" style={{ "--i": CHECK_SLOT } as CSSProperties} aria-hidden="true" /> : null}
          </Slot>
          <Slot slot={4} width="30%" filled={filled}>{company?.industry}</Slot>
        </div>
        {slow && !filled ? <p role="status">{t("onboardingV2.working.slow")}</p> : null}
      </section>
      <section className="ob-card ob-invoice" aria-label={t("pdf.invoice")}>
        <header><h2>{t("pdf.invoice")}</h2></header>
        <div className="ob-invoice-parties">
          <div className="ob-lines">
            <span className="ob-label">{t("pdf.from")}</span>
            <Slot slot={INVOICE_START} width="60%" filled={filled}><strong>{company?.name}</strong></Slot>
            <Slot slot={INVOICE_START + 1} width="45%" filled={filled}>{street}</Slot>
            <Slot slot={INVOICE_START + 2} width="35%" filled={filled}>{place}</Slot>
            <Slot slot={INVOICE_START + 3} width="9ch" filled={filled}>
              <span className="ob-mono">{t("pdf.cvrNumber")} {company?.cvr}</span>
            </Slot>
          </div>
          <div className="ob-lines">
            <span className="ob-label">{t("pdf.billTo")}</span>
          </div>
        </div>
        <table className="ob-invoice-table">
          <thead>
            <tr><th>{t("pdf.description")}</th><th>{t("pdf.qty")}</th><th>{t("pdf.unitPrice")}</th></tr>
          </thead>
          <tbody><tr><td>&nbsp;</td><td /><td /></tr></tbody>
        </table>
        <dl className="ob-totals">
          <dt>{t("pdf.subtotal")}</dt><dd>{amount}</dd>
          <dt>{t("pdf.taxRate", { rate: 25 })}</dt><dd>{amount}</dd>
          <dt>{t("pdf.total")}</dt><dd>{amount}</dd>
        </dl>
      </section>
      <p role="status" className="sr-only">{filled ? t("onboardingV2.working.loaded") : ""}</p>
    </div>
  )
}
