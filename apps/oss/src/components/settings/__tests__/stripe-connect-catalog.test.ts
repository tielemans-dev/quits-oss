import { describe, expect, it } from "vitest"

import { daCatalog } from "../../../lib/i18n/catalog/da"
import { enCatalog } from "../../../lib/i18n/catalog/en"

describe("Connect Stripe catalog", () => {
  it("keeps English and Danish Connect copy on the same keys", () => {
    const prefix = "settings.payments.connect."
    const enKeys = Object.keys(enCatalog).filter((key) => key.startsWith(prefix)).sort()
    const daKeys = Object.keys(daCatalog).filter((key) => key.startsWith(prefix)).sort()

    expect(daKeys).toEqual(enKeys)
    for (const key of enKeys) {
      expect(daCatalog[key as keyof typeof daCatalog]?.trim().length).toBeGreaterThan(0)
    }
    expect(enCatalog["settings.payments.connect.description"]).toContain("active Stripe Connect")
    expect(daCatalog["settings.payments.connect.description"]).toContain("aktiv Stripe Connect")
    expect(enCatalog["settings.payments.connect.payments.unavailable"]).toContain("Bank transfer")
    expect(daCatalog["settings.payments.connect.payments.unavailable"]).toContain("Bankoverførsel")
    expect(enKeys).not.toContain("settings.payments.connect.payments.byok")
  })
})
