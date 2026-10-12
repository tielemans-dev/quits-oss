import { ACCOUNTING_EXPORT_COLUMNS } from "@quits/contracts/exports"
import { buildCsv, csvNumber } from "./csv"
import { parseBuyerSnapshot } from "@quits/contracts/documents"
import type { AccountingExportInput, AccountingExportResult } from "@quits/contracts/exports"
import { computeSettlement } from "../../domain/documents/settlement"
import { prisma } from "../db"
import { creditNotesCsv, invoicesCsv, paymentsCsv } from "./accounting-csv"
import { dateRangeInTimeZone } from "./format"
import { issuedNumber } from "../../domain/documents/numbering"

const FILE_PREFIX = {
  settlements: "settlements",
  invoices: "invoices",
  creditNotes: "credit-notes",
  payments: "payments",
} as const

function customerName(snapshot: unknown, contact: { name: string; company: string | null }) {
  const buyer = parseBuyerSnapshot(snapshot)
  return buyer?.company?.trim() || buyer?.name?.trim() || contact.company?.trim() || contact.name
}

/**
 * Builds an accounting CSV for an inclusive date range in the organization's time zone.
 * Invoices and credit notes are selected by issue date (drafts excluded), payments by payment
 * date (voided payments included and flagged).
 */
export async function exportAccounting(
  organizationId: string,
  input: AccountingExportInput
): Promise<AccountingExportResult> {
  const settings = await prisma.orgSettings.findUnique({
    where: { organizationId },
    select: { timezone: true },
  })
  const timeZone = settings?.timezone ?? "UTC"
  const { start, end } = dateRangeInTimeZone(input.from, input.to, timeZone)
  const filename = `${FILE_PREFIX[input.dataset]}-${input.from}_${input.to}.csv`
  const contact = { select: { name: true, company: true } } as const

  switch (input.dataset) {
    case "settlements": {
      const events = await prisma.domainEvent.findMany({ where: { organizationId, type: { startsWith: "settlement." }, occurredAt: { gte: start, lt: end } }, orderBy: { sequence: "asc" } })
      return { filename, csv: buildCsv(ACCOUNTING_EXPORT_COLUMNS.settlements, events.map(event => [event.id, csvNumber(String(event.schemaVersion)), event.occurredAt.toISOString(), event.type, event.actorKind, event.actorId, event.commandId, JSON.stringify(event.payload)])) }
    }
    case "invoices": {
      const invoices = await prisma.invoice.findMany({
        where: { organizationId, status: { not: "draft" }, issueDate: { gte: start, lt: end } },
        include: { contact },
        orderBy: [{ issueDate: "asc" }, { number: "asc" }],
      })
      const csv = invoicesCsv(
        invoices.map((invoice) => ({
          number: issuedNumber(invoice),
          issueDate: invoice.issueDate,
          dueDate: invoice.dueDate,
          customer: customerName(invoice.buyerSnapshot, invoice.contact),
          currency: invoice.currency,
          net: invoice.subtotalNet,
          tax: invoice.totalTax,
          gross: invoice.totalGross,
          paid: invoice.amountPaid,
          credited: invoice.amountCredited,
          balance: computeSettlement(invoice).balanceDue,
          status: invoice.status,
        })),
        timeZone
      )
      return { filename, csv }
    }
    case "creditNotes": {
      const creditNotes = await prisma.creditNote.findMany({
        where: { organizationId, status: { not: "draft" }, issueDate: { gte: start, lt: end } },
        include: { contact, invoice: { select: { number: true } } },
        orderBy: [{ issueDate: "asc" }, { number: "asc" }],
      })
      const csv = creditNotesCsv(
        creditNotes.map((creditNote) => ({
          number: creditNote.number,
          invoiceNumber: issuedNumber(creditNote.invoice),
          issueDate: creditNote.issueDate,
          customer: customerName(creditNote.buyerSnapshot, creditNote.contact),
          currency: creditNote.currency,
          net: creditNote.subtotalNet,
          tax: creditNote.totalTax,
          gross: creditNote.totalGross,
          reason: creditNote.reason,
        })),
        timeZone
      )
      return { filename, csv }
    }
    case "payments": {
      const payments = await prisma.payment.findMany({
        where: { organizationId, paidAt: { gte: start, lt: end } },
        include: {
          invoice: { select: { number: true, buyerSnapshot: true, contact } },
          receipt: { select: { currency: true } },
        },
        orderBy: [{ paidAt: "asc" }, { createdAt: "asc" }],
      })
      const csv = paymentsCsv(
        payments.map((payment) => ({
          paymentId: payment.id,
          receiptId: payment.receiptId,
          receiptAmount: payment.receiptAmount,
          receiptCurrency: payment.receipt?.currency,
          paidAt: payment.paidAt,
          invoiceNumber: issuedNumber(payment.invoice),
          customer: customerName(payment.invoice.buyerSnapshot, payment.invoice.contact),
          currency: payment.currency,
          amount: payment.amount,
          method: payment.method,
          reference: payment.reference,
          voidedAt: payment.voidedAt,
          voidReason: payment.voidReason,
        })),
        timeZone
      )
      return { filename, csv }
    }
  }
}
