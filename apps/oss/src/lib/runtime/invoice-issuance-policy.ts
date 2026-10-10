import type { BuyerSnapshot, SellerSnapshot } from "@quits/contracts/documents"

/** Optional restrictions on new invoice issuance. Existing documents remain readable and resendable. */
export type InvoiceIssuancePolicy = {
  sellerCountry?: string
  buyerCountries?: readonly string[]
  currencies?: readonly string[]
  standardVatRate?: string
  requireCvr?: boolean
  requireBusinessBuyer?: boolean
  requireIdentity?: boolean
  requireSupplyDate?: boolean
  /** Explicit confirmation for the effective seller. A registration number alone is not confirmation. */
  sellerVatRegistered?: boolean
}

export type InvoiceIssuancePolicyContext = {
  organizationId: string
  seller: SellerSnapshot
  buyer: BuyerSnapshot | null
}
