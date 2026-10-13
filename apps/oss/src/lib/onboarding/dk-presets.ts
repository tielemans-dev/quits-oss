import type { Prisma } from "../../../generated/prisma/client"
import { nonVatStatement } from "../documents/non-vat-note"
import { DANISH_ONBOARDING_V2_DEFAULTS } from "@quits/contracts/onboarding"

/** Project contract defaults to database fields; country is only a UI display label. */
export function buildDkSettingsDefaults() {
  const defaults = DANISH_ONBOARDING_V2_DEFAULTS
  return {
    countryCode: defaults.countryCode,
    defaultCurrency: defaults.defaultCurrency,
    baseCurrency: defaults.baseCurrency,
    currency: defaults.currency,
    locale: defaults.locale,
    timezone: defaults.timezone,
    taxRegime: defaults.taxRegime,
    taxRate: defaults.taxRate,
    pricesIncludeTax: defaults.pricesIncludeTax,
    paymentTermsDays: defaults.paymentTermsDays,
    invoicePrefix: defaults.invoicePrefix,
    invoiceNextNum: defaults.invoiceNextNum,
    quotePrefix: defaults.quotePrefix,
    quoteNextNum: defaults.quoteNextNum,
  } satisfies Omit<Prisma.OrgSettingsUncheckedCreateInput, "organizationId">
}

/** Only mapped invoicing fields, never a raw CVR response. T1 supplies the Danish address. */
export type DkCompanySummary = {
  companyName: string
  companyAddress: string
  companyForm: string
  momsRegistered: boolean
  companyEmail?: string | null
  companyPhone?: string | null
  invoiceNextNum?: number
  reklamebeskyttet?: boolean
}

/** CVR and the cloud manual fallback use exactly the same explicit Danish settings. */
export function buildDkPresets(company: DkCompanySummary, signupEmail?: string) {
  const defaults = buildDkSettingsDefaults()
  const soleTrader = company.companyForm.trim().toLowerCase() === "enkeltmandsvirksomhed"
  return {
    ...defaults,
    companyName: company.companyName,
    companyAddress: company.companyAddress,
    onboardingInvoicingIdentity: soleTrader ? "individual" : "registered_business",
    momsRegistered: company.momsRegistered,
    taxRate: company.momsRegistered ? 25 : 0,
    paymentNote: company.momsRegistered ? null : nonVatStatement(defaults.locale),
    companyEmail: company.reklamebeskyttet ? signupEmail ?? null : company.companyEmail === undefined ? signupEmail ?? null : company.companyEmail,
    companyPhone: company.reklamebeskyttet ? null : company.companyPhone ?? null,
    invoiceNextNum: company.invoiceNextNum ?? defaults.invoiceNextNum,
  }
}
