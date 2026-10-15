import { describe, expect, it } from "vitest"

import { daCatalog } from "../../../lib/i18n/catalog/da"
import { enCatalog } from "../../../lib/i18n/catalog/en"

const CONNECT_COPY = {
  "settings.payments.connect.title": ["Connect Stripe", "Tilknyt Stripe"],
  "settings.payments.connect.description": [
    "Connect your Stripe account to accept card payments.",
    "Tilknyt din Stripe-konto for at modtage kortbetalinger.",
  ],
  "settings.payments.connect.status.none": ["Not connected", "Ikke tilknyttet"],
  "settings.payments.connect.status.pending": ["Onboarding incomplete", "Onboarding er ikke færdig"],
  "settings.payments.connect.status.active": ["Active", "Aktiv"],
  "settings.payments.connect.status.restricted": ["Restricted", "Begrænset"],
  "settings.payments.connect.help.none": [
    "Connect your Stripe account.",
    "Tilknyt din Stripe-konto.",
  ],
  "settings.payments.connect.help.pending": [
    "Finish setting up your account in Stripe.",
    "Gør din konto færdig i Stripe.",
  ],
  "settings.payments.connect.help.active": [
    "Stripe is connected. Processing fees are charged to your Stripe account.",
    "Stripe er tilknyttet. Stripe opkræver gebyrer hos din Stripe-konto.",
  ],
  "settings.payments.connect.help.restricted": [
    "Stripe is restricting this account. Check what needs fixing in Stripe.",
    "Stripe begrænser denne konto. Se, hvad der skal rettes i Stripe.",
  ],
  "settings.payments.connect.payments.byok": ["Card payments use your own Stripe keys. Stripe Connect is not used for these payments.", "Kortbetalinger bruger dine egne Stripe-nøgler. Stripe Connect bruges ikke til disse betalinger."],
  "settings.payments.connect.payments.connect": ["Card payments use Stripe Connect.", "Kortbetalinger bruger Stripe Connect."],
  "settings.payments.connect.legacy.active": ["Legacy Stripe keys are still active as a fallback. Remove them to use only Stripe Connect.", "Dine tidligere Stripe-nøgler er stadig aktive som reserve. Fjern dem for kun at bruge Stripe Connect."],
  "settings.payments.connect.legacy.removing": ["Save settings to remove the legacy Stripe keys. Card payments will then require an active Stripe Connect account.", "Gem indstillingerne for at fjerne de tidligere Stripe-nøgler. Kortbetalinger kræver derefter en aktiv Stripe Connect-konto."],
  "settings.payments.connect.legacy.remove": ["Remove legacy Stripe keys", "Fjern tidligere Stripe-nøgler"],
  "settings.payments.connect.account.label": ["Stripe account", "Stripe-konto"],
  "settings.payments.connect.payments.enabled": ["Card payments are on.", "Kortbetalinger er slået til."],
  "settings.payments.connect.payments.unavailable": [
    "Card payments are not yet available.", "Kortbetalinger er endnu ikke tilgængelige.",
  ],
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
