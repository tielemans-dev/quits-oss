import { describe, expect, it } from "vitest"
import { defaultMappings, mappingKey, mappingsSchema, missingSalesMappings } from "../mappings"

describe("accounting mappings", () => {
  it("starts with Danish 25% VAT without inventing chart accounts", () => {
    const config = defaultMappings()
    expect(mappingKey(config.rows[0]!)).toBe('["standard",null,"0.25","DK"]')
    expect(missingSalesMappings(config, "dinero")).toHaveLength(1)
    expect(config.paymentAccount).toBeNull()
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
