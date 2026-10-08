import { z } from "zod"

export const PAYMENT_DETAILS_TEXT_MAX_LENGTH = 120
export const PAYMENT_NOTE_MAX_LENGTH = 500
/** An IBAN has between 15 and 34 characters (ISO 13616). */
export const IBAN_MIN_LENGTH = 15
export const IBAN_MAX_LENGTH = 34

/**
 * The fixed IBAN length of the countries Quits users are most likely to bank in. Other countries
 * only get the generic length check, so a country missing here is never rejected for its length.
 */
export const IBAN_LENGTH_BY_COUNTRY: Readonly<Record<string, number>> = {
  AT: 20, BE: 16, BG: 22, CH: 21, CY: 28, CZ: 24, DE: 22, DK: 18, EE: 20, ES: 24, FI: 18, FO: 18,
  FR: 27, GB: 22, GL: 18, GR: 27, HR: 21, HU: 28, IE: 22, IS: 26, IT: 27, LI: 21, LT: 20, LU: 20,
  LV: 21, MC: 27, MT: 31, NL: 18, NO: 15, PL: 28, PT: 25, RO: 24, SE: 24, SI: 19, SK: 24, SM: 27,
}

/** Removes all whitespace and upper-cases: how an IBAN or BIC is stored and compared. */
function normalizeCode(value: string): string {
  return value.replace(/\s+/g, "").toUpperCase()
}

export const normalizeIban = normalizeCode
export const normalizeBic = normalizeCode

/** Groups a normalized IBAN in blocks of four characters, as it is printed: `DK50 0040 0440 1162 43`. */
export function formatIban(value: string): string {
  return normalizeIban(value).replace(/(.{4})(?=.)/g, "$1 ")
}

/**
 * Checks an IBAN's structure, its length and its ISO 13616 mod-97 check digits. Spaces and lower
 * case are accepted. The length is the country's own where it is known (`IBAN_LENGTH_BY_COUNTRY`),
 * otherwise anywhere in the generic range. National account formats are not checked.
 */
export function isValidIban(value: string): boolean {
  const iban = normalizeIban(value)
  if (iban.length < IBAN_MIN_LENGTH || iban.length > IBAN_MAX_LENGTH) return false
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]+$/.test(iban)) return false
  const expectedLength = IBAN_LENGTH_BY_COUNTRY[iban.slice(0, 2)]
  if (expectedLength !== undefined && iban.length !== expectedLength) return false
  // Move the country code and check digits to the end, then read letters as 10..35. The number
  // is reduced digit by digit, so it never exceeds the safe integer range.
  const rearranged = iban.slice(4) + iban.slice(0, 4)
  let remainder = 0
  for (const character of rearranged) {
    const digits = /[A-Z]/.test(character) ? String(character.charCodeAt(0) - 55) : character
    for (const digit of digits) remainder = (remainder * 10 + Number(digit)) % 97
  }
  return remainder === 1
}

/** ISO 9362: 4 letter institution, 2 letter country, 2 character location, optional 3 character branch. */
const bicPattern = /^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}(?:[A-Z0-9]{3})?$/

export function isValidBic(value: string): boolean {
  return bicPattern.test(normalizeBic(value))
}

/** Reads a form value: blank text, whitespace and a missing value all mean "not given". */
function optionalText(options: {
  normalize?: (value: string) => string
  maxLength?: number
  pattern?: RegExp
  check?: (value: string) => boolean
  message: string
}) {
  const normalize = options.normalize ?? ((value: string) => value.trim())
  return z
    .string()
    .nullish()
    .transform((value) => {
      const normalized = normalize(value ?? "")
      return normalized === "" ? null : normalized
    })
    .pipe(
      z
        .string()
        .refine(
          (value) =>
            (options.maxLength === undefined || value.length <= options.maxLength) &&
            (options.pattern === undefined || options.pattern.test(value)) &&
            (options.check === undefined || options.check(value)),
          options.message
        )
        .nullable()
    )
}

const withoutWhitespace = (value: string) => value.replace(/\s+/g, "")

export const BANK_ACCOUNT_FIELDS = [
  "accountHolder",
  "bankName",
  "regNumber",
  "accountNumber",
  "iban",
  "bic",
] as const
export type BankAccountField = (typeof BANK_ACCOUNT_FIELDS)[number]

const bankAccountShape = {
  accountHolder: optionalText({
    maxLength: PAYMENT_DETAILS_TEXT_MAX_LENGTH,
    message: "Account holder must be at most 120 characters",
  }),
  bankName: optionalText({
    maxLength: PAYMENT_DETAILS_TEXT_MAX_LENGTH,
    message: "Bank name must be at most 120 characters",
  }),
  /** Danish registreringsnummer: the four digit bank branch number. */
  regNumber: optionalText({
    normalize: withoutWhitespace,
    pattern: /^\d{4}$/,
    message: "Registration number (reg.nr.) must be exactly 4 digits",
  }),
  /** Danish kontonummer: one to ten digits. */
  accountNumber: optionalText({
    normalize: withoutWhitespace,
    pattern: /^\d{1,10}$/,
    message: "Account number (kontonr.) must be 1 to 10 digits",
  }),
  iban: optionalText({
    normalize: normalizeIban,
    check: isValidIban,
    message: "IBAN is not valid",
  }),
  bic: optionalText({
    normalize: normalizeBic,
    check: isValidBic,
    message: "BIC must be 8 or 11 characters, for example DABADKKK",
  }),
}

/**
 * One bank account an organization can be paid on. Every field is optional and blank values
 * become null, but the account rules hold for the account as a whole:
 *
 * - the Danish reg.nr. and account number only make sense together;
 * - once any field is filled in, the account must say where to pay: an IBAN, or a reg.nr. with an
 *   account number. A bank name on its own is refused.
 *
 * The IBAN and BIC are normalized (no spaces, upper case) and the IBAN's check digits and length
 * are verified.
 */
export const bankAccountSchema = z.object(bankAccountShape).superRefine((value, ctx) => {
  if (value.regNumber !== null && value.accountNumber === null) {
    ctx.addIssue({
      code: "custom",
      path: ["accountNumber"],
      message: "Account number (kontonr.) is required together with the registration number",
    })
  }
  if (value.accountNumber !== null && value.regNumber === null) {
    ctx.addIssue({
      code: "custom",
      path: ["regNumber"],
      message: "Registration number (reg.nr.) is required together with the account number",
    })
  }
  // A lone reg.nr. or account number is already reported above; this is for an account with
  // neither (a bank name or account holder on its own).
  if (hasBankAccount(value) && value.iban === null && value.regNumber === null && value.accountNumber === null) {
    ctx.addIssue({
      code: "custom",
      path: ["iban"],
      message: "Enter an IBAN, or a registration number and account number",
    })
  }
})

export type BankAccountInput = z.input<typeof bankAccountSchema>
export type BankAccount = z.output<typeof bankAccountSchema>

/** True when at least one account field is filled in. */
export function hasBankAccount(
  account: Partial<Record<BankAccountField, string | null | undefined>> | null | undefined
): boolean {
  return BANK_ACCOUNT_FIELDS.some((field) => Boolean(account?.[field]?.trim()))
}

/**
 * The payment details an organization prints on its invoices: its bank account and a free-form
 * note ("MobilePay box 12345", "pay within 8 days to avoid fees"). A blank account counts as no
 * account, so `bankAccount` is null or a complete, valid account.
 *
 * Where this goes next: organizations will need several accounts, for example one for DKK and one
 * for EUR. `bankAccount` is already one account as a self-contained value, so the path is:
 *
 * 1. a table of accounts (`org_bank_account`: organization, currency, default flag and the six
 *    account columns), replacing the six `bank*` columns of `org_settings`;
 * 2. a migration that copies each organization's current columns into that table as its default
 *    account, so nothing has to be re-entered;
 * 3. `bankAccount` here becomes a list, and issuing an invoice freezes the account for its
 *    currency, falling back to the default one;
 * 4. `sellerSnapshot.bankAccount` stays exactly as it is: a snapshot only ever holds the one
 *    account an invoice is paid to, so issued invoices, PDFs and e-invoices need no migration.
 *
 * `note` stays organization-level, which is why it is not part of the account.
 */
export const paymentDetailsInputSchema = z.object({
  bankAccount: bankAccountSchema.nullish().transform((account) => (account && hasBankAccount(account) ? account : null)),
  note: optionalText({
    maxLength: PAYMENT_NOTE_MAX_LENGTH,
    message: "Payment note must be at most 500 characters",
  }),
})

export type PaymentDetailsInput = z.input<typeof paymentDetailsInputSchema>
export type PaymentDetails = z.output<typeof paymentDetailsInputSchema>

export const EMPTY_PAYMENT_DETAILS: PaymentDetails = { bankAccount: null, note: null }

/** True when there is an account or a note to print. */
export function hasPaymentDetails(
  details: { bankAccount?: Partial<Record<BankAccountField, string | null | undefined>> | null; note?: string | null } | null | undefined
): boolean {
  return hasBankAccount(details?.bankAccount) || Boolean(details?.note?.trim())
}

/**
 * A bank account as frozen onto an issued invoice. Reading is lenient: values were validated when
 * they were saved, and an old document must keep parsing whatever its contents.
 */
export const bankAccountSnapshotSchema = z.object({
  accountHolder: z.string().nullable().optional(),
  bankName: z.string().nullable().optional(),
  regNumber: z.string().nullable().optional(),
  accountNumber: z.string().nullable().optional(),
  iban: z.string().nullable().optional(),
  bic: z.string().nullable().optional(),
})
export type BankAccountSnapshot = z.infer<typeof bankAccountSnapshotSchema>

/** What `paymentDetails.get` and `paymentDetails.update` return. */
export type PaymentDetailsState = PaymentDetails & {
  /** Whether the caller may change the details (the `settings:update` permission). */
  canUpdate: boolean
}
