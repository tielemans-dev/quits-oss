import { DANISH_ONBOARDING_V2_DEFAULTS } from "@quits/contracts/onboarding"

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
  const { country: _country, ...defaults } = DANISH_ONBOARDING_V2_DEFAULTS
  const soleTrader = company.companyForm.trim().toLowerCase() === "enkeltmandsvirksomhed"
  return {
    ...defaults,
    companyName: company.companyName,
    companyAddress: company.companyAddress,
    onboardingInvoicingIdentity: soleTrader ? "individual" : "registered_business",
    momsRegistered: company.momsRegistered,
    taxRate: company.momsRegistered ? 25 : 0,
    paymentNote: company.momsRegistered ? null : "Virksomheden er ikke momsregistreret.",
    companyEmail: company.reklamebeskyttet ? signupEmail ?? null : company.companyEmail === undefined ? signupEmail ?? null : company.companyEmail,
    companyPhone: company.reklamebeskyttet ? null : company.companyPhone ?? null,
    invoiceNextNum: company.invoiceNextNum ?? defaults.invoiceNextNum,
  }
}
