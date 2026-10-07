import { creditComponents } from "@quits/shared/pricing"
import type { CreditedGroup, FrozenVatGroup } from "@quits/contracts/pricing"

/**
 * Pure credit note arithmetic shared by the issue command and the create dialog preview.
 *
 * All math runs on integers: money in cents and quantities in hundredths, matching the
 * two-decimal columns they are stored in. New credit amounts are additionally rounded to the
 * precision of the invoice currency (whole units for JPY), so crediting never leaves a balance
 * the currency cannot be paid in; quantities keep two decimals. Partial line credits are prorated from the invoice
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
  vatRateInput?: string | null
  groupKey?: string
  vatTreatment?: string
  vatCountry?: string | null
  vatReasonCode?: string | null
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
  /** Decimal places credit amounts are rounded to, from the invoice currency (at most 2). */
  fractionDigits: number
  groups?: Array<{ original: FrozenVatGroup; creditedGross: string; creditedTax: string; creditedRounding: string }>
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
  vatRateInput?: string | null
  groupKey?: string
  vatTreatment?: string
  vatCountry?: string | null
  vatReasonCode?: string | null
}

export type CreditBuildErrorCode =
  | "fully_credited"
  | "unknown_invoice_line"
  | "duplicate_invoice_line"
  | "quantity_exceeds_remaining"
  | "exceeds_invoice_total"
  | "nothing_to_credit"
  | "amount_not_representable"
  | "line_components_conflict"

export type CreditBuildResult =
  | {
      ok: true
      lines: CreditDraftLine[]
      subtotalNet: number
      totalTax: number
      totalGross: number
      payableRounding?: number
      creditedGroups?: CreditedGroup[]
    }
  | { ok: false; code: CreditBuildErrorCode; message: string }

const toCents = (value: number) => Math.round(value * 100)
const fromCents = (value: number) => value / 100

/** Cents in the smallest unit of a currency with `fractionDigits` decimals, e.g. 100 for JPY. */
function minorUnitCents(fractionDigits = 2) {
  return 10 ** (2 - Math.min(Math.max(Math.trunc(fractionDigits), 0), 2))
}

/** Rounds cents half away from zero to whole minor units of the currency. */
function roundToUnit(cents: number, unit: number) {
  return Math.round(cents / unit) * unit
}

/**
 * `amountCents * part / whole`, rounded half away from zero (for non-negative inputs) to whole
 * minor units of `unit` cents.
 */
function prorate(amountCents: number, part: number, whole: number, unit = 1) {
  return whole > 0 ? Math.round((amountCents * part) / (whole * unit)) * unit : 0
}

export function computeCreditAvailability(input: {
  /** Decimal places of the invoice currency; credits are rounded to this precision. */
  fractionDigits?: number
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
    fractionDigits: input.fractionDigits ?? 2,
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

/**
 * Credits `quantity` of one invoice line, never more than is left on it. Prorated amounts are
 * rounded to whole minor units of a currency with `fractionDigits` decimals.
 */
export function creditLine(
  availability: CreditLineAvailability,
  quantity: number,
  fractionDigits = 2
): CreditDraftLine {
  const { line } = availability
  const unit = minorUnitCents(fractionDigits)
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
    gross = Math.min(
      prorate(toCents(line.lineGross), quantityHundredths, wholeQuantity, unit),
      remainingGross
    )
    const proratedNet = Math.min(
      prorate(toCents(line.lineNet), quantityHundredths, wholeQuantity, unit),
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
 * Splits a gross credit into net and tax in whole minor units that sum exactly to the gross.
 *
 * Crediting the whole remaining balance reverses exactly the remaining net and tax. A smaller
 * amount takes tax in proportion to what is left, which never exceeds the remaining tax or net.
 */
export function allocateAmountCredit(input: {
  amount: number
  remainingNet: number
  remainingTax: number
  remainingGross: number
  /** Decimal places of the currency; the tax share is rounded to this precision. */
  fractionDigits?: number
}): { net: number; tax: number; gross: number } {
  const unit = minorUnitCents(input.fractionDigits)
  const gross = toCents(input.amount)
  const remainingNet = Math.max(toCents(input.remainingNet), 0)
  const remainingTax = Math.max(toCents(input.remainingTax), 0)

  let tax: number
  if (gross >= toCents(input.remainingGross)) {
    tax = remainingTax
  } else {
    tax = Math.min(prorate(gross, remainingTax, remainingNet + remainingTax, unit), remainingTax)
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
  /** Decimal places of the currency; an unsplit net is rounded to this precision. */
  fractionDigits?: number
}): CreditDraftLine {
  const gross = toCents(input.amount)
  const net = input.split
    ? toCents(input.split.net)
    : roundToUnit(gross / (1 + input.taxRate / 100), minorUnitCents(input.fractionDigits))
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
  if (availability.groups) return buildGroupCredits(input)
  const { fractionDigits } = availability
  const unit = minorUnitCents(fractionDigits)
  const remainingGross = toCents(availability.remainingGross)

  if (remainingGross <= 0) {
    return fail("fully_credited", "The invoice is already fully credited")
  }

  const amountLine = (amount: number) =>
    creditAmountLine({
      amount,
      taxRate: input.taxRate,
      description: input.amountDescription,
      fractionDigits,
      split: allocateAmountCredit({
        amount,
        remainingNet: availability.remainingNet,
        remainingTax: availability.remainingTax,
        remainingGross: availability.remainingGross,
        fractionDigits,
      }),
    })

  let lines: CreditDraftLine[]

  if (selection.mode === "full") {
    const lineCredits = availability.lines
      .filter((entry) => toCents(entry.remainingQuantity) > 0 || toCents(entry.remainingGross) > 0)
      .map((entry) => creditLine(entry, entry.remainingQuantity, fractionDigits))
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
        lines.push(creditLine(entry, selected.quantity, fractionDigits))
      }
    }
    lines = conserveInvoiceComponents(lines, availability)
  } else {
    // The exact remaining balance is always creditable, even if earlier data left it fractional.
    const amount = toCents(selection.amount)
    if (amount % unit !== 0 && amount !== remainingGross) {
      return fail(
        "amount_not_representable",
        fractionDigits === 0
          ? "The credit amount must be a whole number in this currency"
          : `The credit amount can have at most ${fractionDigits} decimal places in this currency`
      )
    }
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

/** Largest remainder in currency minor units. Canonical group keys break ties. */
function allocateGross(amount: number, weights: number[], keys: string[]) {
  const whole = weights.reduce((sum, weight) => sum + BigInt(weight), 0n)
  const shares = weights.map((weight, index) => {
    const product = BigInt(amount) * BigInt(weight)
    return { index, value: Number(product / whole), remainder: product % whole }
  })
  let left = amount - shares.reduce((sum, share) => sum + share.value, 0)
  for (const share of [...shares].sort((a, b) =>
    a.remainder === b.remainder ? keys[a.index]!.localeCompare(keys[b.index]!) : a.remainder > b.remainder ? -1 : 1
  )) {
    if (left-- <= 0) break
    share.value++
  }
  return shares.map((share) => share.value)
}

/** V2 consumes frozen group components and records every cumulative reversal. */
function buildGroupCredits(input: Parameters<typeof buildCreditLines>[0]): CreditBuildResult {
  const { availability } = input
  let { selection } = input
  const groups = availability.groups!
  const unit = minorUnitCents(availability.fractionDigits)
  const remaining = groups.map(({ original, creditedGross }) => toCents(Number(original.gross)) - toCents(Number(creditedGross)))
  const remainingTotal = remaining.reduce((sum, value) => sum + value, 0)
  if (remainingTotal <= 0) return fail("fully_credited", "The invoice is already fully credited")
  if (selection.mode === "full" && groups.every(({ original, creditedTax, creditedRounding }, index) => {
    const entries = availability.lines.filter((entry) => entry.line.groupKey === original.key)
    const sum = (pick: (entry: CreditLineAvailability) => number) => entries.reduce((sum, entry) => sum + toCents(pick(entry)), 0)
    const gross = sum((entry) => entry.remainingGross), tax = sum((entry) => entry.remainingTax), net = sum((entry) => entry.remainingNet)
    return gross === remaining[index] && tax === toCents(Number(original.tax)) - toCents(Number(creditedTax)) &&
      gross - net - tax === toCents(Number(original.payableRounding)) - toCents(Number(creditedRounding))
  })) selection = { mode: "lines", lines: availability.lines.filter((entry) => entry.remainingQuantity > 0).map((entry) => ({ invoiceItemId: entry.line.id, quantity: entry.remainingQuantity })) }
  const selectedLines: CreditDraftLine[] = []
  let amounts: number[]
  if (selection.mode === "lines") {
    const seen = new Set<string>()
    for (const selected of selection.lines) {
      if (seen.has(selected.invoiceItemId)) return fail("duplicate_invoice_line", "Each invoice line can be selected once")
      seen.add(selected.invoiceItemId)
      const entry = availability.lines.find((entry) => entry.line.id === selected.invoiceItemId)
      if (!entry) return fail("unknown_invoice_line", "The selected line is not on this invoice")
      if (toCents(selected.quantity) > toCents(entry.remainingQuantity))
        return fail("quantity_exceeds_remaining", `Only ${entry.remainingQuantity} can still be credited`)
      if (selected.quantity <= 0) continue
      // Each component comes from the selected frozen line, including its final residual.
      const whole = toCents(entry.line.quantity)
      const final = toCents(selected.quantity) === toCents(entry.remainingQuantity)
      const portion = (original: number, rest: number) => final ? rest : fromCents(prorate(toCents(original), toCents(selected.quantity), whole, unit))
      const { id: _id, ...frozen } = entry.line
      selectedLines.push({ ...frozen, invoiceItemId: entry.line.id, quantity: selected.quantity,
        lineNet: portion(entry.line.lineNet, entry.remainingNet),
        lineTax: portion(entry.line.lineTax, entry.remainingTax),
        lineGross: portion(entry.line.lineGross, entry.remainingGross),
      })
    }
    amounts = groups.map(({ original }) => selectedLines.filter((line) => line.groupKey === original.key).reduce((sum, line) => sum + toCents(line.lineGross), 0))
  } else {
    const amount = selection.mode === "full" ? remainingTotal : toCents(selection.amount)
    if (amount <= 0) return fail("nothing_to_credit", "The credit note total must be greater than zero")
    if (amount > remainingTotal) return fail("exceeds_invoice_total", `Only ${fromCents(remainingTotal)} can still be credited`)
    if (amount % unit !== 0) return fail("amount_not_representable", "The credit amount must use currency precision")
    amounts = allocateGross(amount / unit, remaining.map((value) => value / unit), groups.map(({ original }) => original.key)).map((value) => value * unit)
  }
  const lines: CreditDraftLine[] = []
  const creditedGroups: CreditedGroup[] = []
  for (const [index, previous] of groups.entries()) {
    const gross = amounts[index]!
    if (!gross) continue
    if (gross > remaining[index]!) return fail("exceeds_invoice_total", "Credit exceeds remaining VAT group gross")
    const { original } = previous
    // No valuation exists yet. Zero placeholders let the shared document arithmetic run;
    // they are never persisted or reported as a base valuation.
    const valued = original.grossBase !== null
    const component = creditComponents({ group: { ...original,
      netBase: original.netBase ?? "0", taxBase: original.taxBase ?? "0",
      grossBase: original.grossBase ?? "0", payableRoundingBase: original.payableRoundingBase ?? "0",
    }, cumulativeBefore: previous.creditedGross, creditedGross: String(fromCents(gross)) })
    let tax = toCents(Number(component.tax))
    let rounding = toCents(Number(component.payableRounding))
    const groupLines = selectedLines.filter((line) => line.groupKey === original.key)
    if (selection.mode === "lines") {
      tax = groupLines.reduce((sum, line) => sum + toCents(line.lineTax), 0)
      rounding = gross - tax - groupLines.reduce((sum, line) => sum + toCents(line.lineNet), 0)
      if (gross === remaining[index] && (
        tax !== toCents(Number(original.tax)) - toCents(Number(previous.creditedTax)) ||
        rounding !== toCents(Number(original.payableRounding)) - toCents(Number(previous.creditedRounding))
      )) return fail("line_components_conflict", "These frozen lines no longer match the remaining components. Credit the remaining amount instead.")
      lines.push(...groupLines)
    } else {
      // A frozen line's tax share can differ from its group's proportional entitlement.
      // Carry that residual into the next amount credit; the cumulative target is unchanged.
      if (Number(previous.creditedGross) > 0) {
        const entitled = creditComponents({ group: { ...original, netBase: "0", taxBase: "0", grossBase: "0", payableRoundingBase: "0" }, cumulativeBefore: "0", creditedGross: previous.creditedGross })
        tax += toCents(Number(entitled.tax)) - toCents(Number(previous.creditedTax))
        rounding += toCents(Number(entitled.payableRounding)) - toCents(Number(previous.creditedRounding))
      }
      lines.push({ invoiceItemId: null, description: input.amountDescription, quantity: 1,
        unitPriceNet: fromCents(gross - tax - rounding), unitPriceGross: fromCents(gross),
        lineNet: fromCents(gross - tax - rounding), lineTax: fromCents(tax), lineGross: fromCents(gross),
        vatRateInput: original.rate, taxRate: Number(original.rate) * 100, taxCategory: original.treatment, taxCode: null,
        vatTreatment: original.treatment, vatCountry: original.country, vatReasonCode: original.reasonCode,
      })
    }
    const net = gross - tax - rounding
    const before = toCents(Number(previous.creditedGross)), after = before + gross
    const taxBefore = toCents(Number(previous.creditedTax)), taxAfter = taxBefore + tax
    const roundingBefore = toCents(Number(previous.creditedRounding)), roundingAfter = roundingBefore + rounding
    const str = (value: number) => fromCents(value).toFixed(availability.fractionDigits)
    creditedGroups.push({ original, creditedGross: str(gross), creditedTax: str(tax), creditedNet: str(net), creditedRounding: str(rounding),
      cumulativeBefore: str(before), cumulativeAfter: str(after), cumulativeTaxBefore: str(taxBefore), cumulativeTaxAfter: str(taxAfter),
      cumulativeRoundingBefore: str(roundingBefore), cumulativeRoundingAfter: str(roundingAfter),
      remainingGross: str(toCents(Number(original.gross)) - after), remainingTax: str(toCents(Number(original.tax)) - taxAfter),
      remainingRounding: str(toCents(Number(original.payableRounding)) - roundingAfter),
      remainingNet: str(toCents(Number(original.net)) - (after - taxAfter - roundingAfter)),
      netBase: valued ? component.netBase : null, taxBase: valued ? component.taxBase : null,
      grossBase: valued ? component.grossBase : null, payableRoundingBase: valued ? component.payableRoundingBase : null,
    })
  }
  const totals = totalsOf(lines)
  if (totals.totalGross <= 0) return fail("nothing_to_credit", "The credit note total must be greater than zero")
  return { ok: true, lines, ...totals, creditedGroups,
    payableRounding: fromCents(creditedGroups.reduce((sum, group) => sum + toCents(Number(group.creditedRounding)), 0)) }
}
