import type { BuyerSnapshot, DocumentTaxId } from "@quits/contracts/documents"
import { detailBuyerAddress } from "../../lib/documents/buyer-address"
import { distinctCompany, formatTaxIds } from "../../lib/documents/tax-ids"
import { useI18n } from "../../lib/i18n/react"

/** The buyer lines under "Bill to": the saved draft and the live preview of a new invoice show the same ones. */
export function BuyerDetails({ buyer, taxIds, sellerCountry }: { buyer: Omit<BuyerSnapshot, "email" | "taxIds"> & { email?: string | null }; taxIds: readonly DocumentTaxId[] | undefined; sellerCountry: string }) {
  const { locale } = useI18n()
  return <>
    <p className="font-semibold">{buyer.name}</p>
    {distinctCompany(buyer) && <p className="text-sm">{distinctCompany(buyer)}</p>}
    {formatTaxIds(taxIds, locale).map(id => <p key={id} className="text-sm">{id}</p>)}
    {buyer.email && <p className="text-sm text-muted-foreground">{buyer.email}</p>}
    {detailBuyerAddress(buyer, sellerCountry, locale).map((line, index) => <p key={index} className="text-sm">{line}</p>)}
  </>
}
