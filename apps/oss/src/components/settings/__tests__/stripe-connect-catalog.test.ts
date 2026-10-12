import { describe, expect, it } from "vitest"

import { daCatalog } from "../../../lib/i18n/catalog/da"
import { enCatalog } from "../../../lib/i18n/catalog/en"

const CONNECT_COPY = {
  "settings.payments.connect.title": ["Connect Stripe", "Tilknyt Stripe"],
  "settings.payments.connect.description": [
    "Customers pay invoices by card through your Stripe account.",
    "Kunder betaler fakturaer med kort via din Stripe-konto.",
  ],
  "settings.payments.connect.status.none": ["Not connected", "Ikke tilknyttet"],
  "settings.payments.connect.status.pending": ["Onboarding incomplete", "Onboarding er ikke færdig"],
  "settings.payments.connect.status.active": ["Active", "Aktiv"],
  "settings.payments.connect.status.restricted": ["Restricted", "Begrænset"],
  "settings.payments.connect.help.none": [
    "Card payments stay off until Stripe is connected.",
    "Kortbetalinger er slået fra, indtil Stripe er tilknyttet.",
  ],
  "settings.payments.connect.help.pending": [
    "Finish onboarding in Stripe to turn card payments on.",
    "Afslut onboarding i Stripe for at slå kortbetalinger til.",
  ],
  "settings.payments.connect.help.active": [
    "Card payments are on. Processing fees are charged on your Stripe account.",
    "Kortbetalinger er slået til. Stripe trækker behandlingsgebyrer på din konto.",
  ],
  "settings.payments.connect.help.restricted": [
    "Stripe is restricting this account. Card payments stay off until you fix it in Stripe.",
    "Stripe begrænser denne konto. Kortbetalinger er slået fra, indtil du retter det i Stripe.",
  ],
  "settings.payments.connect.account.label": ["Stripe account", "Stripe-konto"],
  "settings.payments.connect.action.connect": ["Connect Stripe", "Tilknyt Stripe"],
  "settings.payments.connect.action.resume": ["Resume onboarding", "Fortsæt onboarding"],
  "settings.payments.connect.action.fix": ["Fix in Stripe", "Ret i Stripe"],
  "settings.payments.connect.action.disconnect": ["Disconnect", "Fjern tilknytning"],
  "settings.payments.connect.disconnect.title": ["Disconnect Stripe?", "Fjern Stripe-tilknytning?"],
  "settings.payments.connect.disconnect.description": [
    "This removes the connected account from the organization. The account stays open in Stripe.",
    "Den tilknyttede konto fjernes fra organisationen. Kontoen forbliver åben i Stripe.",
  ],
  "settings.payments.connect.disconnect.confirm": ["Disconnect", "Fjern tilknytning"],
  "settings.payments.connect.disconnect.cancel": ["Cancel", "Annuller"],
} as const

describe("Connect Stripe catalog", () => {
  it("keeps English and Danish Connect copy on the same keys", () => {
    const prefix = "settings.payments.connect."
    const enKeys = Object.keys(enCatalog).filter((key) => key.startsWith(prefix)).sort()
    const daKeys = Object.keys(daCatalog).filter((key) => key.startsWith(prefix)).sort()

    expect(enKeys).toEqual(Object.keys(CONNECT_COPY).sort())
    expect(daKeys).toEqual(enKeys)
    for (const key of enKeys) {
      const messageKey = key as keyof typeof CONNECT_COPY
      expect(enCatalog[messageKey]).toBe(CONNECT_COPY[messageKey][0])
      expect(daCatalog[messageKey]).toBe(CONNECT_COPY[messageKey][1])
      expect(daCatalog[messageKey].trim().length).toBeGreaterThan(0)
    }
  })
})
