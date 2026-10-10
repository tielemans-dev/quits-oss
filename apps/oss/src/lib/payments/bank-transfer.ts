import { parseSellerSnapshot } from "@quits/contracts/documents"

/** Only the issued account determines bank-transfer availability, never today's settings. */
export function hasInvoiceBankTransfer(sellerSnapshot: unknown): boolean {
  const account = parseSellerSnapshot(sellerSnapshot)?.bankAccount
  return Boolean(account?.iban?.trim() || (account?.regNumber?.trim() && account.accountNumber?.trim()))
}
