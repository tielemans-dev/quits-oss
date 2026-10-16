import { vatGroupKey } from "@quits/shared/pricing"
import { z } from "zod"

const account = z.number().int().positive().max(2147483647).nullable()
const row = z.object({
  kind: z.enum(["domestic", "services", "goods"]), country: z.string().trim().toUpperCase().regex(/^([A-Z]{2})?$/),
  revenueAccount: account, vatCode: z.string().trim().max(25),
  productNumber: z.string().trim().max(25), vatZoneNumber: account,
})
export const mappingsSchema = z.object({ rows: z.array(row).max(100), paymentAccount: account }).superRefine((value, ctx) => {
  const keys = value.rows.map(mappingKey)
  if (new Set(keys).size !== keys.length) ctx.addIssue({ code: "custom", path: ["rows"], message: "Duplicate VAT group" })
})
export type AccountingMappings = z.infer<typeof mappingsSchema>
export const mappingContextSchema = z.object({ mappingRevision: z.string(), mappings: mappingsSchema.optional(), accountFingerprint: z.string().optional() })
export type MappingContext = z.infer<typeof mappingContextSchema>
export const defaultMappings = (): AccountingMappings => ({ rows: [{ kind: "domestic", country: "DK", revenueAccount: null, vatCode: "", productNumber: "", vatZoneNumber: 1 }], paymentAccount: null })
export function mappingKey(value: AccountingMappings["rows"][number]) {
  return vatGroupKey({ treatment: value.kind === "domestic" ? "standard" : "intra_community",
    reasonCode: value.kind === "domestic" ? null : value.kind === "services" ? "services_b2b" : "goods",
    rate: value.kind === "domestic" ? "0.25" : "0", country: value.country || null })
}
export function missingSalesMappings(config: AccountingMappings, provider: string) {
  return config.rows.filter(value => !value.revenueAccount || !value.vatCode || (provider === "economic" && (!value.productNumber || !value.vatZoneNumber)))
}
