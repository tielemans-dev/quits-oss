import type { BuyerSnapshot, SellerSnapshot } from "@quits/contracts/documents"

/** Optional restrictions on new invoice issuance. Existing documents remain readable and resendable. */
export type InvoiceIssuancePolicy = {
  sellerCountry?: string
  buyerCountries?: readonly string[]
  currencies?: readonly string[]
  /** Registered sellers use this rate; explicitly non-registered sellers use zero. */
  standardVatRate?: string
  /** Require an explicit choice, including when standardVatRate is not restricted. */
  requireSellerVatStatus?: boolean
  requireCvr?: boolean
  requireBusinessBuyer?: boolean
  requireIdentity?: boolean
  requireSupplyDate?: boolean
  /** Legacy operator confirmation; the effective seller snapshot carries the three-state choice.
   * Explicit confirmation for the effective seller. A registration number alone is not confirmation. */
  sellerVatRegistered?: boolean
}

export type InvoiceIssuancePolicyContext = {
  organizationId: string
  seller: SellerSnapshot
  buyer: BuyerSnapshot | null
}
