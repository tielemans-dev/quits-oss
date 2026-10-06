const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const PHONE_REGEX = /^\+?[0-9()\-\s.]{6,20}$/
const PREFIX_REGEX = /^[A-Z0-9-]{1,10}$/

export type SettingsFormValidationError =
  | "invalid_timezone"
  | "invalid_tax_rate"
  | "invalid_company_email"
  | "invalid_company_phone"
  | "invalid_invoice_prefix"
  | "invalid_quote_prefix"
  | "invalid_credit_note_prefix"

export type SettingsFormValidationInput = {
  timezone: string
  taxRateRaw: string
  companyEmail?: string
  companyPhone?: string
  invoicePrefix?: string
  quotePrefix?: string
  creditNotePrefix?: string
}

function isValidTimezone(timezone: string) {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: timezone })
    return true
  } catch {
    return false
  }
}

export function validateSettingsFormInput(
  input: SettingsFormValidationInput
): SettingsFormValidationError | null {
  const timezone = input.timezone.trim()
  if (!timezone || !isValidTimezone(timezone)) {
    return "invalid_timezone"
  }

  const taxRateRaw = input.taxRateRaw.trim()
  if (taxRateRaw) {
    const taxRate = Number(taxRateRaw)
    if (!Number.isFinite(taxRate) || taxRate < 0 || taxRate > 100) {
      return "invalid_tax_rate"
    }
  }

  const companyEmail = input.companyEmail?.trim()
  if (companyEmail && !EMAIL_REGEX.test(companyEmail)) {
    return "invalid_company_email"
  }

  const companyPhone = input.companyPhone?.trim()
  if (companyPhone && !PHONE_REGEX.test(companyPhone)) {
    return "invalid_company_phone"
  }

  const invoicePrefix = input.invoicePrefix?.trim()
  if (invoicePrefix && !PREFIX_REGEX.test(invoicePrefix)) {
    return "invalid_invoice_prefix"
  }

  const quotePrefix = input.quotePrefix?.trim()
  if (quotePrefix && !PREFIX_REGEX.test(quotePrefix)) {
    return "invalid_quote_prefix"
  }

  const creditNotePrefix = input.creditNotePrefix?.trim()
  if (creditNotePrefix && !PREFIX_REGEX.test(creditNotePrefix)) {
    return "invalid_credit_note_prefix"
  }

  return null
}
