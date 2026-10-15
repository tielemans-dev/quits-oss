import type { DocumentLineInput } from "@quits/contracts/invoices"
import type { DraftVatEvidence } from "@quits/contracts/vat"

import type { Translate } from "../components/dashboard/i18n"
import { issuanceInput, type IssuanceValues } from "../components/invoices/issuance-fields"
import { trpc } from "../trpc/client"
import { createThenSend, type CreatedDocumentTarget } from "./create-and-send"
import { invoiceFieldIssues, invoiceIssueKey } from "./invoice-field-issues"
import { clearDraftValuation, retainDraftValuation } from "./invoice-issuance-draft"

/** What the new-invoice form and the request card share: the one path that creates and sends an invoice. */
export type InvoiceSubmission = {
  paymentMethods?: ("bank_transfer" | "card")[]
  remindersPaused?: boolean
  contactId: string
  dueDate: string
  taxRate: string
  pricesIncludeTax: boolean
  vatEvidence: DraftVatEvidence
  notes?: string
  /** Quantities are canonical decimal-point strings. */
  items: { description: string; quantity: string; unitPrice: string; vat?: DocumentLineInput["vat"] }[]
  issuance: IssuanceValues
  currency: string
  baseCurrency?: string
}

export function submitInvoice(
  invoice: InvoiceSubmission,
  options: {
    sendImmediately: boolean
    /** The recipient version the person reviewed; the server refuses the send if the contact has changed since. */
    reviewedRecipient?: string
    beforeSend?: (id: string) => Promise<boolean>
    t: Translate
  }
): Promise<CreatedDocumentTarget> {
  const { sendImmediately, t } = options
  const { issuance, currency, baseCurrency } = invoice
  let reviewedVersion: string | undefined
  return createThenSend({
    create: async () => {
      const draft = await trpc.invoices.createV2.mutate({
        contactId: invoice.contactId,
        ...(invoice.paymentMethods === undefined ? {} : { paymentMethods: invoice.paymentMethods }),
        ...(invoice.remindersPaused === undefined ? {} : { remindersPaused: invoice.remindersPaused }),
        dueDate: invoice.dueDate,
        supplyDate: issuance.supplyDate,
        taxRate: invoice.taxRate,
        pricesIncludeTax: invoice.pricesIncludeTax,
        vatEvidence: invoice.vatEvidence,
        reviewedRecipient: sendImmediately ? options.reviewedRecipient : undefined,
        notes: invoice.notes || undefined,
        items: invoice.items.map((item) => ({
          description: item.description,
          quantity: String(item.quantity),
          unitPrice: String(item.unitPrice),
          vat: item.vat,
        })),
      })
      retainDraftValuation(draft.id, currency, baseCurrency, issuance)
      reviewedVersion = draft.reviewedVersion
      return draft
    },
    beforeSend: options.beforeSend,
    send: async (id) => {
      const result = await trpc.invoices.send.mutate({ id, reviewedVersion, ...issuanceInput(issuance, currency, baseCurrency) })
      clearDraftValuation(id, currency, baseCurrency)
      return result
    },
    sendImmediately,
    sendFailedMessage: t("invoices.detail.error.sendFailed"),
    sendErrorMessage: (error) => {
      const issues = invoiceFieldIssues(error)
      if (issues.length) return issues.map((issue) => t(invoiceIssueKey(issue.code), issue.params)).join(" · ")
      // The refusal's own message (missing exemption statement, provider failure, ...) beats a generic one.
      return error instanceof Error && error.message ? error.message : t("invoiceValidation.unknown")
    },
  })
}
