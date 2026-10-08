import { Prisma, type PrismaClient } from "../../../generated/prisma/client"
import type { BillableAllocationState } from "@quits/contracts/billing"

type Reader = Pick<PrismaClient, "invoiceItem" | "deliverableRebill" | "invoice" | "creditNote">
type Visibility = { invoices: boolean; creditNotes: boolean }

/** A draft has no number until it is issued, so `number` is null while the holder is a draft. */
export type AllocationHolder = { invoiceId: string; invoiceItemId: string; number: string | null; status: string }
export type AllocationView = {
  state: BillableAllocationState
  generation: number
  /** The draft or invoice allocating the work now. Null when the work is unbilled or the actor may not read invoices. */
  holder: AllocationHolder | null
  creditedQuantity: string
  quantity: string
  /** True when the invoice carries an amount credit that is not tied to any line, so it says nothing about this work. */
  invoiceHasUntiedCredit: boolean
  creditNotes: Array<{ id: string; number: string }>
  rebill: { eligible: boolean; blocker: "not_invoiced" | "line_not_fully_credited" | "agreement_not_accepted" | null }
  rebills: Array<{ generation: number; priorInvoiceId: string | null; priorInvoiceNumber: string | null; creditNoteId: string | null; creditNoteNumber: string | null; reason: string; decidedBy: string; createdAt: string }>
}

/** Billing state of the work behind an agreement, derived from its current allocation and issued credits. */
export async function describeAllocations(
  db: Reader,
  organizationId: string,
  agreementId: string,
  lines: Array<{ id: string; billingStatus: string; billingGeneration: number }>,
  visible: Visibility,
  agreementStatus: string,
): Promise<Map<string, AllocationView>> {
  const [items, rebills] = await Promise.all([
    db.invoiceItem.findMany({
      where: { deliverableId: { in: lines.map(line => line.id) }, invoice: { organizationId } },
      select: { id: true, deliverableId: true, allocationGeneration: true, quantity: true,
        invoice: { select: { id: true, number: true, status: true, creditNotes: { where: { status: "issued" }, select: { id: true, number: true, items: { select: { invoiceItemId: true, quantity: true } } } } } } },
    }),
    db.deliverableRebill.findMany({ where: { agreementId, agreement: { organizationId } }, orderBy: { generation: "asc" } }),
  ])
  const numbers = new Map<string, string>()
  if (rebills.length) {
    const ids = [...new Set(rebills.map(row => row.priorInvoiceId))]
    const creditIds = [...new Set(rebills.map(row => row.creditNoteId))]
    const [invoices, credits] = await Promise.all([
      visible.invoices ? db.invoice.findMany({ where: { id: { in: ids }, organizationId }, select: { id: true, number: true } }) : Promise.resolve([]),
      visible.creditNotes ? db.creditNote.findMany({ where: { id: { in: creditIds }, organizationId }, select: { id: true, number: true } }) : Promise.resolve([]),
    ])
    invoices.forEach(row => row.number && numbers.set(`invoice:${row.id}`, row.number))
    credits.forEach(row => numbers.set(`credit:${row.id}`, row.number))
  }
  const views = new Map<string, AllocationView>()
  for (const line of lines) {
    const item = items.find(row => row.deliverableId === line.id && row.allocationGeneration === line.billingGeneration)
    const zero = new Prisma.Decimal(0)
    const credited = item ? item.invoice.creditNotes.flatMap(note => note.items.filter(row => row.invoiceItemId === item.id)).reduce((sum, row) => sum.plus(row.quantity), zero) : zero
    const quantity = item?.quantity ?? zero
    const tied = item ? item.invoice.creditNotes.filter(note => note.items.some(row => row.invoiceItemId === item.id)) : []
    const fully = !!item && quantity.gt(0) && credited.gte(quantity)
    const state: BillableAllocationState = line.billingStatus === "unbilled" ? "unbilled" : line.billingStatus === "reserved" ? "reserved"
      : fully ? "credited" : credited.gt(0) ? "partially_credited" : "invoiced"
    views.set(line.id, {
      state, generation: line.billingGeneration,
      holder: item && visible.invoices ? { invoiceId: item.invoice.id, invoiceItemId: item.id, number: item.invoice.number, status: item.invoice.status } : null,
      creditedQuantity: credited.toString(), quantity: quantity.toString(),
      invoiceHasUntiedCredit: !!item && item.invoice.creditNotes.some(note => note.items.some(row => row.invoiceItemId === null)),
      creditNotes: visible.creditNotes ? tied.map(note => ({ id: note.id, number: note.number })) : [],
      rebill: { eligible: agreementStatus === "accepted" && state === "credited", blocker: agreementStatus !== "accepted" ? "agreement_not_accepted" : line.billingStatus !== "invoiced" ? "not_invoiced" : fully ? null : "line_not_fully_credited" },
      rebills: rebills.filter(row => row.deliverableId === line.id).map(row => ({
        generation: row.generation, priorInvoiceId: visible.invoices ? row.priorInvoiceId : null, priorInvoiceNumber: visible.invoices ? numbers.get(`invoice:${row.priorInvoiceId}`) ?? null : null,
        creditNoteId: visible.creditNotes ? row.creditNoteId : null, creditNoteNumber: visible.creditNotes ? numbers.get(`credit:${row.creditNoteId}`) ?? null : null,
        reason: row.reason, decidedBy: row.decidedBy, createdAt: row.createdAt.toISOString() })),
    })
  }
  return views
}
