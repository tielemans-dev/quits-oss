import { parseSellerSnapshot } from "@quits/contracts/documents"
import { useI18n } from "../../lib/i18n/react"
import { invoiceTaxIds } from "../../lib/documents/invoice-identity"

export function InvoiceSellerDetails({ sellerSnapshot }: { sellerSnapshot: unknown }) {
  const { t } = useI18n()
  const seller = parseSellerSnapshot(sellerSnapshot)
  return (
    <section aria-label={t("pdf.from")}>
      <h3 className="text-sm font-medium text-muted-foreground mb-1">{t("pdf.from")}</h3>
      {seller?.companyName && <p className="font-semibold">{seller.companyName}</p>}
      {seller?.companyAddress && <p className="text-sm whitespace-pre-wrap">{seller.companyAddress}</p>}
      {invoiceTaxIds(seller?.taxIds).map(id => <p key={id} className="text-sm">{id}</p>)}
    </section>
  )
}

export function InvoicePaymentInstructions({ sellerSnapshot, number }: { sellerSnapshot: unknown; number: string | null }) {
  const { t } = useI18n()
  const seller = parseSellerSnapshot(sellerSnapshot)
  const account = seller?.bankAccount
  const reg = account?.regNumber?.trim()
  const accountNumber = account?.accountNumber?.trim()
  const note = seller?.paymentNote?.trim()
  if (!reg && !accountNumber && !note) return null
  return (
    <section aria-label={t("email.pay.heading")} className="grid gap-2 text-sm">
      <h3 className="font-medium">{t("email.pay.heading")}</h3>
      {reg && <p className="break-words">{t("email.pay.reg")}: {reg}</p>}
      {accountNumber && <p className="break-words">{t("email.pay.account")}: {accountNumber}</p>}
      {number && <p>{t("email.pay.reference", { number })}</p>}
      {note && <p className="whitespace-pre-wrap break-words">{note}</p>}
    </section>
  )
}
