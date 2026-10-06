/**
 * RFC 4180 CSV writer with spreadsheet formula-injection protection.
 *
 * Text cells that a spreadsheet would evaluate as a formula (starting with =, +, -, @, tab or
 * carriage return) are prefixed with an apostrophe. Numeric cells built with `csvNumber` are
 * trusted, so negative amounts stay numbers.
 */

const NUMERIC_CELL = Symbol("csvNumber")

export type CsvNumber = { readonly [NUMERIC_CELL]: true; readonly value: string }
export type CsvCell = string | boolean | null | undefined | CsvNumber

const NUMERIC_PATTERN = /^-?\d+(\.\d+)?$/

/** Marks an already formatted number (e.g. "-12.50") as a numeric cell. */
export function csvNumber(value: string): CsvNumber {
  if (!NUMERIC_PATTERN.test(value)) {
    throw new Error(`Not a plain decimal number: ${value}`)
  }
  return { [NUMERIC_CELL]: true, value }
}

function isCsvNumber(cell: CsvCell): cell is CsvNumber {
  return typeof cell === "object" && cell !== null && NUMERIC_CELL in cell
}

const FORMULA_TRIGGERS = new Set(["=", "+", "-", "@", "\t", "\r"])

export function neutralizeFormula(value: string): string {
  return value.length > 0 && FORMULA_TRIGGERS.has(value[0]!) ? `'${value}` : value
}

export function formatCsvCell(cell: CsvCell): string {
  if (cell === null || cell === undefined) return ""
  if (isCsvNumber(cell)) return cell.value
  const text = typeof cell === "boolean" ? (cell ? "true" : "false") : neutralizeFormula(cell)
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export function buildCsv(header: readonly string[], rows: readonly (readonly CsvCell[])[]): string {
  const lines = [header.map(formatCsvCell).join(",")]
  for (const row of rows) {
    if (row.length !== header.length) {
      throw new Error(`CSV row has ${row.length} cells, expected ${header.length}`)
    }
    lines.push(row.map(formatCsvCell).join(","))
  }
  return `${lines.join("\r\n")}\r\n`
}
