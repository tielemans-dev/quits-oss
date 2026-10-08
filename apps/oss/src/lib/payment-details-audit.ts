import {
  PAYMENT_DETAILS_FIELDS,
  type PaymentDetails,
  type PaymentDetailsField,
} from "@quits/contracts/payment-details"
import type { TranslationKey } from "./i18n/messages"

/**
 * Who changed the payment details, as the audit event and the notification record it. A display
 * name is whatever the person chose, so a person also carries the email address and id of their
 * account; readers see `formatChangedBy`.
 */
export type PaymentDetailsChangedBy = {
  kind: "user" | "agent" | "system"
  /** The user id, or the agent key id; null for the system. */
  id: string | null
  name: string
  email: string | null
}

/** "Name <email>", or just the name when there is no email (an agent or the system). */
export function formatChangedBy(changedBy: Pick<PaymentDetailsChangedBy, "name" | "email">): string {
  // A name may be anything the person typed: keep it on one line and short.
  const name = changedBy.name.replace(/[\p{Cc}\p{Cf}\s]+/gu, " ").trim().slice(0, 80)
  const email = changedBy.email?.trim()
  return email ? `${name} <${email}>` : name
}

/**
 * One payment detail that changed, with the values as the audit log and the notification email
 * show them: masked (see `maskPaymentDetail`). It is the change record that is masked; the
 * settings and the invoices issued afterwards legitimately hold the full account.
 */
export type PaymentDetailsChange = {
  field: PaymentDetailsField
  before: string | null
  after: string | null
}

/** The catalog label of each field, for the activity log and the notification email. */
export const PAYMENT_DETAIL_LABEL_KEYS: Record<PaymentDetailsField, TranslationKey> = {
  accountHolder: "pdf.accountHolder",
  bankName: "pdf.bankName",
  regNumber: "pdf.regNumber",
  accountNumber: "pdf.accountNumber",
  iban: "pdf.iban",
  bic: "pdf.bic",
  note: "settings.paymentDetails.note.label",
}

const MASK = "****"
/** Characters of a masked number that stay readable, enough to recognise an account. */
const VISIBLE_TAIL = 4

const maskedTail = (text: string) => (text.length > VISIBLE_TAIL ? `${MASK}${text.slice(-VISIBLE_TAIL)}` : MASK)

/**
 * How a value is recorded and mailed. Changing bank details is the most common invoice-fraud
 * vector, so a log or an email that many people can read must not hold the account itself:
 *
 * - the account number shows its last four characters (`****6243`); a value of four or fewer
 *   characters is masked completely;
 * - the IBAN also keeps its two-letter country code (`DK****6243`). The country is the strongest
 *   sign of a swapped account and is not sensitive;
 * - the payment note is free text that may hold an account number, so it is only marked as set;
 * - reg.nr. (a branch code), BIC (public), account holder and bank name are not account numbers
 *   and stay readable, which is what lets a reader recognise which account was swapped for which.
 */
export function maskPaymentDetail(field: PaymentDetailsField, value: string | null | undefined): string | null {
  const text = value?.trim()
  if (!text) return null
  switch (field) {
    case "iban": {
      const masked = maskedTail(text)
      return masked !== MASK && /^[A-Za-z]{2}/.test(text) ? `${text.slice(0, 2).toUpperCase()}${masked}` : masked
    }
    case "accountNumber":
      return maskedTail(text)
    case "note":
      return MASK
    default:
      return text
  }
}

function valueOf(details: PaymentDetails, field: PaymentDetailsField): string | null {
  const value = field === "note" ? details.note : details.bankAccount?.[field]
  return value?.trim() || null
}

/**
 * The fields that differ between two sets of payment details, in field order, with masked
 * values. Empty when nothing changed, so saving the same details again records nothing.
 */
export function diffPaymentDetails(before: PaymentDetails, after: PaymentDetails): PaymentDetailsChange[] {
  return PAYMENT_DETAILS_FIELDS.flatMap((field) => {
    const previous = valueOf(before, field)
    const next = valueOf(after, field)
    return previous === next
      ? []
      : [{ field, before: maskPaymentDetail(field, previous), after: maskPaymentDetail(field, next) }]
  })
}
