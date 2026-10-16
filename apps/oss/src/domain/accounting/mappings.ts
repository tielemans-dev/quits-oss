import { vatGroupKey } from "@quits/shared/pricing"
import { z } from "zod"

const account = z.number().int().positive().max(2147483647).nullable()
const row = z.object({
  kind: z.enum(["domestic", "services", "goods"]), country: z.string().trim().toUpperCase().regex(/^([A-Z]{2})?$/),
  revenueAccount: account, vatCode: z.string().trim().max(25),
  productNumber: z.string().trim().max(25), vatZoneNumber: account,
}).superRefine((value, ctx) => {
  if (value.kind === "domestic" ? value.country !== "" && value.country !== "DK" : !value.country)
    ctx.addIssue({ code: "custom", path: ["country"], message: "Country must match the VAT group" })
}).transform(value => ({ ...value, country: value.kind === "domestic" ? value.country || "DK" : value.country }))
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
  return config.rows.filter(value => !row.safeParse(value).success || !value.revenueAccount || !value.vatCode || (provider === "economic" && (!value.productNumber || !value.vatZoneNumber)))
}

/** Recover editable fields without trusting corrupt configuration for delivery. Never writes repairs. */
export function readStoredMappings(value: unknown) {
  if (value == null) return { mappings: defaultMappings(), mappingsInvalid: false, invalidMappingRows: [] as number[] }
  const parsed = mappingsSchema.safeParse(value)
  if (parsed.success) return { mappings: parsed.data, mappingsInvalid: false, invalidMappingRows: [] as number[] }
  const defaults = defaultMappings().rows[0]!
  const editableRow = z.object({
    kind: z.enum(["domestic", "services", "goods"]).catch("domestic"), country: z.string().catch(""),
    revenueAccount: account.catch(null), vatCode: z.string().catch(""),
    productNumber: z.string().catch(""), vatZoneNumber: account.catch(null),
  }).catch(defaults)
  const mappings = z.object({ rows: z.array(editableRow).catch([defaults]), paymentAccount: account.catch(null) }).catch(defaultMappings()).parse(value)
  const invalidMappingRows = [...new Set(parsed.error.issues.flatMap(issue => typeof issue.path[1] === "number" ? [issue.path[1]] : mappings.rows.map((_, i) => i)))]
  return { mappings, invalidMappingRows, mappingsInvalid: true }
}
