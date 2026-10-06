/**
 * Pure credit note arithmetic shared by the issue command and the create dialog preview.
 *
 * All math runs on integers: money in cents and quantities in hundredths, matching the
 * two-decimal columns they are stored in. Partial line credits are prorated from the invoice
 * line and capped by what is still uncredited on that line, so crediting a line in several
 * steps never credits more than the line, and the final step credits the exact remainder.
 *
 * Invoice-level net and tax are conserved as well: amount credits are split in proportion to
 * the net and tax still uncredited on the invoice, and a credit of the remaining balance
 * reverses exactly the remaining net and tax, so the credit notes of an invoice never reverse
 * more net or tax than it charged and a full credit reverses all of it.
 */

export type CreditableInvoiceLine = {
  id: string
  description: string
  quantity: number
  unitPriceNet: number
  unitPriceGross: number
  lineNet: number
  lineTax: number
  lineGross: number
  taxRate: number
  taxCategory: string
  taxCode: string | null
}

/** A line of an earlier credit note for the same invoice. */
export type PriorCreditLine = {
  invoiceItemId: string | null
  quantity: number
  lineNet: number
  lineTax: number
  lineGross: number
}

export type CreditLineAvailability = {
  line: CreditableInvoiceLine
  creditedQuantity: number
  remainingQuantity: number
  remainingNet: number
  remainingTax: number
  remainingGross: number
}

export type CreditAvailability = {
  lines: CreditLineAvailability[]
  totalNet: number
  totalTax: number
  totalGross: number
  creditedNet: number
  creditedTax: number
  creditedGross: number
  /** Net amount not yet reversed by earlier credit notes. */
  remainingNet: number
  /** Tax amount not yet reversed by earlier credit notes. */
  remainingTax: number
  /** Gross amount that can still be credited on the invoice. */
  remainingGross: number
}

export type CreditSelection =
  | { mode: "full" }
  | { mode: "lines"; lines: ReadonlyArray<{ invoiceItemId: string; quantity: number }> }
  | { mode: "amount"; amount: number }

export type CreditDraftLine = {
  invoiceItemId: string | null
  description: string
  quantity: number
  unitPriceNet: number
  unitPriceGross: number
  lineNet: number
  lineTax: number
  lineGross: number
  taxRate: number
  taxCategory: string
  taxCode: string | null
}

export type CreditBuildErrorCode =
  | "fully_credited"
  | "unknown_invoice_line"
  | "duplicate_invoice_line"
  | "quantity_exceeds_remaining"
  | "exceeds_invoice_total"
  | "nothing_to_credit"

export type CreditBuildResult =
  | {
      ok: true
      lines: CreditDraftLine[]
      subtotalNet: number
      totalTax: number
      totalGross: number
    }
  | { ok: false; code: CreditBuildErrorCode; message: string }

const toCents = (value: number) => Math.round(value * 100)
const fromCents = (value: number) => value / 100

/** Rounds half away from zero for non-negative integer ratios. */
function prorate(amountCents: number, part: number, whole: number) {
  return whole > 0 ? Math.round((amountCents * part) / whole) : 0
}

export function computeCreditAvailability(input: {
  lines: readonly CreditableInvoiceLine[]
  priorCredits: readonly PriorCreditLine[]
  totalNet: number
  totalTax: number
  totalGross: number
  /** Totals of earlier credit notes, including amount-only credits. */
  creditedNet: number
  creditedTax: number
  creditedGross: number
}): CreditAvailability {
  const lines = input.lines.map((line) => {
    const prior = input.priorCredits.filter((credit) => credit.invoiceItemId === line.id)
    const sum = (pick: (credit: PriorCreditLine) => number) =>
      prior.reduce((total, credit) => total + toCents(pick(credit)), 0)

    const creditedQuantity = sum((credit) => credit.quantity)
    return {
      line,
      creditedQuantity: fromCents(creditedQuantity),
      remainingQuantity: fromCents(Math.max(toCents(line.quantity) - creditedQuantity, 0)),
      remainingNet: fromCents(Math.max(toCents(line.lineNet) - sum((credit) => credit.lineNet), 0)),
      remainingTax: fromCents(Math.max(toCents(line.lineTax) - sum((credit) => credit.lineTax), 0)),
      remainingGross: fromCents(
        Math.max(toCents(line.lineGross) - sum((credit) => credit.lineGross), 0)
      ),
    }
  })

  const remaining = (total: number, credited: number) =>
    fromCents(Math.max(toCents(total) - toCents(credited), 0))

  return {
    lines,
    totalNet: input.totalNet,
    totalTax: input.totalTax,
    totalGross: input.totalGross,
    creditedNet: input.creditedNet,
    creditedTax: input.creditedTax,
    creditedGross: input.creditedGross,
    remainingNet: remaining(input.totalNet, input.creditedNet),
    remainingTax: remaining(input.totalTax, input.creditedTax),
    remainingGross: remaining(input.totalGross, input.creditedGross),
  }
}

/** Credits `quantity` of one invoice line, never more than is left on it. */
export function creditLine(availability: CreditLineAvailability, quantity: number): CreditDraftLine {
  const { line } = availability
  const quantityHundredths = toCents(quantity)
  const remainingNet = toCents(availability.remainingNet)
  const remainingTax = toCents(availability.remainingTax)
  const remainingGross = toCents(availability.remainingGross)

  let net: number
  let tax: number
  let gross: number

  if (quantityHundredths >= toCents(availability.remainingQuantity)) {
    net = remainingNet
    tax = remainingTax
    gross = remainingGross
  } else {
    const wholeQuantity = toCents(line.quantity)
    gross = Math.min(prorate(toCents(line.lineGross), quantityHundredths, wholeQuantity), remainingGross)
    const proratedNet = Math.min(
      prorate(toCents(line.lineNet), quantityHundredths, wholeQuantity),
      remainingNet
    )
    tax = Math.min(Math.max(gross - proratedNet, 0), remainingTax)
    net = gross - tax
  }

  return {
    invoiceItemId: line.id,
    description: line.description,
    quantity: fromCents(quantityHundredths),
    unitPriceNet: line.unitPriceNet,
    unitPriceGross: line.unitPriceGross,
    lineNet: fromCents(net),
    lineTax: fromCents(tax),
    lineGross: fromCents(gross),
    taxRate: line.taxRate,
    taxCategory: line.taxCategory,
    taxCode: line.taxCode,
  }
}

/**
 * Splits a gross credit into net and tax in whole cents that sum exactly to the gross.
 *
 * Crediting the whole remaining balance reverses exactly the remaining net and tax. A smaller
 * amount takes tax in proportion to what is left, which never exceeds the remaining tax or net.
 */
export function allocateAmountCredit(input: {
  amount: number
  remainingNet: number
  remainingTax: number
  remainingGross: number
}): { net: number; tax: number; gross: number } {
  const gross = toCents(input.amount)
  const remainingNet = Math.max(toCents(input.remainingNet), 0)
  const remainingTax = Math.max(toCents(input.remainingTax), 0)

  let tax: number
  if (gross >= toCents(input.remainingGross)) {
    tax = remainingTax
  } else {
    tax = Math.min(prorate(gross, remainingTax, remainingNet + remainingTax), remainingTax)
  }
  // Keep both components within what is left even when stored totals disagree by a cent.
  tax = Math.min(Math.max(tax, gross - remainingNet, 0), gross)
  return { net: fromCents(gross - tax), tax: fromCents(tax), gross: fromCents(gross) }
}

/**
 * One line for a gross amount. Without explicit `net`/`tax` it is split at `taxRate` percent;
 * {@link buildCreditLines} passes the split from {@link allocateAmountCredit} instead.
 */
export function creditAmountLine(input: {
  amount: number
  taxRate: number
  description: string
  taxCategory?: string
  split?: { net: number; tax: number }
}): CreditDraftLine {
  const gross = toCents(input.amount)
  const net = input.split ? toCents(input.split.net) : Math.round(gross / (1 + input.taxRate / 100))
  return {
    invoiceItemId: null,
    description: input.description,
    quantity: 1,
    unitPriceNet: fromCents(net),
    unitPriceGross: fromCents(gross),
    lineNet: fromCents(net),
    lineTax: fromCents(gross - net),
    lineGross: fromCents(gross),
    taxRate: input.taxRate,
    taxCategory: input.taxCategory ?? "standard",
    taxCode: null,
  }
}

function totalsOf(lines: CreditDraftLine[]) {
  const sum = (pick: (line: CreditDraftLine) => number) =>
    fromCents(lines.reduce((total, line) => total + toCents(pick(line)), 0))
  return {
    subtotalNet: sum((line) => line.lineNet),
    totalTax: sum((line) => line.lineTax),
    totalGross: sum((line) => line.lineGross),
  }
}

/**
 * After amount credits, a line credit can round a cent of tax beyond what is left on the
 * invoice. Move such cents between net and tax so invoice-level net and tax stay conserved.
 */
function conserveInvoiceComponents(lines: CreditDraftLine[], availability: CreditAvailability) {
  const totals = totalsOf(lines)
  const remainingNet = toCents(availability.remainingNet)
  const remainingTax = toCents(availability.remainingTax)
  let shift = 0 // cents moved from tax to net
  if (toCents(totals.totalTax) > remainingTax) shift = toCents(totals.totalTax) - remainingTax
  else if (toCents(totals.subtotalNet) > remainingNet) shift = remainingNet - toCents(totals.subtotalNet)
  if (shift === 0) return lines

  return lines.map((line) => {
    if (shift === 0) return line
    const tax = toCents(line.lineTax)
    const net = toCents(line.lineNet)
    const moved = shift > 0 ? Math.min(shift, tax) : Math.max(shift, -net)
    shift -= moved
    return { ...line, lineNet: fromCents(net + moved), lineTax: fromCents(tax - moved) }
  })
}

function fail(code: CreditBuildErrorCode, message: string): CreditBuildResult {
  return { ok: false, code, message }
}

/**
 * Builds the lines of a new credit note. Rejects selections that would credit more than an
 * invoice line has left, or more than the invoice total in all.
 */
export function buildCreditLines(input: {
  availability: CreditAvailability
  selection: CreditSelection
  /** Tax rate applied to amount credits, in percent. */
  taxRate: number
  /** Description of an amount credit line, e.g. "Credit for INV-0042". */
  amountDescription: string
}): CreditBuildResult {
  const { availability, selection } = input
  const remainingGross = toCents(availability.remainingGross)

  if (remainingGross <= 0) {
    return fail("fully_credited", "The invoice is already fully credited")
  }

  const amountLine = (amount: number) =>
    creditAmountLine({
      amount,
      taxRate: input.taxRate,
      description: input.amountDescription,
      split: allocateAmountCredit({
        amount,
        remainingNet: availability.remainingNet,
        remainingTax: availability.remainingTax,
        remainingGross: availability.remainingGross,
      }),
    })

  let lines: CreditDraftLine[]

  if (selection.mode === "full") {
    const lineCredits = availability.lines
      .filter((entry) => toCents(entry.remainingQuantity) > 0 || toCents(entry.remainingGross) > 0)
      .map((entry) => creditLine(entry, entry.remainingQuantity))
    const lineTotals = totalsOf(lineCredits)
    // Amount-only credits are not tied to lines, so the per-line remainders no longer add up to
    // what is left on the invoice. Credit the remaining balance as one amount line instead,
    // reversing exactly the net and tax still left.
    const matchesRemainder =
      toCents(lineTotals.totalGross) === remainingGross &&
      toCents(lineTotals.subtotalNet) === toCents(availability.remainingNet) &&
      toCents(lineTotals.totalTax) === toCents(availability.remainingTax)
    lines = matchesRemainder ? lineCredits : [amountLine(fromCents(remainingGross))]
  } else if (selection.mode === "lines") {
    const seen = new Set<string>()
    lines = []
    for (const selected of selection.lines) {
      if (seen.has(selected.invoiceItemId)) {
        return fail("duplicate_invoice_line", "Each invoice line can be selected once")
      }
      seen.add(selected.invoiceItemId)

      const entry = availability.lines.find((candidate) => candidate.line.id === selected.invoiceItemId)
      if (!entry) {
        return fail("unknown_invoice_line", "The selected line is not on this invoice")
      }
      if (toCents(selected.quantity) > toCents(entry.remainingQuantity)) {
        return fail(
          "quantity_exceeds_remaining",
          `Only ${entry.remainingQuantity} of "${entry.line.description}" can still be credited`
        )
      }
      if (toCents(selected.quantity) > 0) {
        lines.push(creditLine(entry, selected.quantity))
      }
    }
    lines = conserveInvoiceComponents(lines, availability)
  } else {
    lines = [amountLine(selection.amount)]
  }

  const totals = totalsOf(lines)
  if (toCents(totals.totalGross) <= 0) {
    return fail("nothing_to_credit", "The credit note total must be greater than zero")
  }
  if (toCents(totals.totalGross) > remainingGross) {
    return fail(
      "exceeds_invoice_total",
      `Only ${fromCents(remainingGross)} of the invoice can still be credited`
    )
  }

  return { ok: true, lines, ...totals }
}
