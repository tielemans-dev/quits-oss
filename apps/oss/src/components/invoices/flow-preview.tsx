import { useState } from "react"
import { useI18n } from "../../lib/i18n/react"
import { formatCurrency, formatDate } from "../../lib/i18n/format"
import { Button } from "../ui/button"
import { BuyerDetails } from "../documents/buyer-details"
import { buildBuyerSnapshot } from "../../lib/documents/buyer-snapshot"

export type FlowPreviewProps = {
  customer?: Parameters<typeof buildBuyerSnapshot>[0]
  company?: string | null
  /** The seller's country, which decides the buyer's postal order as on the saved draft. */
  sellerCountry?: string | null
  dueDate: string
  currency: string
  items: { description: string; quantity: string; unitPrice: string }[]
  total: string | null
  paymentMethods: string[]
}

/** A live working preview. Issued documents still use the authoritative document renderer. */
export function FlowPreview({ customer, company, sellerCountry, dueDate, currency, items, total, paymentMethods }: FlowPreviewProps) {
  const { t, locale } = useI18n()
  const [tab, setTab] = useState("invoice")
  const buyer = customer ? buildBuyerSnapshot(customer) : null
  const amount = total === null ? "—" : formatCurrency(Number(total), currency, locale)
  return <div className="invoice-preview grid content-start gap-5 p-4 sm:p-8">
    <div role="tablist" aria-label={t("invoices.flow.review")} className="flex gap-2">
      {(["invoice", "paymentPage", "email"] as const).map(key => <Button key={key} id={`preview-tab-${key}`} role="tab" aria-selected={tab === key} tabIndex={tab === key ? 0 : -1} onKeyDown={event => { const tabs = ["invoice", "paymentPage", "email"]; const index = tabs.indexOf(tab); const next = event.key === "ArrowRight" ? (index + 1) % 3 : event.key === "ArrowLeft" ? (index + 2) % 3 : event.key === "Home" ? 0 : event.key === "End" ? 2 : -1; if (next < 0) return; event.preventDefault(); setTab(tabs[next]!); document.getElementById(`preview-tab-${tabs[next]}`)?.focus() }} aria-controls="invoice-preview-content" variant={tab === key ? "secondary" : "ghost"} onClick={() => setTab(key)}>{t(`invoices.flow.${key}`)}</Button>)}
    </div>
    <article id="invoice-preview-content" role="tabpanel" aria-labelledby={`preview-tab-${tab}`} className="invoice-paper mx-auto w-full max-w-lg rounded-lg border p-5 text-sm sm:p-10">
      <p className="font-semibold">{company}</p>
      <p className="mt-8 text-xs">{tab === "email" ? t("invoices.flow.email") : t("invoices.flow.invoice")}</p>
      <h2 className="my-3 text-3xl font-semibold">{amount}</h2>
      {/* The same buyer lines the saved draft shows; the email tab shows who receives it instead. */}
      {!buyer ? <p>{t("docForm.selectContact")}</p> : tab === "email" ? <><p>{buyer.name}</p><p>{buyer.email}</p></> : <div><BuyerDetails buyer={buyer} taxIds={buyer.taxIds} sellerCountry={sellerCountry ?? "DK"} /></div>}
      {dueDate && <p className="mt-2">{t("invoices.table.dueDate")} {formatDate(dueDate, locale)}</p>}
      {tab === "invoice" && <table className="my-8 w-full text-left text-xs"><thead><tr><th>{t("docForm.column.description")}</th><th className="text-right">{t("docForm.column.qty")}</th><th className="text-right">{t("docForm.column.unitPrice")}</th></tr></thead><tbody>{items.map((item, i) => <tr key={i} className="border-b"><td className="py-3 break-words">{item.description}</td><td className="text-right">{item.quantity}</td><td className="text-right">{formatCurrency(Number(item.unitPrice) || 0, currency, locale)}</td></tr>)}</tbody></table>}
      <div className="mt-8 border-t pt-4"><span>{t("invoices.flow.paidVia")}</span><p className="mt-1">{paymentMethods.map(method => t(method === "bank_transfer" ? "payments.method.bank_transfer" : "payments.method.card")).join(" · ") || "—"}</p></div>
      <p className="mt-8 flex justify-between font-semibold"><span>{t("docForm.summary.total")}</span><span>{amount}</span></p>
    </article>
  </div>
}
