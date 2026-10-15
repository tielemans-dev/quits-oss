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
    expect(enCatalog["settings.payments.connect.action.connect"]).toBe("Connect Stripe")
    expect(daCatalog["settings.payments.connect.action.connect"]).toBe("Forbind Stripe")
    expect(enCatalog["settings.payments.connect.help.none"]).toContain("Bank transfer")
    expect(daCatalog["settings.payments.connect.help.none"]).toContain("Bankoverførsel")
    expect(enCatalog["settings.payments.connect.status.pending"]).toBe(enCatalog["settings.payments.connect.status.restricted"])
    expect(daCatalog["settings.payments.connect.status.pending"]).toBe("Mangler oplysninger hos Stripe")
    expect(enKeys).not.toContain("settings.payments.connect.payments.byok")
  })
})
