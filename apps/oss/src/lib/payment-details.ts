import {
  BANK_ACCOUNT_FIELDS,
  hasBankAccount,
  type BankAccount,
  type BankAccountSnapshot,
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

function accountFromColumns(row: Partial<PaymentDetailsColumns> | null | undefined): BankAccount | null {
  const account: BankAccount = {
    accountHolder: row?.bankAccountHolder ?? null,
    bankName: row?.bankName ?? null,
    regNumber: row?.bankRegNumber ?? null,
    accountNumber: row?.bankAccountNumber ?? null,
    iban: row?.bankIban ?? null,
    bic: row?.bankBic ?? null,
  }
  return hasBankAccount(account) ? account : null
}

export function paymentDetailsFromColumns(row: Partial<PaymentDetailsColumns> | null | undefined): PaymentDetails {
  return { bankAccount: accountFromColumns(row), note: row?.paymentNote ?? null }
}

export function paymentDetailsToColumns(details: PaymentDetails): PaymentDetailsColumns {
  const account = details.bankAccount
  return {
    bankAccountHolder: account?.accountHolder ?? null,
    bankName: account?.bankName ?? null,
    bankRegNumber: account?.regNumber ?? null,
    bankAccountNumber: account?.accountNumber ?? null,
    bankIban: account?.iban ?? null,
    bankBic: account?.bic ?? null,
    paymentNote: details.note,
  }
}

/** The payment details of an issued invoice, frozen into its seller snapshot. */
export type PaymentSnapshot = {
  bankAccount?: BankAccountSnapshot
  paymentNote?: string
}

/**
 * The payment details to freeze onto an invoice being issued. A part the organization has not
 * entered is left out, so an organization without payment details gets neither key, as before
 * this feature existed.
 */
export function paymentSnapshotFromColumns(row: Partial<PaymentDetailsColumns> | null | undefined): PaymentSnapshot {
  const { bankAccount, note } = paymentDetailsFromColumns(row)
  return {
    ...(bankAccount ? { bankAccount: Object.fromEntries(BANK_ACCOUNT_FIELDS.map((field) => [field, bankAccount[field]])) } : {}),
    ...(note ? { paymentNote: note } : {}),
  }
}
