import { z } from "zod"
import { bankDetailsSnapshotSchema } from "./payment-details"

export const documentTaxIdSchema = z.object({
  scheme: z.string().optional(),
  value: z.string(),
  countryCode: z.string().nullable().optional(),
})

/**
 * Seller details frozen onto a document when it is created. `bankDetails` is only set on invoices
 * issued after payment details existed; every older document simply has none.
 */
export const sellerSnapshotSchema = z.object({
  companyName: z.string().nullable().optional(),
  companyEmail: z.string().nullable().optional(),
  companyAddress: z.string().nullable().optional(),
  taxIds: z.array(documentTaxIdSchema).optional(),
  bankDetails: bankDetailsSnapshotSchema.nullable().optional(),
})

/** Buyer details frozen onto a document when it is created. */
export const buyerSnapshotSchema = z.object({
  name: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
  company: z.string().nullable().optional(),
  address: z.string().nullable().optional(),
  city: z.string().nullable().optional(),
  state: z.string().nullable().optional(),
  zip: z.string().nullable().optional(),
  country: z.string().nullable().optional(),
  taxIds: z.array(documentTaxIdSchema).optional(),
})

export type DocumentTaxId = z.infer<typeof documentTaxIdSchema>
export type SellerSnapshot = z.infer<typeof sellerSnapshotSchema>
export type BuyerSnapshot = z.infer<typeof buyerSnapshotSchema>

/** Reads a stored snapshot, returning null when it is missing or malformed. */
export function parseSellerSnapshot(value: unknown): SellerSnapshot | null {
  const parsed = sellerSnapshotSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

export function parseBuyerSnapshot(value: unknown): BuyerSnapshot | null {
  const parsed = buyerSnapshotSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}
