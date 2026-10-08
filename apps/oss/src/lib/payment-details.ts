import {
  hasPaymentDetails,
  type BankDetailsSnapshot,
  type PaymentDetails,
} from "@quits/contracts/payment-details"

/** The `OrgSettings` columns that hold an organization's payment details. */
export const paymentDetailsSelect = {
  bankAccountHolder: true,
  bankName: true,
  bankRegNumber: true,
  bankAccountNumber: true,
  bankIban: true,
  bankBic: true,
  paymentNote: true,
} as const

export type PaymentDetailsColumns = {
  bankAccountHolder: string | null
  bankName: string | null
  bankRegNumber: string | null
  bankAccountNumber: string | null
  bankIban: string | null
  bankBic: string | null
  paymentNote: string | null
}

export function paymentDetailsFromColumns(row: Partial<PaymentDetailsColumns> | null | undefined): PaymentDetails {
  return {
    accountHolder: row?.bankAccountHolder ?? null,
    bankName: row?.bankName ?? null,
    regNumber: row?.bankRegNumber ?? null,
    accountNumber: row?.bankAccountNumber ?? null,
    iban: row?.bankIban ?? null,
    bic: row?.bankBic ?? null,
    note: row?.paymentNote ?? null,
  }
}

export function paymentDetailsToColumns(details: PaymentDetails): PaymentDetailsColumns {
  return {
    bankAccountHolder: details.accountHolder,
    bankName: details.bankName,
    bankRegNumber: details.regNumber,
    bankAccountNumber: details.accountNumber,
    bankIban: details.iban,
    bankBic: details.bic,
    paymentNote: details.note,
  }
}

/**
 * The bank details to freeze onto an invoice being issued, or null when the organization has
 * entered none (the snapshot then carries no `bankDetails` at all, as before this feature).
 */
export function bankDetailsSnapshotFromColumns(
  row: Partial<PaymentDetailsColumns> | null | undefined
): BankDetailsSnapshot | null {
  const details = paymentDetailsFromColumns(row)
  return hasPaymentDetails(details) ? details : null
}
