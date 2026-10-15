import { readFileSync } from "node:fs"
import { DANISH_ONBOARDING_V2_DEFAULTS } from "@quits/contracts/onboarding"
import { describe, expect, it } from "vitest"

const defaults = DANISH_ONBOARDING_V2_DEFAULTS
const columnDefaults = {
  countryCode: defaults.countryCode,
  locale: defaults.locale,
  timezone: defaults.timezone,
  defaultCurrency: defaults.defaultCurrency,
  baseCurrency: defaults.baseCurrency,
  currency: defaults.currency,
  taxRegime: defaults.taxRegime,
  taxRate: defaults.taxRate,
}

describe("Danish organization column defaults", () => {
  it("keeps the Prisma schema aligned with the contract", () => {
    const schema = readFileSync(new URL("../../../../prisma/schema.prisma", import.meta.url), "utf8")
    const settingsModel = schema.match(/model OrgSettings \{([\s\S]*?)^\}/m)?.[1] ?? ""
    const schemaDefaults = Object.fromEntries(
      [...settingsModel.matchAll(/^\s+(\w+)\s+\w+\??[^\r\n]*?@default\(("[^"]*"|\d+|true|false)\)/gm)]
        .map(([, field, value]) => [field, JSON.parse(value!)]),
    )

    expect(schemaDefaults).toMatchObject({ ...columnDefaults, pricesIncludeTax: defaults.pricesIncludeTax })
  })

  it("keeps the Danish defaults migration aligned with the contract", () => {
    const migration = readFileSync(new URL("../../../../prisma/migrations/20261015120000_danish_org_defaults/migration.sql", import.meta.url), "utf8")
    const migrationDefaults = Object.fromEntries(
      [...migration.matchAll(/ALTER COLUMN "(\w+)" SET DEFAULT ('[^']*'|\d+)/g)]
        .map(([, field, value]) => [field, value!.startsWith("'") ? value!.slice(1, -1) : JSON.parse(value!)]),
    )

    expect(migrationDefaults).toEqual(columnDefaults)
  })
})
