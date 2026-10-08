import Decimal from "decimal.js-light"
import type {
  DocumentKind, DocumentView, DocumentViewBuyer, DocumentViewLine, DocumentViewLineVat,
  DocumentViewPaymentDetails, DocumentViewSeller, DocumentViewVatGroup,
} from "@quits/contracts/document-view"
import type { BuyerSnapshot, DocumentTaxId, SellerSnapshot } from "@quits/contracts/documents"
import type { DocumentLineInput } from "@quits/contracts/invoices"
import { hasBankAccount, hasPaymentDetails } from "@quits/contracts/payment-details"
import { decimalStringSchema, draftVatClassificationSchema } from "@quits/contracts/vat"
import type { DraftVatEvidence, VatEvidence, VatReasonCode, VatTreatment } from "@quits/contracts/vat"
import { requireCurrencyExponent } from "../currency"
import { documentVat, previewDraft, vatGroupKey } from "../pricing"

// Isolated from callers' Decimal configuration, like the pricing engine.
const D = Decimal.clone({ precision: 1024, rounding: Decimal.ROUND_HALF_UP })

/** `INV-0042`. The number a document would receive; also used by the client to preview the next one. */
export function formatDocumentNumber(prefix: string, value: number) {
  return `${prefix}-${String(value).padStart(4, "0")}`
}

/** Fixed to the currency's exponent, and never "-0.00". */
const fixed = (value: Decimal, exponent: number) => value.isZero() ? new D(0).toFixed(exponent) : value.toFixed(exponent)
const sum = (values: Decimal[]) => values.reduce((total, value) => total.plus(value), new D(0))
const byKey = (a: { key: string }, b: { key: string }) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0

/** A quantity or price as the user typed it. A number that is not finite is left empty, so it never calculates. */
const asEntered = (value: string | number) => typeof value === "number" ? (Number.isFinite(value) ? String(value) : "") : value

/** A calendar date as "YYYY-MM-DD", or null: a half-typed date is not a date. */
const calendarDate = (value: string | null | undefined) => value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null

function sellerView(seller: SellerSnapshot | null | undefined, logoUrl: string | null | undefined): DocumentViewSeller {
  return {
    name: seller?.companyName ?? null,
    email: seller?.companyEmail ?? null,
    address: seller?.companyAddress ?? null,
    logoUrl: logoUrl ?? null,
    taxIds: taxIdsView(seller?.taxIds),
  }
}

function taxIdsView(taxIds: readonly DocumentTaxId[] | undefined): DocumentTaxId[] {
  return (taxIds ?? []).map((taxId) => ({
    ...(taxId.scheme !== undefined ? { scheme: taxId.scheme } : {}),
    value: taxId.value,
    ...(taxId.countryCode !== undefined ? { countryCode: taxId.countryCode } : {}),
  }))
}

function buyerView(buyer: BuyerSnapshot | null | undefined, contactId: string | null | undefined): DocumentViewBuyer | null {
  if (!buyer) return null
  return {
    name: buyer.name ?? null, email: buyer.email ?? null, company: buyer.company ?? null, address: buyer.address ?? null,
    city: buyer.city ?? null, state: buyer.state ?? null, zip: buyer.zip ?? null, country: buyer.country ?? null,
    taxIds: taxIdsView(buyer.taxIds), contactId: contactId ?? null,
  }
}

/**
 * Printed only when the seller has an account or a note, as on the PDF. A credit note is not paid,
 * so it never carries payment details.
 */
function paymentDetailsView(
  seller: SellerSnapshot | null | undefined, reference: string | null, kind: DocumentKind
): DocumentViewPaymentDetails | null {
  const bankAccount = seller?.bankAccount ?? null
  const note = seller?.paymentNote?.trim() ? seller.paymentNote : null
  if (kind === "creditNote" || !hasPaymentDetails({ bankAccount, note })) return null
  return {
    bankAccount: bankAccount && hasBankAccount(bankAccount) ? {
      accountHolder: bankAccount.accountHolder ?? null, bankName: bankAccount.bankName ?? null,
      regNumber: bankAccount.regNumber ?? null, accountNumber: bankAccount.accountNumber ?? null,
      iban: bankAccount.iban ?? null, bic: bankAccount.bic ?? null,
    } : null,
    note,
    reference,
  }
}

function notesView(notes: string | null | undefined) {
  return notes?.trim() ? notes : null
}

// ---------------------------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------------------------

export type DraftViewLineInput = {
  /** The persisted line id, once the line has one. */
  id?: string | null
  /** The key the client gave the line. Used when there is no id. */
  clientKey?: string
  description: string
  /** As entered. */
  quantity: string | number
  /** As entered, on the document's price basis. */
  unitPrice: string | number
  vat?: DocumentLineInput["vat"]
  /**
   * An agreement-linked line. Its stored amounts stand: it is never repriced, and `vat` must be its
   * complete classification. Amounts are decimal strings (as stored, at most the currency's exponent).
   */
  frozen?: { net: string; tax: string; gross: string }
}

export type DraftViewInput = {
  kind: "invoice" | "quote"
  status: string
  locale: string
  timezone: string
  currency: string
  pricesIncludeTax: boolean
  /** The document's VAT rate in percent; lines without their own classification use it. */
  taxRate: string | number
  lines: readonly DraftViewLineInput[]
  vatEvidence?: DraftVatEvidence | null
  /** A draft normally has none; one that already took its number keeps it. */
  number?: string | null
  /** The provisional next number. Dropped when the draft already has a number. */
  previewNumber?: string | null
  dates?: { issueDate?: string | null; supplyDate?: string | null; dueDate?: string | null; expiryDate?: string | null }
  /** Settings-derived seller details, including the payment details snapshot. */
  seller?: SellerSnapshot | null
  logoUrl?: string | null
  buyer?: BuyerSnapshot | null
  contactId?: string | null
  notes?: string | null
  paymentReference?: string | null
  /** The stored draft was priced by the legacy calculation and has not been repriced yet. */
  staleLegacy?: boolean
}

type FrozenAmounts = { net: Decimal; tax: Decimal; gross: Decimal; vat: ReturnType<typeof draftVatClassificationSchema.parse> }

/** `null` when the frozen line cannot be read exactly; it then stops the document from calculating. */
function readFrozen(line: DraftViewLineInput, exponent: number): FrozenAmounts | null {
  if (!line.frozen || !line.vat) return null
  const vat = draftVatClassificationSchema.safeParse(line.vat)
  if (!vat.success) return null
  const amounts: Decimal[] = []
  for (const value of [line.frozen.net, line.frozen.tax, line.frozen.gross]) {
    if (!decimalStringSchema.safeParse(value).success) return null
    const amount = new D(value)
    if (!amount.toDecimalPlaces(exponent, D.ROUND_HALF_UP).eq(amount)) return null
    amounts.push(amount)
  }
  return { net: amounts[0]!, tax: amounts[1]!, gross: amounts[2]!, vat: vat.data }
}

type GroupSums = { treatment: VatTreatment; rate: string; reasonCode: VatReasonCode | null; country: string | null; net: Decimal; tax: Decimal; gross: Decimal; payableRounding: Decimal }

/**
 * The view of a draft. Amounts come only from `calculateDraft`, and from the stored amounts of
 * agreement-linked lines, which are added with Decimal. A draft that cannot be calculated (an empty
 * price, a decimal comma, too many decimals, mixed out-of-scope) has `totals: null`, no VAT groups and
 * no calculated line amounts. It is never guessed.
 *
 * Throws only for a currency without a supported precision.
 */
export function buildDraftView(input: DraftViewInput): DocumentView {
  const exponent = requireCurrencyExponent(input.currency)
  const prepared = input.lines.map((line, index) => ({
    line,
    key: line.id || line.clientKey || `line-${index}`,
    frozen: line.frozen ? readFrozen(line, exponent) : undefined,
  }))

  const calculated = calculate(input, prepared.map((entry) => entry.frozen), exponent)
  let nextCalculated = 0
  const lines: DocumentViewLine[] = prepared.map(({ line, key, frozen }) => {
    const base = { key, id: line.id || null, description: line.description, quantity: asEntered(line.quantity), unitPrice: asEntered(line.unitPrice) }
    if (line.frozen) {
      const vat = frozen ? lineVat(frozen.vat) : null
      return frozen
        ? { ...base, vat, ...amountsOf(frozen.net, frozen.tax, frozen.gross, input.pricesIncludeTax, exponent), locked: true }
        : { ...base, vat: null, ...noAmounts, locked: true }
    }
    const result = calculated?.lines[nextCalculated++]
    return {
      ...base, vat: result ? lineVat(result.vat) : enteredVat(line, input.taxRate),
      ...(result ? amountsOf(new D(result.net), new D(result.tax), new D(result.gross), input.pricesIncludeTax, exponent) : noAmounts),
      locked: false,
    }
  })

  const value = input.number ?? null
  const reference = input.paymentReference?.trim() || value
  return {
    kind: input.kind, state: "draft", status: input.status,
    number: { value, preview: value === null ? input.previewNumber ?? null : null },
    locale: input.locale, timezone: input.timezone, currency: input.currency, exponent, pricesIncludeTax: input.pricesIncludeTax,
    seller: sellerView(input.seller, input.logoUrl), buyer: buyerView(input.buyer, input.contactId),
    dates: {
      issueDate: calendarDate(input.dates?.issueDate), supplyDate: calendarDate(input.dates?.supplyDate),
      dueDate: calendarDate(input.dates?.dueDate), expiryDate: calendarDate(input.dates?.expiryDate),
    },
    lines, vatGroups: calculated?.vatGroups ?? [], totals: calculated?.totals ?? null,
    vatEvidence: input.vatEvidence ?? null, notes: notesView(input.notes),
    paymentDetails: paymentDetailsView(input.seller, reference || null, input.kind),
    calculation: { version: "v2", staleLegacy: input.staleLegacy ?? false },
  }
}

const noAmounts = { net: null, tax: null, gross: null, amount: null } as const

function amountsOf(net: Decimal, tax: Decimal, gross: Decimal, pricesIncludeTax: boolean, exponent: number) {
  return {
    net: fixed(net, exponent), tax: fixed(tax, exponent), gross: fixed(gross, exponent),
    amount: fixed(pricesIncludeTax ? gross : net, exponent),
  }
}

const lineVat = (vat: { treatment: VatTreatment; rate: string; reasonCode: VatReasonCode | null; country: string | null }): DocumentViewLineVat =>
  ({ treatment: vat.treatment, rate: vat.rate, reasonCode: vat.reasonCode, country: vat.country })

/** The classification of a line that did not calculate, as far as it can be read without guessing. */
function enteredVat(line: DraftViewLineInput, taxRate: string | number): DocumentViewLineVat | null {
  try {
    return lineVat(documentVat({ description: line.description, quantity: 1, unitPrice: 0, ...(line.vat ? { vat: line.vat } : {}) }, taxRate))
  } catch {
    return line.vat?.rate !== undefined
      ? { treatment: line.vat.treatment, rate: line.vat.rate, reasonCode: line.vat.reasonCode ?? null, country: line.vat.country ?? null }
      : null
  }
}

type Calculated = {
  lines: Array<{ vat: DocumentViewLineVat & { reasonCode: VatReasonCode | null }; net: string; tax: string; gross: string }>
  vatGroups: DocumentViewVatGroup[]
  totals: NonNullable<DocumentView["totals"]>
}

function calculate(input: DraftViewInput, frozen: Array<FrozenAmounts | null | undefined>, exponent: number): Calculated | null {
  if (frozen.some((entry) => entry === null)) return null
  const frozenLines = frozen.filter((entry): entry is FrozenAmounts => entry !== undefined && entry !== null)
  const editable = input.lines.filter((line) => !line.frozen)
  const preview = previewDraft({
    items: editable.map((line) => ({ description: line.description, quantity: line.quantity, unitPrice: line.unitPrice, ...(line.vat ? { vat: line.vat } : {}) })),
    taxRate: input.taxRate, currency: input.currency, pricesIncludeTax: input.pricesIncludeTax,
    ...(input.vatEvidence ? { vatEvidence: input.vatEvidence } : {}),
  })
  const result = preview.result
  if (!result) return null

  // The engine refuses to mix out-of-scope with other treatments among the lines it prices; the frozen lines count too.
  const treatments = [...result.lines.map((line) => line.vat.treatment), ...frozenLines.map((line) => line.vat.treatment)]
  if (treatments.includes("out_of_scope") && treatments.some((treatment) => treatment !== "out_of_scope")) return null

  const groups = new Map<string, GroupSums>()
  for (const group of result.groups) {
    groups.set(group.key, {
      treatment: group.treatment, rate: group.rate, reasonCode: group.reasonCode, country: group.country,
      net: new D(group.net), tax: new D(group.tax), gross: new D(group.gross), payableRounding: new D(group.payableRounding),
    })
  }
  for (const line of frozenLines) {
    const key = vatGroupKey(line.vat)
    const group = groups.get(key) ?? {
      treatment: line.vat.treatment, rate: new D(line.vat.rate).toFixed(), reasonCode: line.vat.reasonCode, country: line.vat.country,
      net: new D(0), tax: new D(0), gross: new D(0), payableRounding: new D(0),
    }
    group.net = group.net.plus(line.net)
    group.tax = group.tax.plus(line.tax)
    group.gross = group.gross.plus(line.gross)
    // A frozen line's own residual: what its gross holds beyond its net and tax.
    group.payableRounding = group.payableRounding.plus(line.gross.minus(line.net).minus(line.tax))
    groups.set(key, group)
  }
  const vatGroups: DocumentViewVatGroup[] = [...groups].map(([key, group]) => ({
    key, treatment: group.treatment, rate: group.rate, reasonCode: group.reasonCode, country: group.country,
    net: fixed(group.net, exponent), tax: fixed(group.tax, exponent), gross: fixed(group.gross, exponent),
    payableRounding: fixed(group.payableRounding, exponent),
  })).sort(byKey)

  const all = [...groups.values()]
  const net = sum(all.map((group) => group.net)), tax = sum(all.map((group) => group.tax))
  const gross = sum(all.map((group) => group.gross)), payableRounding = sum(all.map((group) => group.payableRounding))
  if (!net.plus(tax).plus(payableRounding).eq(gross)) return null
  const payable = gross.minus(result.depositApplicationsGross)
  return {
    lines: result.lines.map((line) => ({ vat: line.vat, net: line.net, tax: line.tax, gross: line.gross })),
    vatGroups,
    totals: { net: fixed(net, exponent), tax: fixed(tax, exponent), gross: fixed(gross, exponent), payableRounding: fixed(payableRounding, exponent), payable: fixed(payable, exponent) },
  }
}

// ---------------------------------------------------------------------------------------------
// Issued documents
// ---------------------------------------------------------------------------------------------

/**
 * The part of the issued money snapshot the view reads (`invoiceIssuedSchema`, `creditNoteIssuedSchema`
 * and `invoiceMoneySnapshot` all satisfy it). It is structural because shared cannot import from the
 * app; the app proves its types are assignable.
 */
export type IssuedMoneySnapshot = {
  number: string
  issueDate: string
  supplyDate?: string | null
  /** A credit note has none. */
  dueDate?: string
  currency: string
  exponent: 0 | 1 | 2
  lines: ReadonlyArray<{
    lineId: string
    description: string
    quantityInput: string
    unitPriceInput: string
    net: string
    tax: string
    gross: string
    vat: { treatment: VatTreatment; rate: string; reasonCode: VatReasonCode | null; country: string | null }
  }>
  vatGroups: ReadonlyArray<{
    key: string
    treatment: VatTreatment
    rate: string
    reasonCode: VatReasonCode | null
    country: string | null
    net: string
    tax: string
    gross: string
    payableRounding: string
    evidence?: VatEvidence | undefined
  }>
  totals: { net: string; tax: string; gross: string; payableRounding: string }
  calculation: { version: "v2" | "legacy_per_line"; pricesIncludeTax: boolean }
  seller: SellerSnapshot
  buyer: BuyerSnapshot
}

export type IssuedViewExtras = {
  kind: DocumentKind
  status: string
  locale: string
  timezone: string
  logoUrl?: string | null
  contactId?: string | null
  notes?: string | null
  /** Defaults to the evidence the VAT groups agree on; null when they do not agree. */
  vatEvidence?: VatEvidence | null
  paymentReference?: string | null
  expiryDate?: string | null
}

/**
 * The view of an issued document. Every amount is copied from the frozen snapshot: nothing is
 * calculated or repriced, so the view says what was issued whatever today's rules would give.
 */
export function buildIssuedView(snapshot: IssuedMoneySnapshot, extras: IssuedViewExtras): DocumentView {
  const { pricesIncludeTax } = snapshot.calculation
  const lines: DocumentViewLine[] = snapshot.lines.map((line) => ({
    key: line.lineId, id: line.lineId, description: line.description,
    quantity: line.quantityInput, unitPrice: line.unitPriceInput,
    vat: lineVat(line.vat),
    net: line.net, tax: line.tax, gross: line.gross, amount: pricesIncludeTax ? line.gross : line.net,
    locked: true,
  }))
  const reference = extras.paymentReference?.trim() || snapshot.number
  return {
    kind: extras.kind, state: "issued", status: extras.status,
    number: { value: snapshot.number, preview: null },
    locale: extras.locale, timezone: extras.timezone, currency: snapshot.currency, exponent: snapshot.exponent, pricesIncludeTax,
    seller: sellerView(snapshot.seller, extras.logoUrl), buyer: buyerView(snapshot.buyer, extras.contactId),
    dates: {
      issueDate: calendarDate(snapshot.issueDate), supplyDate: calendarDate(snapshot.supplyDate),
      dueDate: calendarDate(snapshot.dueDate), expiryDate: calendarDate(extras.expiryDate),
    },
    lines,
    vatGroups: snapshot.vatGroups.map((group) => ({
      key: group.key, treatment: group.treatment, rate: group.rate, reasonCode: group.reasonCode, country: group.country,
      net: group.net, tax: group.tax, gross: group.gross, payableRounding: group.payableRounding,
    })),
    // Issued documents have no deposit applications, so what is payable is the gross as issued.
    totals: { ...pick(snapshot.totals), payable: snapshot.totals.gross },
    vatEvidence: extras.vatEvidence !== undefined ? extras.vatEvidence : agreedEvidence(snapshot.vatGroups),
    notes: notesView(extras.notes),
    paymentDetails: paymentDetailsView(snapshot.seller, reference, extras.kind),
    calculation: { version: snapshot.calculation.version, staleLegacy: false },
  }
}

const pick = ({ net, tax, gross, payableRounding }: IssuedMoneySnapshot["totals"]) => ({ net, tax, gross, payableRounding })

/** The pricing engine attaches the document's evidence to every group it covers; groups that differ have no single answer. */
function agreedEvidence(groups: IssuedMoneySnapshot["vatGroups"]): VatEvidence | null {
  const evidence = groups.flatMap((group) => group.evidence ? [group.evidence] : [])
  const first = evidence[0]
  if (!first || evidence.some((item) => JSON.stringify(item) !== JSON.stringify(first))) return null
  return first
}
