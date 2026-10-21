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
  /** Identity-bound evidence; unset always refuses, including for a non-registered snapshot. */
  sellerVatStatus?: "registered" | "not_registered" | "unset"
  requireCvr?: boolean
  requireBusinessBuyer?: boolean
  /** Require the buyer's Danish CVR or SE number, which bookkeeping rules expect on a voucher. Off by default. */
  requireBuyerCvr?: boolean
  requireIdentity?: boolean
  requireSupplyDate?: boolean
  /** Refuse to send while neither bank details nor an online payment method can be shown to the customer. Off by default: self-hosters may be paid by other means. */
  requirePaymentDetails?: boolean
  /** Legacy operator confirmation; the effective seller snapshot carries the three-state choice.
   * Explicit confirmation for the effective seller. A registration number alone is not confirmation. */
  sellerVatRegistered?: boolean
}

export type InvoiceIssuancePolicyContext = {
  organizationId: string
  seller: SellerSnapshot
  buyer: BuyerSnapshot | null
}
