import { describe, expect, it } from "vitest"
import { defaultMappings, mappingKey, mappingsSchema, readStoredMappings, missingSalesMappings } from "../mappings"

describe("accounting mappings", () => {
  it("starts with Danish 25% VAT without inventing chart accounts", () => {
    const config = defaultMappings()
    expect(mappingKey(config.rows[0]!)).toBe('["standard",null,"0.25","DK"]')
    expect(missingSalesMappings(config, "dinero")).toHaveLength(1)
    expect(config.paymentAccount).toBeNull()
  })
  it("requires countries for EU rows and defaults domestic rows to DK", () => {
    const config = defaultMappings(), row = { ...config.rows[0]!, revenueAccount: 1000, vatCode: "U25" }
    for (const kind of ["services", "goods"] as const) {
      const blank = { ...config, rows: [{ ...row, kind, country: "" }] }
      expect(mappingsSchema.safeParse(blank).success).toBe(false)
      expect(missingSalesMappings(blank, "dinero")).toHaveLength(1)
    }
    expect(mappingsSchema.parse({ ...config, rows: [{ ...row, country: "" }] }).rows[0]!.country).toBe("DK")
    expect(mappingsSchema.safeParse({ ...config, rows: [{ ...row, country: "DE" }] }).success).toBe(false)
  })
  it.each([42, {}, { rows: [null], paymentAccount: -1 }, { rows: [], paymentAccount: "bad" }])("flags corrupt stored configuration without throwing: %j", value => {
    expect(readStoredMappings(value).mappingsInvalid).toBe(true)
  })
  it("validates account numbers, country, duplicate groups and provider fields", () => {
    const config = defaultMappings(), row = config.rows[0]!
    for (const patch of [{ revenueAccount: -1 }, { revenueAccount: 1.5 }, { paymentAccount: 2147483648 }])
      expect(mappingsSchema.safeParse({ ...config, ...patch, rows: [{ ...row, ...patch }] }).success).toBe(false)
    expect(mappingsSchema.safeParse({ ...config, rows: [{ ...row, country: "Denmark" }] }).success).toBe(false)
    expect(mappingsSchema.safeParse({ ...config, rows: [row, row] }).success).toBe(false)
    const complete = { ...config, rows: [{ ...row, revenueAccount: 1000, vatCode: "U25" }] }
    expect(missingSalesMappings(complete, "dinero")).toEqual([])
    expect(missingSalesMappings(complete, "economic")).toHaveLength(1)
    expect(mappingKey({ ...row, kind: "services", country: "DE" })).not.toBe(mappingKey({ ...row, kind: "goods", country: "DE" }))
  })
})
