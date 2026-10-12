import { hasPaymentDetails } from "@quits/contracts/payment-details"
import { issuedSeller } from "../../domain/documents/issued-invoice"
import { useI18n } from "../../lib/i18n/react"
import { invoicePaymentReferenceHint, invoicePaymentRows } from "../../lib/documents/invoice-payment-rows"
import { invoiceTaxIds } from "../../lib/documents/invoice-identity"

export function InvoiceSellerDetails({ status, sellerSnapshot, issuanceSnapshot }: {
  status: string
  sellerSnapshot: unknown
  issuanceSnapshot?: unknown
}) {
  const { t } = useI18n()
  // Draft snapshots describe creation-time settings; issuance freezes the actual seller.
  if (status === "draft") return null
  const seller = issuedSeller(issuanceSnapshot, sellerSnapshot)
  return (
    <section aria-label={t("pdf.from")}>
      <h3 className="text-sm font-medium text-muted-foreground mb-1">{t("pdf.from")}</h3>
      {seller?.companyName && <p className="font-semibold">{seller.companyName}</p>}
      {seller?.companyAddress && <p className="text-sm whitespace-pre-wrap">{seller.companyAddress}</p>}
      {invoiceTaxIds(seller?.taxIds, "CVR-nr.").map(id => <p key={id} className="text-sm">{id}</p>)}
    </section>
  )
}

export function InvoicePaymentInstructions({ status, sellerSnapshot, issuanceSnapshot, number, paymentReference, balanceDue, currency, dueDate }: {
  status: string
  sellerSnapshot: unknown
  issuanceSnapshot?: unknown
  number: string | null
  paymentReference?: string | null
  balanceDue: number
  currency: string
  dueDate: Date | string
}) {
  const { t, locale } = useI18n()
  const seller = issuedSeller(issuanceSnapshot, sellerSnapshot)
  const referenceHint = invoicePaymentReferenceHint({ number, paymentReference }, locale)
  const account = seller?.bankAccount
  const note = seller?.paymentNote?.trim()
  if (status === "draft" || !(balanceDue > 0) || !hasPaymentDetails({ bankAccount: account, note })) return null
  return (
    <section aria-label={t("email.pay.heading")} className="grid gap-2 text-sm">
      <h3 className="font-medium">{t("email.pay.heading")}</h3>
      <dl className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-x-4">
        {invoicePaymentRows({ bankAccount: account, number, paymentReference, total: balanceDue, currency, dueDate }, locale).map(row => (
          <div key={row.key} className="col-span-2 grid grid-cols-subgrid border-b py-2.5">
            <dt className="text-xs uppercase tracking-wider text-muted-foreground self-center">{row.label}</dt>
            <dd className="font-mono text-right break-words">{row.value}</dd>
          </div>
        ))}
      </dl>
      {referenceHint && <p className="mt-2 text-muted-foreground">{referenceHint}</p>}
      {note && <p className="whitespace-pre-wrap break-words">{note}</p>}
    </section>
  )
}
