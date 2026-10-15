import type { RequestDraft } from "./request-parser"
import type { DocumentLineInput } from "@quits/contracts/invoices"
import type { DraftVatEvidence } from "@quits/contracts/vat"

import type { IssuanceValues } from "../components/invoices/issuance-fields"

/** An invoice on its way between the request card and the new-invoice form, with whatever has been edited so far. */
export type InvoiceHandoff = {
  /** The request that began it, so the card can open again for it. */
  input: string
  suggested?: RequestDraft
  contactId: string
  dueDate: string
  issuance: IssuanceValues
  taxRate: string
  pricesIncludeTax: boolean
  vatEvidence: DraftVatEvidence
  notes: string
  /** Quantities as the receiver shows them: localized for the form, canonical for the card. */
  items: { description: string; quantity: string; unitPrice: string; vat?: DocumentLineInput["vat"]; catalogItemId?: string }[]
}

// Held in memory only: it bridges one client-side navigation and a reload starts afresh.
let handoff: { to: "form" | "card"; draft: InvoiceHandoff } | null = null

export const handOff = (to: "form" | "card", draft: InvoiceHandoff) => { handoff = { to, draft } }
/** Reads without taking, so a remount cannot lose it; the receiver clears it once it has used it. */
export const readHandoff = (to: "form" | "card") => (handoff?.to === to ? handoff.draft : null)
export const clearHandoff = () => { handoff = null }
