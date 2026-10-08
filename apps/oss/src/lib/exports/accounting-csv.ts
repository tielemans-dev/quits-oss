import {
  ACCOUNTING_EXPORT_COLUMNS,
  type AccountingColumn,
  type AccountingDataset,
} from "@quits/contracts/exports"
import { buildCsv, csvNumber, type CsvCell } from "./csv"
import { formatAmount, formatIsoDate, type DecimalLike } from "./format"

type Row<Dataset extends AccountingDataset> = Record<AccountingColumn<Dataset>, CsvCell>

export type InvoiceExportRow = {
  number: string
  issueDate: Date
  dueDate: Date
  customer: string
  currency: string
  net: DecimalLike
  tax: DecimalLike
  gross: DecimalLike
  paid: DecimalLike
  credited: DecimalLike
  balance: DecimalLike
  status: string
}

export type CreditNoteExportRow = {
  number: string
  invoiceNumber: string
  issueDate: Date
  customer: string
  currency: string
  net: DecimalLike
  tax: DecimalLike
  gross: DecimalLike
  reason: string
}

export type PaymentExportRow = {
  paidAt: Date
  invoiceNumber: string
  customer: string
  currency: string
  amount: DecimalLike
  method: string
  reference: string | null
  voidedAt: Date | null
  voidReason: string | null
}

const amount = (value: DecimalLike) => csvNumber(formatAmount(value))

function toCsv<Dataset extends AccountingDataset>(dataset: Dataset, rows: Row<Dataset>[]) {
  const columns = ACCOUNTING_EXPORT_COLUMNS[dataset] as readonly AccountingColumn<Dataset>[]
  return buildCsv(
    columns,
    rows.map((row) => columns.map((column) => row[column]))
  )
}

export function invoicesCsv(rows: readonly InvoiceExportRow[], timeZone: string) {
  return toCsv(
    "invoices",
    rows.map((row) => ({
      number: row.number,
      issue_date: formatIsoDate(row.issueDate, timeZone),
      due_date: row.dueDate.toISOString().slice(0, 10),
      customer: row.customer,
      currency: row.currency,
      net: amount(row.net),
      tax: amount(row.tax),
      gross: amount(row.gross),
      paid: amount(row.paid),
      credited: amount(row.credited),
      balance: amount(row.balance),
      status: row.status,
    }))
  )
}

export function creditNotesCsv(rows: readonly CreditNoteExportRow[], timeZone: string) {
  return toCsv(
    "creditNotes",
    rows.map((row) => ({
      number: row.number,
      invoice_number: row.invoiceNumber,
      issue_date: formatIsoDate(row.issueDate, timeZone),
      customer: row.customer,
      currency: row.currency,
      net: amount(row.net),
      tax: amount(row.tax),
      gross: amount(row.gross),
      reason: row.reason,
    }))
  )
}

export function paymentsCsv(rows: readonly PaymentExportRow[], timeZone: string) {
  return toCsv(
    "payments",
    rows.map((row) => ({
      paid_date: formatIsoDate(row.paidAt, timeZone),
      invoice_number: row.invoiceNumber,
      customer: row.customer,
      currency: row.currency,
      amount: amount(row.amount),
      method: row.method,
      reference: row.reference,
      voided: row.voidedAt !== null,
      void_reason: row.voidReason,
    }))
  )
}
